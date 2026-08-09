import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  createRunDispatcher,
  MysqlSchedulerStore,
  SchedulerRunner,
  type BoundRunRecovery,
  type SchedulerMysqlDatabase,
  type SchedulerObserver,
  type SchedulerStore,
  type ScheduledRunInput,
} from '@aiop/scheduler-runtime';
import { logger } from '../logger.js';
import { projectCommittedPiSession } from '../agent/projections.js';
import type { Runtime } from '../runtime.js';
import { DEFAULT_TASK_MAX_RUN_MS, type AgentRunRecord } from '../db/store.js';
import { MysqlStore } from '../db/mysql.js';

const log = logger.child({ mod: 'scheduler' });

type Env = Record<string, string | undefined>;

export function shouldEmbedScheduler(env: Env = process.env): boolean {
  const value = env.AIOP_EMBED_SCHEDULER?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SCHEDULER_CLEANUP_BATCH = 100;

export interface SchedulerRetentionOptions {
  retentionMs: number;
  batch: number;
}

export function schedulerRetentionOptions(env: Env = process.env): SchedulerRetentionOptions | undefined {
  const days = Number(env.AIOP_SCHEDULER_FIRE_RETENTION_DAYS);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  const configuredBatch = Number(env.AIOP_SCHEDULER_CLEANUP_BATCH);
  return {
    retentionMs: days * DAY_MS,
    batch: Number.isInteger(configuredBatch) && configuredBatch > 0 ? configuredBatch : DEFAULT_SCHEDULER_CLEANUP_BATCH,
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
  /** 默认关闭；启用后只删除指定窗口外的 completed Fire。 */
  retention?: SchedulerRetentionOptions;
  observer?: SchedulerObserver;
  now?: () => Date;
}

export interface RuntimeScheduler {
  tick(now?: Date): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createRuntimeScheduler(
  rt: Runtime,
  options: RuntimeSchedulerOptions = {},
): RuntimeScheduler {
  const store = options.store ?? productionSchedulerStore(rt);
  const runner = new SchedulerRunner({
    store,
    dispatcher: createRunDispatcher(rt.durableRunRuntime, scheduledRunLookup(rt)),
    boundRecovery: durableBoundRunRecovery(rt),
    workerId: options.workerId ?? `scheduler-${randomUUID()}`,
    leaseMs: options.leaseMs,
    retryDelayMs: options.retryDelayMs,
    observer: options.observer ?? schedulerObserver(),
    prepareRun: async (fire, now) => ({
      limits: {
        deadlineAt: new Date(now.getTime() + (
          (await rt.store.getSchedulerSettings({ tenantId: fire.identity.tenantId }))?.maxRunMs ?? DEFAULT_TASK_MAX_RUN_MS
        )),
      },
    }),
    completed: async (fire, result) => {
      if (result.status !== 'succeeded' || !rt.piSessionStore) return;
      try {
        await projectCommittedPiSession({
          store: rt.store,
          sessions: rt.piSessionStore,
          ctx: requestContext(fire.identity),
          sessionId: fire.sessionId,
        });
      } catch (error) {
        log.warn({ err: error, fireId: fire.fireId, runId: result.runId }, 'scheduler durable 会话投影失败');
      }
    },
  });
  return new RuntimeSchedulerLoop(runner, store, {
    ...options,
    retention: options.retention ?? schedulerRetentionOptions(),
  });
}

function schedulerObserver(): SchedulerObserver {
  return {
    record(observation) {
      const { fireId, ...measurement } = observation;
      log.info({ ...measurement, ...(fireId ? { fireId, correlationId: fireId } : {}) }, 'scheduler measurement');
    },
  };
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
  private stopped = false;
  private readonly lifecycle = new AbortController();
  private inFlight?: Promise<number>;

  constructor(
    private readonly runner: SchedulerRunner,
    private readonly store: SchedulerStore,
    private readonly options: RuntimeSchedulerOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.batch = options.batch ?? 10;
    this.now = options.now ?? (() => new Date());
  }

  tick(now = this.now()): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    const execution = this.runner.tick(now, this.batch, this.lifecycle.signal)
      .then(async (processed) => {
        const retention = this.options.retention;
        if (retention) await this.store.cleanupCompleted({
          before: new Date(now.getTime() - retention.retentionMs), limit: retention.batch,
        });
        return processed;
      })
      .finally(() => {
        if (this.inFlight === execution) this.inFlight = undefined;
      });
    this.inFlight = execution;
    return execution;
  }

  start(): void {
    if (this.timer || this.stopped) return;
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

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.inFlight?.catch(() => undefined);
      return;
    }
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.lifecycle.abort(new Error('scheduler stopped'));
    await this.inFlight?.catch(() => undefined);
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
      const record = await rt.store.getAgentRun({
        tenantId: input.identity.tenantId, userId: input.identity.actorId, role: 'user',
      }, input.fireId);
      if (!record || record.status === 'queued' || record.status === 'running') return undefined;
      return { runId: record.runId, result: persistedRunResult(record) };
    },
  };
}

function durableBoundRunRecovery(rt: Runtime): BoundRunRecovery {
  return {
    async inspect(fire, now) {
      if (fire.fireId !== fire.runId) {
        throw new Error(`scheduled fire deterministic Run mismatch: ${fire.fireId}`);
      }
      const binding = await rt.store.getAgentRunBinding(fire.identity.tenantId, fire.runId);
      if (
        !binding
        || binding.tenantId !== fire.identity.tenantId
        || binding.userId !== fire.identity.actorId
        || binding.sessionId !== fire.sessionId
        || binding.runId !== fire.runId
      ) {
        throw new Error(`scheduled fire Durable Run binding mismatch: ${fire.fireId}`);
      }
      const record = await rt.store.getAgentRun({
        tenantId: fire.identity.tenantId, userId: fire.identity.actorId, role: 'user',
      }, fire.runId);
      if (!record) throw new Error(`scheduled fire Durable Run not found: ${fire.fireId}`);
      if (record.status === 'waiting') return { kind: 'waiting' };
      if (
        record.status === 'succeeded'
        || record.status === 'failed'
        || record.status === 'cancelled'
        || record.status === 'recovery_required'
      ) {
        return { kind: 'terminal', result: persistedRunResult(record) };
      }
      if (record.leaseExpiresAt && record.leaseExpiresAt.getTime() > now.getTime()) {
        return { kind: 'active' };
      }
      return { kind: 'recoverable' };
    },
    async resume(fire, signal) {
      const handle = await rt.durableRunRuntime.resume({
        identity: fire.identity,
        runId: fire.runId,
        signal,
      });
      return handle.result();
    },
  };
}

function requestContext(identity: ScheduledRunInput['identity']) {
  return {
    tenantId: identity.tenantId,
    userId: identity.actorId,
    role: identity.roles.includes('platform_admin') ? 'platform_admin' as const
      : identity.roles.includes('tenant_admin') ? 'tenant_admin' as const : 'user' as const,
  };
}

function persistedRunResult(record: AgentRunRecord) {
  return {
    runId: record.runId,
    status: record.status as 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required',
    usage: record.usage,
    ...(record.errorMessage ? {
      error: {
        code: record.status === 'recovery_required' ? 'TOOL_RESULT_UNKNOWN' as const : 'MODEL_PROVIDER_ERROR' as const,
        message: record.errorMessage,
        retryable: false,
      },
    } : {}),
  };
}
