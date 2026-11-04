// lib/story-cast-memory.ts
// 多角色剧情：把同一段剧情的摘要落到每个同场角色的长期记忆里。
// 关键约束：不额外发起任何 LLM 调用——摘要直接取自剧情生成那一次的输出。

import { deleteMemoryEntries, loadMemoryConfig, loadMemoryEntries, saveMemoryEntry } from "./memory-storage";
import type { MemoryEntry } from "./memory-types";

const MAX_MEMORY_CONTENT_LENGTH = 600;

/** 记忆正文做去标签 + 压空白 + 截断，避免把 HTML 模具塞进记忆库 */
export function compactStoryMemoryText(text: string): string {
    const plain = text
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!plain) return "";
    if (plain.length <= MAX_MEMORY_CONTENT_LENGTH) return plain;
    return `${plain.slice(0, MAX_MEMORY_CONTENT_LENGTH)}...`;
}

/**
 * 把一段多角色剧情的摘要写入同场每个角色（主角色以外）的长期记忆。
 *
 * - 主角色：仍走原有的「事件计数 + 定时总结」管线（与改动前一致）
 * - 其他同场角色：直接把本次摘要入库，0 次 LLM 调用、不触发核心记忆重建
 * - 不做 embedding（向量化本身是一次 API 调用），条目靠关键词/时间参与召回
 *
 * @returns 实际写入的角色数
 */
export async function recordStoryCastMemories(params: {
    characterIds: string[];
    primaryCharacterId: string;
    /** 剧情生成时模型产出的 summary 段 */
    summaryText?: string;
    /** summary 为空时的兜底正文（渲染后的剧情正文） */
    fallbackText?: string;
    sessionId?: string;
    createdAt?: string;
}): Promise<number> {
    const config = loadMemoryConfig();
    // 用户关掉了自动总结，就不偷偷写记忆
    if (!config.autoSummarizeEnabled) return 0;

    const others = params.characterIds.filter((id) => id && id !== params.primaryCharacterId);
    if (others.length === 0) return 0;

    const content = compactStoryMemoryText(params.summaryText || "") || compactStoryMemoryText(params.fallbackText || "");
    if (!content) return 0;

    const createdAt = params.createdAt || new Date().toISOString();
    let saved = 0;

    for (const characterId of others) {
        const entry: MemoryEntry = {
            id: `mem_lt_story_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: "story",
            type: "long_term",
            content,
            importance: 0.8,
            createdAt,
            updatedAt: createdAt,
            metadata: {
                fromStoryCast: true,
                sessionId: params.sessionId,
                primaryCharacterId: params.primaryCharacterId,
            },
        };

        try {
            await saveMemoryEntry(entry);
            saved += 1;
        } catch (err) {
            console.warn("[StoryCastMemory] save failed:", characterId, err);
            continue;
        }

        // 和摘要管线一样执行长期记忆上限裁剪
        try {
            const all = await loadMemoryEntries(characterId);
            if (all.length > config.maxLongTermEntries) {
                const excess = all.slice(0, all.length - config.maxLongTermEntries);
                await deleteMemoryEntries(excess.map((item) => item.id));
            }
        } catch {
            /* 裁剪失败不影响已写入的记忆 */
        }
    }

    return saved;
}
