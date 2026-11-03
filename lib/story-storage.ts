import Dexie from "dexie";
import { formatChatTimestamp } from "./llm-prompt-assembler";

export type StoryUiPrefs = {
  hideBubble?: boolean;
  hideAvatar?: boolean;
  hideTimestamp?: boolean;
  theme?: string;
};

export type StorySession = {
  id: string;
  characterId: string;
  /** 多角色剧情：本段剧情同时挂载的角色；characterId 恒为首项（主角色，决定 API/预设/记忆归属） */
  characterIds?: string[];
  title?: string;
  updatedAt: string;
  customCSS?: string;
  foldTags?: string;            // Comma-separated tag names to fold for this session.
  contextExcludedTags?: string; // Comma-separated tag names stripped before sending story history to the LLM.
  uiPrefs?: StoryUiPrefs;
  lastMessageId?: string;
  lastMessagePreview?: string;
};

export type StoryMessageRole = "user" | "assistant" | "system";

export type StoryMessage = {
  id: string;
  sessionId: string;
  role: StoryMessageRole;
  rawContent: string;
  renderedContent?: string;
  storySummary?: string;
  regexSignature?: string;
  parserVersion?: number;
  createdAt: string;
};

export type StoryProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
};

class StoryDatabase extends Dexie {
  sessions!: Dexie.Table<StorySession, string>;
  messages!: Dexie.Table<StoryMessage, string>;

  constructor() {
    super("AiPhoneStoryDB");
    this.version(1).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, createdAt",
    });
  }
}

const storyDb = new StoryDatabase();

let _hydrated = false;
let _sessionsCache: StorySession[] = [];
let _messagesCache: StoryMessage[] = [];

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getStorySessionActivityTime(session: StorySession): number {
  const lastMessageTime = _messagesCache
    .filter((message) => message.sessionId === session.id)
    .reduce((latest, message) => Math.max(latest, parseTime(message.createdAt)), 0);
  return Math.max(lastMessageTime, parseTime(session.updatedAt));
}

