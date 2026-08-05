import { LeaseLostError } from '@aiop/control-contracts';
import type { DurableRunStore } from '../store/types.js';

export function startLeaseHeartbeat(input: {
  store: DurableRunStore; tenantId: string; runId: string; workerId: string; fencingToken: bigint;
  leaseTtlMs: number; heartbeatMs: number; abort: AbortController; now: () => Date;
}): () => void {
  if (input.heartbeatMs <= 0) return () => {};
  const timer = setInterval(() => {
    void input.store.renewLease({
      tenantId: input.tenantId, runId: input.runId, workerId: input.workerId,
      fencingToken: input.fencingToken, now: input.now(), leaseTtlMs: input.leaseTtlMs,
    }).catch(() => input.abort.abort(new LeaseLostError()));
  }, input.heartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
