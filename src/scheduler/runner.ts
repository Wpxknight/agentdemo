import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  createRunDispatcher,
  MysqlSchedulerStore,
  SchedulerRunner,
  scheduledFireId,
  type SchedulerMysqlDatabase,
  type SchedulerStore,
  type ScheduledRunInput,
} from '../../packages/scheduler-runtime/src/index.js';
import { logger } from '../logger.js';
import type { Runtime } from '../runtime.js';
import type { ScheduledTask } from '../db/store.js';
import { MysqlStore } from '../db/mysql.js';
import type { TaskRunner } from './ticker.js';

const log = logger.child({ mod: 'scheduler' });

type Env = Record<string, string | undefined>;

export function shouldEmbedScheduler(env: Env = process.env): boolean {
  const value = env.AIOP_EMBED_SCHEDULER?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

/** Creates a durable product Run. The scheduler never enters an agent/Pi execution loop. */
export function createScheduledTaskRunner(rt: Runtime): TaskRunner {
  return async (task: ScheduledTask) => {
    if (!rt.durableRunRuntime) {
      throw new Error('DurableRunRuntime is required for scheduled Run creation');
    }
    const dispatcher = createRunDispatcher(rt.durableRunRuntime, scheduledRunLookup(rt));
    const fireTime = task.nextRunAt;
    const result = await dispatcher.startScheduledRun({
      taskId: String(task.id),
      fireId: scheduledFireId(String(task.id), fireTime),
      fireTime,
      identity: { tenantId: task.tenantId, actorId: task.userId, roles: ['user'] },
      sessionId: task.sessionId,
      input: [{ role: 'user', text: task.task }],
    });
    return { status: 'success', detail: result.runId };
  };
}

export interface RuntimeSchedulerOptions {
  /** Explicit package-store injection is reserved for tests; production derives MySQL from Runtime. */
  store?: SchedulerStore;
  workerId?: string;
  intervalMs?: number;
  batch?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

export interface RuntimeScheduler {
  tick(now?: Date): Promise<number>;
  start(): void;
  stop(): void;
}

export function createRuntimeScheduler(
  rt: Runtime,
  options: RuntimeSchedulerOptions = {},
): RuntimeScheduler {
  if (!rt.durableRunRuntime) {
    throw new Error('DurableRunRuntime is required for scheduled Run creation');
  }
  const store = options.store ?? productionSchedulerStore(rt);
  const runner = new SchedulerRunner({
    store,
    dispatcher: createRunDispatcher(rt.durableRunRuntime, scheduledRunLookup(rt)),
    workerId: options.workerId ?? `scheduler-${randomUUID()}`,
    leaseMs: options.leaseMs,
    retryDelayMs: options.retryDelayMs,
  });
  return new RuntimeSchedulerLoop(runner, options);
}

export function startRuntimeScheduler(
  rt: Runtime,
  options: RuntimeSchedulerOptions = {},
): RuntimeScheduler {
  const scheduler = createRuntimeScheduler(rt, options);
  scheduler.start();
  return scheduler;
}

class RuntimeSchedulerLoop implements RuntimeScheduler {
  private readonly intervalMs: number;
  private readonly batch: number;
  private readonly now: () => Date;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly runner: SchedulerRunner,
    options: RuntimeSchedulerOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.batch = options.batch ?? 10;
    this.now = options.now ?? (() => new Date());
  }

  tick(now = this.now()): Promise<number> {
    return this.runner.tick(now, this.batch);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((error) => log.error({ err: String(error) }, 'tick error'))
        .finally(() => { this.running = false; });
    }, this.intervalMs);
    this.timer.unref?.();
    log.info({ intervalMs: this.intervalMs }, 'scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function productionSchedulerStore(rt: Runtime): SchedulerStore {
  if (!(rt.store instanceof MysqlStore)) {
    throw new Error('MysqlStore is required for production scheduler assembly; inject SchedulerStore explicitly in tests');
  }
  return new MysqlSchedulerStore(
    rt.store.database() as unknown as Kysely<SchedulerMysqlDatabase>,
  );
}

function scheduledRunLookup(rt: Runtime) {
  return {
    findScheduledRun: async (input: ScheduledRunInput) => {
      const binding = await rt.store.getAgentRunBinding(input.identity.tenantId, input.fireId);
      if (!binding || binding.userId !== input.identity.actorId || binding.sessionId !== input.sessionId) {
        return undefined;
      }
      return { runId: binding.runId };
    },
  };
}
