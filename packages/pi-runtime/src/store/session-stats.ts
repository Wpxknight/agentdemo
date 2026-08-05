import type { SessionStats, SessionTreeEntry } from '@earendil-works/pi-agent-core';

export function sessionStats(entries: readonly SessionTreeEntry[]): SessionStats {
  let messageCount = 0;
  let cachedTokens = 0;
  let uncachedTokens = 0;
  let totalTokens = 0;
  let costTotal = 0;
  for (const entry of entries) {
    if (entry.type === 'message') messageCount += 1;
    const usage = entry.type === 'message'
      ? entry.message.role === 'assistant' ? entry.message.usage : undefined
      : entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.usage : undefined;
    if (!usage) continue;
    cachedTokens += finite(usage.cacheRead);
    uncachedTokens += finite(usage.input) + finite(usage.cacheWrite);
    totalTokens += finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite);
    costTotal += finite(usage.cost?.total);
  }
  return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
