import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequest, ChatEngineError } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { parseStoryResponse } from "./story-parser";
import { STORY_PARSER_VERSION } from "./story-parser";
import {
  loadStoryMessages,
  normalizeStoryCharacterIds,
  replaceStoryMessages,
  type StoryMessage,
} from "./story-storage";
import type { Character } from "./character-types";
import type { ChatMessage } from "./chat-storage";
import { MacroEngine } from "./macro-engine";

const DEFAULT_STORY_FOLD_TAGS = "think,thinking,summary";
const DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS = "think,thinking";

/** 解析本段剧情挂载的角色（首项 = 主角色）；有角色卡缺失时直接抛错 */
function loadStoryCast(characterIdsInput: string | string[]): Character[] {
  const ids = normalizeStoryCharacterIds(characterIdsInput);
  if (ids.length === 0) {
    throw new ChatEngineError("No character selected for this story session.");
  }
  const all = loadCharacters();
  const cast: Character[] = [];
  for (const id of ids) {
    const character = all.find((item) => item.id === id);
    if (!character) {
      throw new ChatEngineError(`Character not found: ${id}`);
    }
    cast.push(character);
  }
  return cast;
}

/** 多角色共演时注入给模型的说明块；单角色剧情不产生任何内容 */
function buildStoryCastBlock(cast: Character[]): string {
  if (cast.length <= 1) return "";
  const [primary, ...others] = cast;
  const lines: string[] = [
    `【同场角色】本段剧情由多张角色卡共同出演。除主角色「${primary.name}」外，下面这些角色同样在场，同样由你来扮演：`,
  ];
  for (const member of others) {
    const personality = member.personality?.trim();
    lines.push(
      `\n■ ${member.name}${personality ? `（性格：${personality}）` : ""}\n${member.persona?.trim() || "（该角色暂无详细设定，按名字与性格把握）"}`
    );
  }
  const speakerExample = others[0]?.name ?? "角色";
  lines.push(
    `\n【共演规则】\n1. 所有角色都在同一条剧情线里，一起推进同一个场景，不要拆成各自独立的故事；\n2. 每个角色的言行必须符合各自人设，不得混用口吻、性格或称呼；\n3. 角色说话时用「名字：」标注说话人，例如 ${speakerExample}：……；旁白、动作与场景描写用普通叙述，不加名字前缀；\n4. 角色之间可以直接对话、互动、各自行动，但都要服务于当前情节；\n5. 不要在正文里复述或解释以上规则。`
  );
  return lines.join("\n");
}

/** 把共演说明插进系统提示区（第一条 system 之后），单角色时原样返回 */
function injectStoryCastBlock(messages: LLMMessage[], cast: Character[]): LLMMessage[] {
  const block = buildStoryCastBlock(cast);
  if (!block) return messages;
  const inserted: LLMMessage = { role: "system", content: block };
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) return [inserted, ...messages];
  return [...messages.slice(0, systemIndex + 1), inserted, ...messages.slice(systemIndex + 1)];
}

export type StoryGenerationResult = {
  rawText: string;
  renderedText: string;
  storySummary: string;
  regexSignature: string;
  parserVersion: number;
  promptMessages: LLMMessage[];
  model: string;
  presetName: string;
};

export type StoryPreviewResult = {
  messages: LLMMessage[];
  characterName: string;
  model: string;
  presetName: string;
};

function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripContextExcludedTags(text: string, excludedTags?: string): string {
  const tags = Array.from(new Set((excludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS).split(",").map(t => t.trim()).filter(Boolean)));
  if (tags.length === 0) return text;

  const tagAlternation = tags.map(escapeTagName).join("|");
  const rx = new RegExp(`<(${tagAlternation})>[\\s\\S]*?<\\/\\1>`, "gi");
  return text.replace(rx, "").replace(/\n{3,}/g, "\n\n").trim();
}

function toHistoryMessage(message: StoryMessage, contextExcludedTags?: string): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: stripContextExcludedTags(message.rawContent, contextExcludedTags),
    status: "sent",
    createdAt: message.createdAt,
  };
}

