import type { AgentInputMessage } from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import { committedInboxIds } from './recovery.js';
import type { DurableRunStore } from '../store/types.js';

export interface InboxCapableSession {
  steer(message: AgentInputMessage): Promise<void>;
  followUp(message: AgentInputMessage): Promise<void>;
  appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}

export async function drainDurableInbox(input: {
  store: DurableRunStore; session: InboxCapableSession; entries: readonly SessionTreeEntry[];
  tenantId: string; runId: string; workerId: string; fencingToken: bigint; now: () => Date; claimTtlMs: number;
}): Promise<void> {
  const reconciled = committedInboxIds(input.entries);
  while (true) {
    const now = input.now();
    const item = await input.store.inbox.claimNext({ ...input, now, claimTtlMs: input.claimTtlMs });
    if (!item) return;
    if (!reconciled.has(item.id)) {
      if (item.mode === 'steer') await input.session.steer(item.message);
      else await input.session.followUp(item.message);
      await input.session.appendCustomEntry('aiop.inbox_consumed', { inboxMessageId: item.id, idempotencyKey: item.idempotencyKey });
    }
    await input.store.inbox.markConsumed({
      ...input, id: item.id, claimToken: item.claimToken!, now, consumedAt: input.now(), claimTtlMs: input.claimTtlMs,
    });
  }
}