function isPreferredStorySession(candidate: StorySession, current: StorySession): boolean {
  const candidateTime = getStorySessionActivityTime(candidate);
  const currentTime = getStorySessionActivityTime(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const candidateUpdated = parseTime(candidate.updatedAt);
  const currentUpdated = parseTime(current.updatedAt);
  if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;
  return candidate.id.localeCompare(current.id) > 0;
}

/** 多角色剧情：把角色选择归一化成去重后的 id 数组（首项 = 主角色） */
export function normalizeStoryCharacterIds(input: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(input) ? input : input ? [input] : [];
  const ids: string[] = [];
  for (const value of raw) {
    const id = typeof value === "string" ? value.trim() : "";
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 会话挂载的角色集合（兼容只有 characterId 的存量会话） */
export function resolveStorySessionCharacterIds(
  session: Pick<StorySession, "characterId" | "characterIds">
): string[] {
  const stored = normalizeStoryCharacterIds(session.characterIds);
  return stored.length > 0 ? stored : normalizeStoryCharacterIds(session.characterId);
}

/** 角色集合签名：与顺序无关，用来判断两个会话是不是"同一段剧情" */
export function storyCharacterSelectionKey(input: string | string[]): string {
  return normalizeStoryCharacterIds(input).sort().join("|");
}

function normalizeStorySessions(sessions: StorySession[]): { items: StorySession[]; changed: boolean } {
  const normalized: StorySession[] = [];
  const indexBySelection = new Map<string, number>();
  let changed = false;

  for (const session of sessions) {
    const id = session.id?.trim();
    const characterIds = resolveStorySessionCharacterIds(session);
    if (!id || characterIds.length === 0) {
      changed = true;
      continue;
    }
    const primaryId = characterIds[0];
    // 单角色会话不落 characterIds 字段，存量数据保持原样（零迁移噪音）
    const storedIds = characterIds.length > 1 ? characterIds : undefined;
    const idsDiffer = (session.characterIds?.length ?? 0) !== (storedIds?.length ?? 0)
      || (storedIds ? storedIds.some((value, index) => session.characterIds?.[index] !== value) : false);
    const item = id !== session.id || primaryId !== session.characterId || idsDiffer
      ? { ...session, id, characterId: primaryId, characterIds: storedIds }
      : session;

    const selectionKey = storyCharacterSelectionKey(characterIds);
    const existingIndex = indexBySelection.get(selectionKey);
    if (existingIndex === undefined) {
      indexBySelection.set(selectionKey, normalized.length);
      normalized.push(item);
      if (item !== session) changed = true;
      continue;
    }

    changed = true;
    if (isPreferredStorySession(item, normalized[existingIndex])) {
      normalized[existingIndex] = item;
    }
  }

  return { items: normalized, changed };
}

function persistStorySessionsSnapshot(sessions: StorySession[]): void {
  storyDb.transaction("rw", storyDb.sessions, async () => {
    await storyDb.sessions.clear();
    await storyDb.sessions.bulkPut(sessions);
  }).catch(() => undefined);
}

export async function hydrateStoryStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return;
  const [sessions, messages] = await Promise.all([
    storyDb.sessions.toArray().catch(() => []),
    storyDb.messages.toArray().catch(() => []),
  ]);
  _messagesCache = messages;
  const normalized = normalizeStorySessions(sessions);
  _sessionsCache = normalized.items;
  if (normalized.changed) persistStorySessionsSnapshot(normalized.items);
  _hydrated = true;
}

export function loadStorySessions(): StorySession[] {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) _sessionsCache = normalized.items;
  // 空值安全：旧版本/异常导入的数据可能缺 updatedAt，排序不能让页面崩溃
  return [..._sessionsCache].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function loadStoryMessages(sessionId: string): StoryMessage[] {
  return _messagesCache
    .filter((message) => message.sessionId === sessionId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

export function createOrGetStorySession(characterIdsInput: string | string[]): StorySession {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistStorySessionsSnapshot(normalized.items);
  }
  const characterIds = normalizeStoryCharacterIds(characterIdsInput);
  if (characterIds.length === 0) {
    throw new Error("createOrGetStorySession: characterIds is empty");
  }
  const selectionKey = storyCharacterSelectionKey(characterIds);
  const existing = _sessionsCache.find((session) => (
    storyCharacterSelectionKey(resolveStorySessionCharacterIds(session)) === selectionKey
  ));
  if (existing) return existing;

  const session: StorySession = {
    id: generateId("story_sess"),
    characterId: characterIds[0],
    // 只有多角色剧情才落 characterIds，单角色会话与旧数据保持一致
    ...(characterIds.length > 1 ? { characterIds: [...characterIds] } : {}),
    updatedAt: new Date().toISOString(),
    uiPrefs: {},
  };
  _sessionsCache.unshift(session);
  storyDb.sessions.put(session).catch(() => undefined);
  return session;
}

export function updateStorySession(sessionId: string, updates: Partial<StorySession>): StorySession | null {
  const idx = _sessionsCache.findIndex((session) => session.id === sessionId);
  if (idx === -1) return null;
  const next: StorySession = {
    ..._sessionsCache[idx],
    ...updates,
    uiPrefs: { ..._sessionsCache[idx].uiPrefs, ...updates.uiPrefs },
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  _sessionsCache[idx] = next;
  storyDb.sessions.put(next).catch(() => undefined);
  return next;
}

/**
 * 就地改写某段剧情的角色阵容（历史消息保留）。
 * 首项为主角色，决定 API 绑定 / 预设 / 记忆归属。
 */
export function updateStorySessionCharacters(
  sessionId: string,
  characterIdsInput: string | string[]
): StorySession | null {
  const characterIds = normalizeStoryCharacterIds(characterIdsInput);
  if (characterIds.length === 0) return null;
  return updateStorySession(sessionId, {
    characterId: characterIds[0],
    characterIds: characterIds.length > 1 ? characterIds : undefined,
  });
}

export function pushStoryMessage(
  input: Omit<StoryMessage, "id" | "createdAt">
): StoryMessage {
  const message: StoryMessage = {
    ...input,
    id: generateId("story_msg"),
    createdAt: new Date().toISOString(),
  };
  _messagesCache.push(message);
  storyDb.messages.put(message).catch(() => undefined);

  const previewSource = message.renderedContent || message.rawContent;
  const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 64);
  updateStorySession(message.sessionId, {
    lastMessageId: message.id,
    lastMessagePreview: preview,
    updatedAt: message.createdAt,
  });

  return message;
}

/** Delete a single story message */
export function deleteStoryMessage(messageId: string): void {
    _messagesCache = _messagesCache.filter(m => m.id !== messageId);
    storyDb.messages.delete(messageId).catch(() => undefined);
}

/** Delete a message and all messages after it (by createdAt in same session) */
export function deleteStoryMessagesFrom(sessionId: string, messageId: string): void {
    const msg = _messagesCache.find(m => m.id === messageId);
    if (!msg) return;
    const idsToDelete = _messagesCache
        .filter(m => m.sessionId === sessionId && m.createdAt >= msg.createdAt)
        .map(m => m.id);
    _messagesCache = _messagesCache.filter(m => !idsToDelete.includes(m.id));
    storyDb.messages.bulkDelete(idsToDelete).catch(() => undefined);
}

/** Edit a story message's rawContent (renderedContent will be rebuilt by cache invalidation) */
export function editStoryMessage(messageId: string, newRawContent: string): void {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    _messagesCache[idx] = {
        ..._messagesCache[idx],
        rawContent: newRawContent,
        renderedContent: undefined,
        regexSignature: undefined,
        parserVersion: undefined,
    };
    storyDb.messages.put(_messagesCache[idx]).catch(() => undefined);
}

export function replaceStoryMessages(sessionId: string, messages: StoryMessage[]): void {
  _messagesCache = _messagesCache.filter((message) => message.sessionId !== sessionId);
  _messagesCache.push(...messages);
  storyDb.messages.where("sessionId").equals(sessionId).delete()
    .then(() => storyDb.messages.bulkPut(messages))
    .catch(() => undefined);
}

function compactProjectionText(text: string, maxLen = 160): string {
  const plain = text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}...` : plain;
}

export function loadStoryProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string; userName?: string; charName?: string }
): StoryProjectionEntry[] {
  // 同一角色可能同时存在于多段剧情里（单角色剧本 + 多角色共演剧本）。
  // 优先取"只挂了这个角色"的那段，没有则取包含该角色且最近活跃的那段。
  const candidates = _sessionsCache.filter((item) => resolveStorySessionCharacterIds(item).includes(characterId));
  if (candidates.length === 0) return [];
  const soloSession = candidates.find((item) => resolveStorySessionCharacterIds(item).length === 1);
  const session = soloSession
    ?? candidates.reduce((latest, item) => (isPreferredStorySession(item, latest) ? item : latest), candidates[0]);
  const messages = loadStoryMessages(session.id);
  const projections: StoryProjectionEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (current.role !== "assistant") continue;
    if (options?.afterTimestamp && current.createdAt <= options.afterTimestamp) continue;

    if (!current.storySummary) continue;
    const summaryText = compactProjectionText(current.storySummary, 500);
    if (!summaryText) continue;

    const ts = formatChatTimestamp(current.createdAt);
    projections.push({
      id: `story_projection_${current.id}`,
      timestamp: current.createdAt,
      content: `[事件 ${ts}] ${summaryText}`,
    });
  }

  return projections;
}