function resolveStoryConfigs(characterIdsInput: string | string[]): {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
  regexSignature: string;
  summaryTag: string;
} {
  const cast = loadStoryCast(characterIdsInput);
  // 主角色（首项）决定 API 绑定、预设与正则；其余角色只贡献人设与世界书
  const character = cast[0];

  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, character.id, "story");
  if (!activeSlot.apiConfigId) {
    throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> 绑定管理 -> 剧情 to assign one.`);
  }

  const apiConfig = loadApiConfigs().find((config) => config.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new ChatEngineError(`API Configuration not found for ${character.name}.`);
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find((item) => item.id === activeSlot.presetId) || null : null;
  if (!preset) {
    preset = presets.find((item) => item.builtIn) ?? null;
  }

  const allRegexes = loadRegexes();
  const charBinding = bindings.characterBindings.find((item) => item.characterId === character.id);
  const storyOverrideRegexIds = charBinding?.appOverrides.story?.regexIds;
  const regexIds = storyOverrideRegexIds && storyOverrideRegexIds.length > 0
    ? storyOverrideRegexIds
    : activeSlot.regexIds || [];
  const regexes = regexIds
    .map((id) => allRegexes.find((regex) => regex.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  // 世界书取整场剧情的并集：主角色用自己「剧情」绑定的世界书，其余同场角色各取自己的
  const worldBookIds: string[] = [];
  for (const member of cast) {
    // 配角可能没配「剧情」绑定，取不到就跳过，不能让它拖垮整次生成
    const slot = member.id === character.id ? activeSlot : resolveBinding(bindings, member.id, "story");
    const slotWorldBookIds = slot ? slot.worldBookIds || [] : [];
    for (const id of slotWorldBookIds) {
      if (!worldBookIds.includes(id)) worldBookIds.push(id);
    }
  }
  const worldBooks = worldBookIds
    .map((id) => allWorldBooks.find((worldBook) => worldBook.id === id))
    .filter(Boolean) as WorldBookConfig[];
  const summaryTag = preset?.story_summary_tag?.trim() || "summary";

  return {
    apiConfig,
    preset,
    regexes,
    worldBooks,
    regexSignature: [...regexes.map((regex) => `${regex.id}:${regex.updatedAt}`), `summary:${summaryTag}`].join("|"),
    summaryTag,
  };
}

export function getStoryRenderSignature(characterIds: string | string[]): { regexSignature: string; parserVersion: number; regexes: RegexConfig[] } {
  const { regexSignature, regexes } = resolveStoryConfigs(characterIds);
  return {
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    regexes,
  };
}

export async function generateStoryCompletion(
  characterIds: string | string[],
  history: StoryMessage[],
  options?: { sessionFoldTags?: string; sessionContextExcludedTags?: string; signal?: AbortSignal },
): Promise<StoryGenerationResult> {
  const cast = loadStoryCast(characterIds);
  const character = cast[0];

  const { apiConfig, preset, regexes, worldBooks, regexSignature, summaryTag } = resolveStoryConfigs(cast.map((item) => item.id));
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(cast, history, preset, regexes, worldBooks, effectiveContextExcludedTags);

  const userIdentity = resolveUserIdentity(character.id, "story");
  const macroEngine = new MacroEngine(character.name, userIdentity?.name ?? "用户");

  const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
    characterName: character.name,
  }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal });

  const parsed = parseStoryResponse(rawOutput, regexes, {
    summaryTag,
    foldTags: effectiveFoldTags,
    macroEngine,
    activeTags: ["story"],
  });
  return {
    rawText: parsed.rawText,
    renderedText: parsed.renderedText,
    storySummary: parsed.summaryText,
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    promptMessages: llmMessages,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

async function buildStoryPromptMessages(
  cast: Character[],
  history: StoryMessage[],
  preset: PresetConfig | null,
  regexes: RegexConfig[],
  worldBooks: WorldBookConfig[],
  contextExcludedTags: string = DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS,
): Promise<LLMMessage[]> {
  const character = cast[0];
  if (!character) {
    throw new ChatEngineError("No character selected for this story session.");
  }

  const userIdentity = resolveUserIdentity(character.id, "story");
  const historyMessages = history.map((message) => toHistoryMessage(message, contextExcludedTags));
  const memConfig = loadMemoryConfig();
  // 多角色共用一条剧情线：短期上下文与长期记忆都挂在主角色身上，
  // 同场角色的人设随共演说明块注入，不额外拆记忆库
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(character.id, "story", {
    userName: userIdentity?.name ?? "用户",
    history: historyMessages,
  });

  // 把同场角色名字并入世界书激活上下文：挂在配角身上的关键词条目也能触发
  const castActivationContext = [
    wbActivationContext,
    cast.length > 1 ? cast.map((member) => member.name).join(" ") : "",
  ].filter(Boolean).join("\n");

  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(character.id, castActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(character.id, memConfig).catch(() => null),
  ]);

  const now = new Date();

  const messages = assemblePromptPayload({
    character,
    history: truncatedHistory,
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "story",
    scheduleSummary: buildCalendarScheduleMarker("character", character.id, getWeekStartIso(now)),
    currentSchedule: getCurrentCalendarScheduleForPrompt("character", character.id, now),
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: castActivationContext,
    recentBlocks,
    unifiedRecentItems,
  });

  return injectStoryCastBlock(messages, cast);
}

export async function previewStoryPromptPayload(
  characterIds: string | string[],
  history: StoryMessage[],
  options?: { sessionContextExcludedTags?: string },
): Promise<StoryPreviewResult> {
  const cast = loadStoryCast(characterIds);
  const { apiConfig, preset, regexes, worldBooks } = resolveStoryConfigs(cast.map((item) => item.id));
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(cast, history, preset, regexes, worldBooks, effectiveContextExcludedTags);
  return {
    messages: previewMessagesForApi(apiConfig, preset, llmMessages),
    characterName: cast.map((item) => item.name).join("、"),
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

export function rebuildStorySessionRenderCache(characterIds: string | string[], sessionId: string, options?: { sessionFoldTags?: string }): StoryMessage[] {
  const { regexSignature, parserVersion } = getStoryRenderSignature(characterIds);
  const { regexes, summaryTag } = resolveStoryConfigs(characterIds);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;

  const primaryCharacterId = normalizeStoryCharacterIds(characterIds)[0] ?? "";
  const character = loadCharacters().find((c) => c.id === primaryCharacterId);
  const userIdentity = resolveUserIdentity(primaryCharacterId, "story");
  const macroEngine = new MacroEngine(character?.name ?? "", userIdentity?.name ?? "用户");

  const rebuilt = loadStoryMessages(sessionId).map((message) => {
    if (message.role !== "assistant") {
      return {
        ...message,
        renderedContent: message.renderedContent || message.rawContent,
        regexSignature,
        parserVersion,
      };
    }
    const parsed = parseStoryResponse(message.rawContent, regexes, {
      summaryTag,
      foldTags: effectiveFoldTags,
      macroEngine,
      activeTags: ["story"],
    });
    return {
      ...message,
      renderedContent: parsed.renderedText,
      storySummary: parsed.summaryText || message.storySummary,
      regexSignature,
      parserVersion,
    };
  });
  replaceStoryMessages(sessionId, rebuilt);
  return rebuilt;
}
