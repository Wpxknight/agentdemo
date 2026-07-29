import type { SessionStats, SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { RequestContext } from '../auth/types.js';
import type { AgentRunUsage, SessionContextUsage, SessionTokenUsage, Store } from '../db/store.js';
import type { JsonValue, Msg, ToolContentBlock } from '../model/types.js';
import type { PiSessionStore } from '@aiop/pi-runtime';

export interface ProjectPiSessionInput {
  ctx: RequestContext;
  sessionId: string;
  entries: readonly SessionTreeEntry[];
  committedLeafId: string | null;
  assistantDurationMs?: Readonly<Record<string, number>>;
}

/** Rebuilds the legacy product message view from the committed Pi session path. */
export class PiSessionProjection {
  constructor(private readonly store: Pick<Store, 'replaceMessages' | 'touchSession'>) {}

  async project(input: ProjectPiSessionInput): Promise<void> {
    const messages = committedPath(input.entries, input.committedLeafId)
      .flatMap((entry) => projectEntry(entry, input.assistantDurationMs?.[entry.id]));
    await this.store.replaceMessages(input.ctx, input.sessionId, messages);
    await this.store.touchSession(input.ctx, input.sessionId, { updatedAt: new Date() });
  }
}

export async function projectCommittedPiSession(input: {
  store: Pick<Store, 'replaceMessages' | 'touchSession'>;
  sessions: Pick<PiSessionStore, 'get' | 'listEntries'>;
  ctx: RequestContext;
  sessionId: string;
  durationMs?: number;
}): Promise<boolean> {
  const session = await input.sessions.get(input.ctx.tenantId, input.sessionId);
  if (!session?.committedLeafId) return false;
  const records = await input.sessions.listEntries(input.ctx.tenantId, input.sessionId, { committedOnly: true });
  const entries = records.map((record) => record.entry);
  const finalAssistant = entries.findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');
  await new PiSessionProjection(input.store).project({
    ctx: input.ctx,
    sessionId: input.sessionId,
    entries,
    committedLeafId: session.committedLeafId,
    ...(finalAssistant && Number.isFinite(input.durationMs) && input.durationMs! >= 0
      ? { assistantDurationMs: { [finalAssistant.id]: input.durationMs! } }
      : {}),
  });
  return true;
}

export function projectPiUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total?: number };
}): AgentRunUsage {
  const costUsd = finite(usage.cost?.total);
  return {
    inputTokens: finite(usage.input) ?? 0,
    outputTokens: finite(usage.output) ?? 0,
    cacheReadTokens: finite(usage.cacheRead) ?? 0,
    cacheCreationTokens: finite(usage.cacheWrite) ?? 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

export function projectPiSessionStats(
  stats: SessionStats,
  maxTokens: number,
): { context: SessionContextUsage; usage: SessionTokenUsage; costUsd: number } {
  return {
    context: {
      usedTokens: Math.max(0, finite(stats.cachedTokens) ?? 0) + Math.max(0, finite(stats.uncachedTokens) ?? 0),
      maxTokens: Math.max(0, finite(maxTokens) ?? 0),
      estimated: false,
    },
    usage: { totalTokens: Math.max(0, finite(stats.totalTokens) ?? 0) },
    costUsd: Math.max(0, finite(stats.costTotal) ?? 0),
  };
}

function committedPath(entries: readonly SessionTreeEntry[], leafId: string | null): SessionTreeEntry[] {
  if (!leafId) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionTreeEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Pi session projection cycle at entry ${cursor}`);
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) throw new Error(`Committed Pi entry not found: ${cursor}`);
    path.push(entry);
    cursor = entry.parentId;
  }
  return path.reverse();
}

function projectEntry(entry: SessionTreeEntry, durationMs?: number): Msg[] {
  if (entry.type === 'message') {
    const message = projectMessage(entry.message, durationMs);
    return message ? [message] : [];
  }
  if (entry.type === 'compaction') {
    return [{ role: 'user', text: `【历史对话摘要（自动压缩，供参考）】\n${entry.summary}` }];
  }
  if (entry.type === 'branch_summary') {
    return [{ role: 'user', text: `【历史分支摘要（供参考）】\n${entry.summary}` }];
  }
  if (entry.type === 'custom_message' && entry.display) {
    const blocks = typeof entry.content === 'string'
      ? [{ type: 'text' as const, text: entry.content }]
      : entry.content.map(projectContentBlock);
    return [{ role: 'user', text: textOf(blocks), contentBlocks: blocks }];
  }
  return [];
}

function projectMessage(message: Extract<SessionTreeEntry, { type: 'message' }>['message'], durationMs?: number): Msg | undefined {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return { role: 'user', text: message.content };
    const blocks = message.content.map(projectContentBlock);
    return { role: 'user', text: textOf(blocks), contentBlocks: blocks };
  }
  if (message.role === 'assistant') {
    const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const thinking = message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('');
    const thinkingBlocks = message.content.flatMap((block) => block.type === 'thinking' && block.thinkingSignature
      ? [{ thinking: block.thinking, signature: block.thinkingSignature }]
      : []);
    const toolCalls = message.content.flatMap((block) => block.type === 'toolCall'
      ? [{ id: block.id, name: block.name, args: block.arguments as JsonValue }]
      : []);
    return {
      role: 'assistant',
      ...(text ? { text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(thinkingBlocks.length ? { thinkingBlocks } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(Number.isFinite(durationMs) && durationMs! >= 0 ? { durationMs } : {}),
    };
  }
  if (message.role === 'toolResult') {
    const blocks = message.content.map(projectContentBlock);
    return {
      role: 'tool',
      toolResults: [{
        id: message.toolCallId,
        content: textOf(blocks),
        contentBlocks: blocks,
        isError: message.isError,
      }],
    };
  }
  if (message.role === 'custom' && message.display) {
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content.map(projectContentBlock);
    return { role: 'user', text: textOf(blocks), contentBlocks: blocks };
  }
  if (message.role === 'compactionSummary') {
    return { role: 'user', text: `【历史对话摘要（自动压缩，供参考）】\n${message.summary}` };
  }
  if (message.role === 'branchSummary') {
    return { role: 'user', text: `【历史分支摘要（供参考）】\n${message.summary}` };
  }
  return undefined;
}

function projectContentBlock(block: { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }): ToolContentBlock {
  return block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image', mimeType: block.mimeType, data: block.data };
}

function textOf(blocks: readonly ToolContentBlock[]): string {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
