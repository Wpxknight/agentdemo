import type { AgentRunResult, DurableRunRuntime } from '@aiop/control-contracts';
import type {
  BoundRunInspection,
  BoundRunRecovery,
  ClaimedScheduledFire,
  RunDispatcher,
  ScheduledRunInput,
  ScheduledRunLookup,
} from './domain.js';
import type { SchedulerStore } from './store.js';
import type { SchedulerObserver } from './observation.js';

export interface SchedulerRunnerOptions {
  store: SchedulerStore;
  dispatcher: RunDispatcher;
  boundRecovery: BoundRunRecovery;
  workerId: string;
  leaseMs?: number;
  retryDelayMs?: number;
  observer?: SchedulerObserver;
  prepareRun?(fire: ClaimedScheduledFire, now: Date): Promise<Pick<ScheduledRunInput, 'limits' | 'signal'>>;
  completed?(fire: ScheduledRunInput, result: AgentRunResult): Promise<void>;
}

export function createRunDispatcher(
  runtime: Pick<DurableRunRuntime, 'run'>,
  lookup?: ScheduledRunLookup,
): RunDispatcher {
  return {
    async startScheduledRun(input, onStarted) {
      let handle;
      try {
        handle = await runtime.run({
          runId: input.fireId,
          identity: input.identity,
          sessionId: input.sessionId,
          input: input.input,
          execution: input.execution,
          limits: input.limits,
          signal: input.signal,
        });
      } catch (error) {
        // A worker may die after Run creation but before marking the fire complete.
        // The stable fire ID is the Run ID. Compensate only after an explicit lookup proves
        // that the deterministic Run exists; exception text is not a domain contract.
        const existing = await lookup?.findScheduledRun(input);
        if (existing?.runId === input.fireId) {
          await onStarted?.(existing.runId);
          return existing;
        }
        throw error;
      }
      await onStarted?.(handle.runId);
      return { runId: handle.runId, result: await handle.result() };
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
    const tickStartedAt = Date.now();
    await this.options.store.recoverExpired(now);
    if (signal?.aborted) return 0;
    const bound = await this.options.store.listBound({ now, limit });
    const boundConsumed = bound.length;
    this.observe({ name: 'state_count', value: bound.length, state: 'bound' });
    for (const fire of bound) {
      this.observe({ name: 'long_stuck', value: Math.max(0, now.getTime() - fire.fireTime.getTime()), fireId: fire.fireId, state: 'bound' });
    }
    let recovered = 0;
    for (const fire of bound) {
      if (signal?.aborted) return recovered;
      let inspection: BoundRunInspection;
      try {
        inspection = await this.options.boundRecovery.inspect(fire, now);
      } catch (error) {
        await this.options.store.deferBound({
          fireId: fire.fireId,
          claimToken: fire.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: String(error),
        }).catch(() => undefined); // Keep a single observation failure isolated if its exact fence already advanced.
        recovered += 1;
        continue;
      }
      if (inspection.kind === 'active' || inspection.kind === 'waiting') {
        await this.options.store.deferBound({
          fireId: fire.fireId,
          claimToken: fire.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: `durable Run remains ${inspection.kind}`,
        }).catch(() => undefined);
        continue;
      }
      if (inspection.kind === 'terminal') {
        let completed = true;
        await this.options.store.completeFire({
          fireId: fire.fireId,
          claimToken: fire.claimToken,
          runId: fire.runId,
          result: inspection.result,
          completedAt: now,
        }).catch(async (error) => {
          completed = false;
          await this.options.store.deferBound({
            fireId: fire.fireId,
            claimToken: fire.claimToken,
            retryAt: new Date(now.getTime() + this.retryDelayMs),
            error: String(error),
          }).catch(() => undefined);
        });
        if (completed) await this.options.completed?.(fire, inspection.result);
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
      let result: AgentRunResult;
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('scheduler stopped');
        result = await this.options.boundRecovery.resume(claimed, signal);
        if (signal?.aborted) throw signal.reason ?? new Error('scheduler stopped');
      } catch (error) {
        await this.options.store.releaseBound({
          fireId: claimed.fireId,
          claimToken: claimed.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: String(error),
        }).catch(() => undefined); // Losing the scheduler fence must not replace the Durable resume failure.
        recovered += 1;
        continue;
      }
      if (result.status === 'waiting') {
        await this.options.store.releaseBound({
          fireId: claimed.fireId,
          claimToken: claimed.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: 'durable Run remains waiting',
        }).catch(() => undefined);
        recovered += 1;
        continue;
      }
      try {
        await this.options.store.completeFire({
          fireId: claimed.fireId,
          claimToken: claimed.claimToken,
          runId: claimed.runId,
          result,
          completedAt: now,
        });
        await this.options.completed?.(claimed, result);
      } catch (error) {
        await this.options.store.releaseBound({
          fireId: claimed.fireId,
          claimToken: claimed.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: String(error),
        }).catch(() => undefined); // A stale fence means another scheduler already advanced the fire.
      }
      recovered += 1;
    }
    if (signal?.aborted) return recovered;
    const remaining = Math.max(0, limit - boundConsumed);
    const fires = await this.options.store.claimDue({
      now,
      limit: remaining,
      workerId: this.options.workerId,
      leaseMs: this.leaseMs,
    });
    this.observe({ name: 'backlog', value: fires.length });
    for (const fire of fires) {
      const startedAt = Date.now();
      this.observe({ name: 'due_lag_ms', value: Math.max(0, now.getTime() - fire.fireTime.getTime()), fireId: fire.fireId });
      this.observe({ name: 'state_count', value: 1, fireId: fire.fireId, state: 'claimed' });
      let bound = false;
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
        }, async (runId) => {
          await this.options.store.bindRun({
            fireId: fire.fireId, claimToken: fire.claimToken, runId, boundAt: now,
          });
          bound = true;
        });
        if (signal?.aborted) throw signal.reason ?? new Error('scheduler stopped');
        if (result.status === 'waiting') {
          await this.options.store.deferBound({
            fireId: fire.fireId,
            claimToken: fire.claimToken,
            retryAt: new Date(now.getTime() + this.retryDelayMs),
            error: 'durable Run remains waiting',
          });
        } else {
          await this.options.store.completeFire({
            fireId: fire.fireId, claimToken: fire.claimToken, runId, result, completedAt: now,
          });
          this.observe({ name: 'completion', value: 1, fireId: fire.fireId, state: 'completed' });
          await this.options.completed?.(fire, result);
        }
      } catch (error) {
        this.observe({ name: 'retry', value: 1, fireId: fire.fireId, state: 'failed' });
        const retry = {
          fireId: fire.fireId,
          claimToken: fire.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: String(error),
        };
        if (bound) {
          await this.options.store.deferBound(retry).catch(() => undefined);
        } else {
          await this.options.store.releaseFire(retry).catch(() => undefined);
        }
      }
      this.observe({ name: 'duration_ms', value: Math.max(0, Date.now() - startedAt), fireId: fire.fireId });
    }
    this.observe({ name: 'duration_ms', value: Math.max(0, Date.now() - tickStartedAt) });
    return recovered + fires.length;
  }

  private observe(observation: Parameters<SchedulerObserver['record']>[0]): void {
    this.options.observer?.record(observation);
  }
}
