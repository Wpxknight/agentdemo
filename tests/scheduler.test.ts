import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { MemoryStore } from '../src/db/memory.js';
import { MysqlStore } from '../src/db/mysql.js';
import { MemorySchedulerStore } from '../packages/scheduler-runtime/src/index.js';
import { Scheduler } from '../src/scheduler/ticker.js';
import { isValidCron, nextRunAt } from '../src/scheduler/cron.js';
import {
  createRuntimeScheduler,
  createScheduledTaskRunner,
  shouldEmbedScheduler,
  startRuntimeScheduler,
} from '../src/scheduler/runner.js';
import { buildScheduleTools } from '../src/tools/schedule.js';
import type { Runtime } from '../src/runtime.js';
import type { RequestContext } from '../src/auth/types.js';

const ctx = { sessionId: 's1', tenantId: 't1', userId: 'u1', role: 'user' as const };
const rctx: RequestContext = { tenantId: 't1', userId: 'u1', role: 'user' };

describe('cron', () => {
  it('computes next run after a given time', () => {
    const next = nextRunAt('0 1 * * *', new Date('2026-06-17T05:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-18T01:00:00.000Z');
  });
  it('validates expressions', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('nonsense')).toBe(false);
  });
});

describe('schedule tools', () => {
  it('schedule_task validates cron and persists', async () => {
    const store = new MemoryStore();
    const [schedule] = buildScheduleTools(store);

    const bad = await schedule!.run({ cron: 'nope', task: 'x' }, ctx);
    expect(bad.isError).toBe(true);

    const ok = await schedule!.run({ cron: '0 1 * * *', task: '巡检' }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(await store.listScheduledTasks(rctx)).toHaveLength(1);
  });

  it('only admins may create preApproved tasks', async () => {
    const store = new MemoryStore();
    const [schedule] = buildScheduleTools(store);

    const denied = await schedule!.run({ cron: '0 1 * * *', task: 't', preApproved: true }, ctx); // role=user
    expect(denied.isError).toBe(true);

    const adminCtx = { ...ctx, role: 'tenant_admin' as const };
    const ok = await schedule!.run({ cron: '0 1 * * *', task: 't', preApproved: true }, adminCtx);
    expect(ok.isError).toBeFalsy();
    expect((await store.listScheduledTasks(rctx))[0]!.preApproved).toBe(true);
  });

  it('cancel disables the task', async () => {
    const store = new MemoryStore();
    const tools = buildScheduleTools(store);
    const created = await store.createScheduledTask(rctx, { sessionId: 's1', cron: '* * * * *', task: 't' });
    const cancel = tools.find((t) => t.def.name === 'cancel_scheduled_task')!;

    await cancel.run({ id: created.id }, ctx);

    expect((await store.listScheduledTasks(rctx))[0]!.enabled).toBe(false);
  });

  it('update_scheduled_task patches fields and recomputes next run on cron change', async () => {
    const store = new MemoryStore();
    const tools = buildScheduleTools(store);
    const created = await store.createScheduledTask(rctx, { sessionId: 's1', cron: '0 1 * * *', task: '旧任务' });
    const update = tools.find((t) => t.def.name === 'update_scheduled_task')!;

    const badCron = await update.run({ id: created.id, cron: 'nope' }, ctx);
    expect(badCron.isError).toBe(true);

    const noFields = await update.run({ id: created.id }, ctx);
    expect(noFields.isError).toBe(true);

    const deniedPre = await update.run({ id: created.id, preApproved: true }, ctx); // role=user
    expect(deniedPre.isError).toBe(true);

    const ok = await update.run({ id: created.id, cron: '0 2 * * *', task: '新任务', enabled: false }, ctx);
    expect(ok.isError).toBeFalsy();
    const after = (await store.listScheduledTasks(rctx))[0]!;
    expect(after.cron).toBe('0 2 * * *');
    expect(after.task).toBe('新任务');
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt.getUTCHours()).toBe(2);

    const missing = await update.run({ id: 999, task: 'x' }, ctx);
    expect(missing.isError).toBe(true);
  });

  it('delete_scheduled_task removes the task and its runs', async () => {
    const store = new MemoryStore();
    const tools = buildScheduleTools(store);
    const created = await store.createScheduledTask(rctx, { sessionId: 's1', cron: '0 1 * * *', task: 't' });
    await store.recordTaskRun({ taskId: created.id, status: 'success', detail: 'ok' });
    const del = tools.find((t) => t.def.name === 'delete_scheduled_task')!;

    const ok = await del.run({ id: created.id }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(await store.listScheduledTasks(rctx)).toHaveLength(0);
    expect(await store.listTaskRuns(rctx, created.id)).toHaveLength(0);

    const missing = await del.run({ id: created.id }, ctx);
    expect(missing.isError).toBe(true);
  });
});

describe('MemoryStore 定时任务 get/update/delete', () => {
  it('enforces tenant isolation', async () => {
    const store = new MemoryStore();
    const created = await store.createScheduledTask(rctx, { sessionId: 's1', cron: '0 1 * * *', task: 't' });
    const other = { tenantId: 'other', userId: 'u2', role: 'user' as const };

    expect(await store.getScheduledTask(other, created.id)).toBeUndefined();
    expect(await store.updateScheduledTask(other, created.id, { task: 'hack' })).toBeUndefined();
    expect(await store.deleteScheduledTask(other, created.id)).toBe(false);
    expect(await store.getScheduledTask(rctx, created.id)).toMatchObject({ id: created.id, task: 't' });
  });
});

describe('Scheduler', () => {
  it('runs due tasks and records runs', async () => {
    const store = new MemoryStore();
    await store.createScheduledTask(rctx, { sessionId: 's1', cron: '* * * * *', task: 'do it' });
    const runner = vi.fn(async () => ({ status: 'success' as const, detail: 'ok', steps: 2 }));

    // 当前时间设在创建后 +1 分钟，使任务到点
    const now = () => new Date(Date.now() + 90_000);
    const sched = new Scheduler({ store, runner, now });

    const handled = await sched.tick();

    expect(handled).toBe(1);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ task: 'do it', sessionId: 's1' }));
    const runs = await store.listTaskRuns(rctx, 1);
    expect(runs).toEqual([
      expect.objectContaining({ id: 1, taskId: 1, status: 'success', detail: 'ok', steps: 2 }),
    ]);
    expect(runs[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('does not run tasks that are not yet due', async () => {
    const store = new MemoryStore();
    await store.createScheduledTask(rctx, { sessionId: 's1', cron: '0 1 * * *', task: 'later' });
    const runner = vi.fn(async () => ({ status: 'success' as const }));
    // 不注入 now：用真实当前时间，距离次日 1 点尚未到点
    const sched = new Scheduler({ store, runner });

    expect(await sched.tick()).toBe(0);
    expect(runner).not.toHaveBeenCalled();
  });

  it('concurrent ticks do not double-run a task', async () => {
    const store = new MemoryStore();
    await store.createScheduledTask(rctx, { sessionId: 's1', cron: '* * * * *', task: 't' });
    const runner = vi.fn(async () => ({ status: 'success' as const }));
    const now = () => new Date(Date.now() + 90_000);
    const sched = new Scheduler({ store, runner, now });

    const [a, b] = await Promise.all([sched.tick(), sched.tick()]);

    expect(a + b).toBe(1); // 仅一次领取
    expect(runner).toHaveBeenCalledOnce();
  });

  it('records error when runner throws', async () => {
    const store = new MemoryStore();
    await store.createScheduledTask(rctx, { sessionId: 's1', cron: '* * * * *', task: 't' });
    const runner = vi.fn(async () => {
      throw new Error('boom');
    });
    const now = () => new Date(Date.now() + 90_000);
    const sched = new Scheduler({ store, runner, now });

    await sched.tick();

    const runs = await store.listTaskRuns(rctx, 1);
    expect(runs[0]!.status).toBe('error');
    expect(runs[0]!.detail).toContain('boom');
  });
});

describe('createScheduledTaskRunner', () => {
  it.each(['failed', 'cancelled', 'recovery_required', 'waiting'] as const)(
    'records final durable %s state as a compatible error detail',
    async (status) => {
      const store = new MemoryStore();
      await store.setSchedulerSettings({ tenantId: 't1' }, { maxRunMs: 5 * 60_000 });
      const run = vi.fn(async () => ({
        runId: `scheduled-${status}`, status: 'running' as const,
        events: { async *[Symbol.asyncIterator]() {} },
        result: async () => ({
          runId: `scheduled-${status}`, status,
          usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
      }));
      const result = await createScheduledTaskRunner({ store, durableRunRuntime: { run } } as unknown as Runtime)({
        id: 1, tenantId: 't1', userId: 'u1', sessionId: 'cron-sess', cron: '* * * * *',
        title: '巡检', task: '巡检', preApproved: false, enabled: true, nextRunAt: new Date(),
      });

      expect(result.status).toBe('error');
      expect(JSON.parse(result.detail ?? '{}')).toMatchObject({ runId: `scheduled-${status}`, status });
    },
  );

  it('creates a product Run through DurableRunRuntime.run', async () => {
    const store = new MemoryStore();
    await store.setSchedulerSettings({ tenantId: 't1' }, { maxRunMs: 5 * 60_000 });
    const run = vi.fn(async () => ({
      runId: 'scheduled-run', status: 'running' as const,
      events: { async *[Symbol.asyncIterator]() {} },
      result: async () => ({
        runId: 'scheduled-run', status: 'succeeded' as const,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    }));
    const rt = {
      store,
      durableRunRuntime: { run },
    } as unknown as Runtime;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T02:00:00.000Z'));
    let result;
    try {
      result = await createScheduledTaskRunner(rt)({
        id: 1, tenantId: 't1', userId: 'u1', sessionId: 'cron-sess',
        cron: '* * * * *', title: '巡检', task: '巡检', preApproved: true, enabled: true,
        nextRunAt: new Date('2026-07-29T01:00:00.000Z'),
      });
    } finally {
      vi.useRealTimers();
    }

    expect(result.status).toBe('success');
    expect(JSON.parse(result.detail ?? '{}')).toMatchObject({ runId: 'scheduled-run', status: 'succeeded' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      identity: { tenantId: 't1', actorId: 'u1', roles: ['user'] },
      sessionId: 'cron-sess',
      input: [{ role: 'user', text: '巡检' }],
      execution: { unattended: true, preApproved: true },
      limits: { deadlineAt: new Date('2026-07-29T02:05:00.000Z') },
    }));
  });});

describe('embedded scheduler deployment', () => {
  it('maps a waiting bound Durable Run to compatibility error detail without run or resume', async () => {
    const fireTime = new Date('2026-07-29T01:00:00.000Z');
    const schedulerStore = new MemorySchedulerStore([{
      taskId: 'task-waiting', tenantId: 'tenant-a', actorId: 'user-a', sessionId: 'session-a',
      cron: '0 * * * *', input: [{ role: 'user', text: 'diagnose' }], nextFireAt: fireTime,
    }]);
    const [fire] = await schedulerStore.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
    await schedulerStore.bindRun({
      fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime,
    });
    const store = new MemoryStore();
    await store.putAgentRunBindingIfAbsent({
      tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', runId: fire!.fireId,
      kernel: 'pi', graphName: 'pi', graphVersion: '0.82.1', createdAt: fireTime,
    });
    await store.updateAgentRun('tenant-a', fire!.fireId, {
      status: 'waiting', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 0 },
      updatedAt: fireTime, clearLease: true,
    });
    const run = vi.fn();
    const resume = vi.fn();
    const scheduler = createRuntimeScheduler({
      store, durableRunRuntime: { run, resume },
    } as unknown as Runtime, {
      store: schedulerStore, workerId: 'observer', leaseMs: 10, batch: 1,
    });

    expect(await scheduler.tick(new Date(fireTime.getTime() + 10))).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect((await schedulerStore.listFires())[0]).toMatchObject({
      state: 'started', runId: fire!.fireId,
      result: { runId: fire!.fireId, status: 'waiting', usage: { inputTokens: 3, outputTokens: 2 } },
    });
  });

  it('preserves TOOL_RESULT_UNKNOWN when reconciling a recovery-required bound Run', async () => {
    const fireTime = new Date('2026-07-29T01:00:00.000Z');
    const schedulerStore = new MemorySchedulerStore([{
      taskId: 'task-recovery', tenantId: 'tenant-a', actorId: 'user-a', sessionId: 'session-a',
      cron: '0 * * * *', input: [{ role: 'user', text: 'deploy' }], nextFireAt: fireTime,
    }]);
    const [fire] = await schedulerStore.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
    await schedulerStore.bindRun({
      fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime,
    });
    const store = new MemoryStore();
    await store.putAgentRunBindingIfAbsent({
      tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', runId: fire!.fireId,
      kernel: 'pi', graphName: 'pi', graphVersion: '0.82.1', createdAt: fireTime,
    });
    await store.updateAgentRun('tenant-a', fire!.fireId, {
      status: 'recovery_required', errorMessage: 'tool result is unknown',
      usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      updatedAt: fireTime, clearLease: true,
    });
    const scheduler = createRuntimeScheduler({
      store, durableRunRuntime: { run: vi.fn(), resume: vi.fn() },
    } as unknown as Runtime, {
      store: schedulerStore, workerId: 'observer', leaseMs: 10, batch: 1,
    });

    expect(await scheduler.tick(new Date(fireTime.getTime() + 10))).toBe(1);
    expect((await schedulerStore.listFires())[0]).toMatchObject({
      state: 'started',
      result: {
        status: 'recovery_required',
        error: { code: 'TOOL_RESULT_UNKNOWN', message: 'tool result is unknown', retryable: false },
      },
    });
  });

  it('observes an authoritative queued lease and resumes it with the scheduler signal after expiry', async () => {
    const fireTime = new Date('2026-07-29T01:00:00.000Z');
    const observedAt = new Date(fireTime.getTime() + 10);
    const schedulerStore = new MemorySchedulerStore([{
      taskId: 'task-queued', tenantId: 'tenant-a', actorId: 'user-a', sessionId: 'session-a',
      cron: '0 * * * *', input: [{ role: 'user', text: 'deploy' }], nextFireAt: fireTime,
    }]);
    const [fire] = await schedulerStore.claimDue({ now: fireTime, limit: 1, workerId: 'dead', leaseMs: 10 });
    await schedulerStore.bindRun({
      fireId: fire!.fireId, claimToken: fire!.claimToken, runId: fire!.fireId, boundAt: fireTime,
    });
    const binding = {
      tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', runId: fire!.fireId,
      kernel: 'pi' as const, graphName: 'pi', graphVersion: '0.82.1', createdAt: fireTime,
    };
    const record = {
      ...binding, status: 'queued' as const, stepCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      updatedAt: fireTime, leaseToken: 1, leaseOwner: 'durable-a',
      leaseExpiresAt: new Date(observedAt.getTime() + 100),
    };
    const run = vi.fn();
    const resume = vi.fn(async () => ({
      runId: fire!.fireId, status: 'running' as const,
      events: { async *[Symbol.asyncIterator]() {} },
      result: async () => ({
        runId: fire!.fireId, status: 'succeeded' as const,
        usage: record.usage,
      }),
    }));
    const runtimeStore = {
      getAgentRunBinding: vi.fn(async () => binding),
      getAgentRun: vi.fn(async () => record),
    };
    const scheduler = createRuntimeScheduler({
      store: runtimeStore, durableRunRuntime: { run, resume },
    } as unknown as Runtime, {
      store: schedulerStore, workerId: 'observer', leaseMs: 10, batch: 1,
    });

    expect(await scheduler.tick(observedAt)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    record.leaseExpiresAt = observedAt;
    expect(await scheduler.tick(new Date(observedAt.getTime() + 1))).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      runId: fire!.fireId,
      signal: expect.any(AbortSignal),
    });
    expect((await schedulerStore.listFires())[0]).toMatchObject({
      state: 'started', result: { status: 'succeeded' },
    });
  });

  it('awaits scheduler shutdown before disposing the runtime in production entrypoints', async () => {
    const source = await readFile('src/index.ts', 'utf8');
    expect(source).toContain('await scheduler?.stop()');
    expect(source).toContain('await scheduler.stop()');
  });

  it('aborts and awaits an in-flight tick before stopping permanently', async () => {
    const fireTime = new Date('2026-07-29T01:00:00.000Z');
    const store = new MemorySchedulerStore([{
      taskId: 'task-stop', tenantId: 'tenant-a', actorId: 'user-a', sessionId: 'session-a',
      cron: '0 * * * *', input: [{ role: 'user', text: 'diagnose' }], nextFireAt: fireTime,
    }]);
    const claimDue = vi.spyOn(store, 'claimDue');
    let rejectRun!: (error: Error) => void;
    let receivedSignal: AbortSignal | undefined;
    let runCalls = 0;
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => { started = resolve; });
    const run = vi.fn(async (input: { signal?: AbortSignal }) => {
      runCalls += 1;
      if (runCalls > 1) throw new Error('must not dispatch after stop');
      receivedSignal = input.signal;
      started();
      return new Promise((_resolve, reject) => { rejectRun = reject; });
    });
    const runtimeStore = new MemoryStore();
    await runtimeStore.setSchedulerSettings({ tenantId: 'tenant-a' }, { maxRunMs: 5 * 60_000 });
    const scheduler = createRuntimeScheduler({
      store: runtimeStore, durableRunRuntime: { run },
    } as unknown as Runtime, { store, workerId: 'stop-worker' });

    const tick = scheduler.tick(fireTime);
    await runStarted;
    const stopping = Promise.resolve(scheduler.stop());
    const abortedWhenStopped = receivedSignal?.aborted === true;
    rejectRun(new Error('scheduler stopped'));
    await tick;
    await stopping;
    expect(abortedWhenStopped).toBe(true);
    expect(await scheduler.tick(new Date(fireTime.getTime() + 60_000))).toBe(0);
    expect(claimDue).toHaveBeenCalledOnce();
  });

  it('uses an explicitly injected MemorySchedulerStore only for tests', async () => {
    const fireTime = new Date('2026-07-29T01:00:00.000Z');
    const store = new MemorySchedulerStore([{
      taskId: 'task-a', tenantId: 'tenant-a', actorId: 'user-a', sessionId: 'session-a',
      cron: '0 * * * *', input: [{ role: 'user', text: 'diagnose' }], nextFireAt: fireTime,
      preApproved: true,
    }]);
    const run = vi.fn(async () => ({
      runId: 'task-a:2026-07-29T01:00:00.000Z', status: 'running' as const,
      events: { async *[Symbol.asyncIterator]() {} },
      result: async () => ({
        runId: 'task-a:2026-07-29T01:00:00.000Z', status: 'succeeded' as const,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    }));
    const runtimeStore = new MemoryStore();
    await runtimeStore.setSchedulerSettings({ tenantId: 'tenant-a' }, { maxRunMs: 5 * 60_000 });
    const scheduler = createRuntimeScheduler({
      store: runtimeStore, durableRunRuntime: { run },
    } as unknown as Runtime, { store, workerId: 'test-worker' });

    expect(await scheduler.tick(fireTime)).toBe(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      execution: { unattended: true, preApproved: true },
      limits: { deadlineAt: new Date('2026-07-29T01:05:00.000Z') },
    }));
  });

  it('requires MysqlStore for production scheduler assembly', () => {
    const runtime = {
      store: new MemoryStore(), durableRunRuntime: { run: vi.fn() },
    } as unknown as Runtime;

    expect(() => startRuntimeScheduler(runtime)).toThrow('MysqlStore');
  });

  it('assembles the production scheduler for MysqlStore', () => {
    const runtime = {
      store: new MysqlStore({} as never), durableRunRuntime: { run: vi.fn() },
    } as unknown as Runtime;

    const scheduler = startRuntimeScheduler(runtime, { intervalMs: 60_000, workerId: 'worker-a' });
    scheduler.stop();
  });

  it('enables embedding only with an explicit truthy env value', () => {
    expect(shouldEmbedScheduler({})).toBe(false);
    expect(shouldEmbedScheduler({ AIOP_EMBED_SCHEDULER: 'false' })).toBe(false);
    expect(shouldEmbedScheduler({ AIOP_EMBED_SCHEDULER: '0' })).toBe(false);
    expect(shouldEmbedScheduler({ AIOP_EMBED_SCHEDULER: 'true' })).toBe(true);
    expect(shouldEmbedScheduler({ AIOP_EMBED_SCHEDULER: '1' })).toBe(true);
  });

  it('runs scheduler inside aiop-server in dev k8s instead of a separate deployment', async () => {
    const yaml = await readFile('deploy/dev-k8s/aiop-deployment.yaml', 'utf8');

    expect(yaml).toContain('name: AIOP_EMBED_SCHEDULER');
    expect(yaml).toContain('value: "true"');
    expect(yaml).not.toMatch(/name:\s+aiop-scheduler/);
    expect(yaml).not.toContain('npm", "run", "scheduler');
  });
});
