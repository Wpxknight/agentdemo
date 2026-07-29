import type { DurableRunRuntime } from '@aiop/control-contracts';
import type {
  ClaimedScheduledFire,
  RunDispatcher,
  ScheduledRunInput,
  ScheduledRunLookup,
} from './domain.js';
import { SchedulerRecovery } from './recovery.js';
import type { SchedulerStore } from './store.js';

export interface SchedulerRunnerOptions {
  store: SchedulerStore;
  dispatcher: RunDispatcher;
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
    async startScheduledRun(input) {
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
        return { runId: handle.runId };
      } catch (error) {
        // A worker may die after Run creation but before marking the fire started.
        // The stable fire ID is the Run ID. Compensate only after an explicit lookup proves
        // that the deterministic Run exists; exception text is not a domain contract.
        const existing = await lookup?.findScheduledRun(input);
        if (existing?.runId === input.fireId) return existing;
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

  async tick(now: Date, limit: number): Promise<number> {
    await new SchedulerRecovery(this.options.store).recover(now);
    const fires = await this.options.store.claimDue({
      now,
      limit,
      workerId: this.options.workerId,
      leaseMs: this.leaseMs,
    });
    for (const fire of fires) {
      try {
        const prepared = await this.options.prepareRun?.(fire, now);
        const { runId } = await this.options.dispatcher.startScheduledRun({
          taskId: fire.taskId,
          fireId: fire.fireId,
          fireTime: fire.fireTime,
          identity: fire.identity,
          sessionId: fire.sessionId,
          input: fire.input,
          execution: fire.execution,
          ...prepared,
        });
        await this.options.store.completeFire({ fireId: fire.fireId, claimToken: fire.claimToken, runId, completedAt: now });
      } catch (error) {
        await this.options.store.releaseFire({
          fireId: fire.fireId,
          claimToken: fire.claimToken,
          retryAt: new Date(now.getTime() + this.retryDelayMs),
          error: String(error),
        });
      }
    }
    return fires.length;
  }
}
