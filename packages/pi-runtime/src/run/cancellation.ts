import type { DurableRunStore } from '../store/types.js';

export async function abortIfCancellationRequested(
  store: DurableRunStore, identity: { tenantId: string; runId: string }, abort: AbortController,
): Promise<void> {
  if (await store.isCancellationRequested(identity) && !abort.signal.aborted) {
    abort.abort(new Error('Run cancellation requested'));
  }
}
