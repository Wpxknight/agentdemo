import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';

export function committedInboxIds(entries: readonly SessionTreeEntry[]): Set<string> {
  return new Set(entries.filter((entry): entry is Extract<SessionTreeEntry, { type: 'custom' }> => entry.type === 'custom')
    .filter((entry) => entry.customType === 'aiop.inbox_consumed').map((entry) => entry.data)
    .filter((data): data is { inboxMessageId: string } =>
      Boolean(data && typeof data === 'object' && typeof (data as { inboxMessageId?: unknown }).inboxMessageId === 'string'))
    .map((data) => data.inboxMessageId));
}
