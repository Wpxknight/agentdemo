import type { DurableRunRuntime } from '@aiop/control-contracts';
import type {
  BoundRunRecovery,
  ClaimedScheduledFire,
  RunDispatcher,
  ScheduledRunInput,
  ScheduledRunLookup,
} from './domain.js';
import type { SchedulerStore } from './store.js';

export interface SchedulerRunnerOptions {
  store: SchedulerStore;
  dispatcher: RunDispatcher;
  boundRecovery: BoundRunRecovery;
  workerId: string;
  leaseMs?: number;
  retryDelayMs?: number;
  prepareRun?(fire: ClaimedScheduledFire, now: Date): Promise<Pick<ScheduledRunInput, 'limits' | 'signal'>>;
}

export function createRunDispatcher(
  runtime: Pick<DurableRunRuntime, 'run'>,
  lookup?: ScheduledRunLookup,
): RunDispatcher {
  return {
    async startScheduledRun(input, onStarted) {
      try {
        const handle = await runtime.run({
          runId: input.fireId,
          identity: input.identity,
          sessionId: input.sessionId,
          input: input.input,
          execution: input.execution,
          limits: input.limits,
          signal: input.signal,
        });
        await onStarted?.(handle.runId);
        return { runId: handle.runId, result: await handle.result() };
      } catch (error) {
        // A worker may die after Run creation but before marking the fire started.
        // The stable fire ID is the Run ID. Compensate only after an explicit lookup proves
        // that the deterministic Run exists; exception text is not a domain contract.
        const existing = await lookup?.findScheduledRun(input);
        if (existing?.runId === input.fireId) {
          await onStarted?.(existing.runId);
          return existing;
        }
        throw error;
      }
    },
  };
}

export class SchedulerRunner {
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: SchedulerRunnerOptions) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
  }

  async tick(now: Date, limit: number, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return 0;
    await this.options.store.recoverExpired(now);
    if (signal?.aborted) return 0;
    const bound = await this.options.store.listBound({ now, limit });
    let recovered = 0;
    for (const fire of bound) {
      if (signal?.aborted) return recovered;
      const inspection = await this.options.boundRecovery.inspect(fire, now);
      if (inspection.kind === 'active') continue;
      if (inspection.kind === 'terminal') {
        await this.options.store.completeFire({
          fireId: fire.fireId,
          claimToken: fire.claimToken,
          runId: fire.runId,
          result: inspection.result,
          completedAt: now,
        });
        recovered += 1;
        continue;
      }
      const claimed = await this.options.store.claimBound({
        fireId: fire.fireId,
        expectedClaimToken: fire.claimToken,
        now,
        workerId: this.options.workerId,
        leaseMs: this.leaseMs,
      });
      if (!claimed) continue;
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('scheduler stopped');
        const result = await this.options.boundRecovery.resume(claimed, signal);
        if (signal?.aborted) throw signal.reason ?? new Error('scheduler stopped');
        await this.options.store.completeFire({
          fireId: claimed.fireId,
          claimToken: claimed.claimToken,
          runId: claimed.runId,
          result,
          completedAt: now,
        });
      } catch (error) {
        await this.options.store.releaseBound({
          fireId: claimed.fireId,
          claimToken: claimed.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: String(error),
        });
      }
      recovered += 1;
    }
    if (signal?.aborted) return recovered;
    const remaining = Math.max(0, limit - recovered);
    const fires = await this.options.store.claimDue({
      now,
      limit: remaining,
      workerId: this.options.workerId,
      leaseMs: this.leaseMs,
    });
    for (const fire of fires) {
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('scheduler stopped');
        const prepared = await this.options.prepareRun?.(fire, now);
        const runSignal = signal && prepared?.signal
          ? AbortSignal.any([signal, prepared.signal])
          : signal ?? prepared?.signal;
        if (runSignal?.aborted) throw runSignal.reason ?? new Error('scheduler stopped');
        const { runId, result } = await this.options.dispatcher.startScheduledRun({
          taskId: fire.taskId,
          fireId: fire.fireId,
          fireTime: fire.fireTime,
          identity: fire.identity,
          sessionId: fire.sessionId,
          input: fire.input,
          execution: fire.execution,
          ...prepared,
          signal: runSignal,
        }, (runId) => this.options.store.bindRun({
          fireId: fire.fireId, claimToken: fire.claimToken, runId, boundAt: now,
        }));
        if (signal?.aborted) throw signal.reason ?? new Error('scheduler stopped');
        await this.options.store.completeFire({
          fireId: fire.fireId, claimToken: fire.claimToken, runId, result, completedAt: now,
        });
      } catch (error) {
        await this.options.store.releaseFire({
          fireId: fire.fireId,
          claimToken: fire.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: String(error),
        });
      }
    }
    return recovered + fires.length;
  }
}
