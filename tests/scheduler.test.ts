import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { MemoryStore } from '../src/db/memory.js';
import { MysqlStore } from '../src/db/mysql.js';
import { MemorySchedulerStore } from '../packages/scheduler-runtime/src/index.js';
import { isValidCron, nextRunAt } from '../src/scheduler/cron.js';
import {
  createRuntimeScheduler,
  schedulerRetentionOptions,
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

  it('computes a task cron in its IANA timezone across DST', () => {
    const next = nextRunAt('0 2 * * *', new Date('2026-03-08T06:59:00Z'), 'America/New_York');
    // 02:00 不存在的 spring-forward 日由 cron-parser 顺延至当地 03:00。
    expect(next.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('rejects an invalid IANA timezone', () => {
    expect(isValidCron('0 1 * * *', 'Not/A_Zone')).toBe(false);
  });
});

describe('schedule tools', () => {
  it('schedule_task validates cron and persists', async () => {
    const store = new MemoryStore();
    const [schedule] = buildScheduleTools(store);

    const bad = await schedule!.execute({ cron: 'nope', task: 'x' }, ctx);
    expect(bad.isError).toBe(true);

    const ok = await schedule!.execute({ cron: '0 1 * * *', task: '巡检' }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(await store.listScheduledTasks(rctx)).toEqual([
      expect.objectContaining({ timezone: 'UTC' }),
    ]);
  });

  it('schedule tools persist and validate IANA task timezones', async () => {
    const store = new MemoryStore();
    const tools = buildScheduleTools(store);
    const create = tools.find((tool) => tool.name === 'schedule_task')!;
    const update = tools.find((tool) => tool.name === 'update_scheduled_task')!;

    const invalid = await create.execute({ cron: '0 1 * * *', timezone: 'Not/A_Zone', task: '巡检' }, ctx);
    expect(invalid.isError).toBe(true);
    const created = await create.execute({ cron: '0 1 * * *', timezone: 'Asia/Shanghai', task: '巡检' }, ctx);
    expect(created.isError).toBeFalsy();
    const [task] = await store.listScheduledTasks(rctx);
    expect(task!.timezone).toBe('Asia/Shanghai');

    const updated = await update.execute({ id: task!.id, timezone: 'America/New_York' }, ctx);
    expect(updated.isError).toBeFalsy();
    expect((await store.getScheduledTask(rctx, task!.id))?.timezone).toBe('America/New_York');
  });

  it('only admins may create preApproved tasks', async () => {
    const store = new MemoryStore();
    const [schedule] = buildScheduleTools(store);

    const denied = await schedule!.execute({ cron: '0 1 * * *', task: 't', preApproved: true }, ctx); // role=user
    expect(denied.isError).toBe(true);

    const adminCtx = { ...ctx, role: 'tenant_admin' as const };
    const ok = await schedule!.execute({ cron: '0 1 * * *', task: 't', preApproved: true }, adminCtx);
    expect(ok.isError).toBeFalsy();
    expect((await store.listScheduledTasks(rctx))[0]!.preApproved).toBe(true);
  });

  it('cancel disables the task', async () => {
    const store = new MemoryStore();
    const tools = buildScheduleTools(store);
    const created = await store.createScheduledTask(rctx, { sessionId: 's1', cron: '* * * * *', task: 't' });
    const cancel = tools.find((t) => t.name === 'cancel_scheduled_task')!;

    await cancel.execute({ id: created.id }, ctx);

    expect((await store.listScheduledTasks(rctx))[0]!.enabled).toBe(false);
  });

  it('update_scheduled_task patches fields and recomputes next run on cron change', async () => {
    const store = new MemoryStore();
    const tools = buildScheduleTools(store);
    const created = await store.createScheduledTask(rctx, { sessionId: 's1', cron: '0 1 * * *', task: '旧任务' });
    const update = tools.find((t) => t.name === 'update_scheduled_task')!;

    const badCron = await update.execute({ id: created.id, cron: 'nope' }, ctx);
    expect(badCron.isError).toBe(true);

    const noFields = await update.execute({ id: created.id }, ctx);
    expect(noFields.isError).toBe(true);

    const deniedPre = await update.execute({ id: created.id, preApproved: true }, ctx); // role=user
    expect(deniedPre.isError).toBe(true);

    const ok = await update.execute({ id: created.id, cron: '0 2 * * *', task: '新任务', enabled: false }, ctx);
    expect(ok.isError).toBeFalsy();
    const after = (await store.listScheduledTasks(rctx))[0]!;
    expect(after.cron).toBe('0 2 * * *');
    expect(after.task).toBe('新任务');
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt.getUTCHours()).toBe(2);

    const missing = await update.execute({ id: 999, task: 'x' }, ctx);
    expect(missing.isError).toBe(true);
  });

  it('delete_scheduled_task hides the task and preserves Fire history', async () => {
    const store = new MemoryStore();
    const tools = buildScheduleTools(store);
    const created = await store.createScheduledTask(rctx, { sessionId: 's1', cron: '0 1 * * *', task: 't' });
    await store.createManualFire(rctx, created.id, 'history-key');
    const del = tools.find((t) => t.name === 'delete_scheduled_task')!;

    const ok = await del.execute({ id: created.id }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(await store.listScheduledTasks(rctx)).toHaveLength(0);
    expect(await store.getScheduledTask(rctx, created.id)).toBeUndefined();
    expect(await store.listScheduledExecutions(rctx, created.id)).toHaveLength(1);

    const missing = await del.execute({ id: created.id }, ctx);
    expect(missing.isError).toBe(true);
  });
});

describe('MemoryStore 定时任务 get/update/delete', () => {
  it('rejects invalid cron at the Store boundary without writing a task', async () => {
    const store = new MemoryStore();

    await expect(store.createScheduledTask(rctx, { sessionId: 's1', cron: 'nope', task: 't' }))
      .rejects.toThrow('非法 cron 表达式: nope');
    expect(await store.listScheduledTasks(rctx)).toHaveLength(0);
  });

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


describe('embedded scheduler deployment', () => {
  it('keeps completed Fire cleanup disabled unless retention is explicitly configured', () => {
    expect(schedulerRetentionOptions({})).toBeUndefined();
    expect(schedulerRetentionOptions({ AIOP_SCHEDULER_FIRE_RETENTION_DAYS: '30' })).toEqual({
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      batch: 100,
    });
  });
  it('keeps a waiting bound Durable Run bound without run or resume', async () => {
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
      kernel: 'pi', createdAt: fireTime,
    });
    await store.updateAgentRun('tenant-a', fire!.fireId, {
      status: 'waiting', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 0 },
      updatedAt: fireTime, clearLease: true,
    });
    expect((await store.getAgentRun({ tenantId: 'tenant-a', userId: 'user-a', role: 'user' }, fire!.fireId))?.status).toBe('waiting');
    const run = vi.fn();
    const resume = vi.fn();
    const scheduler = createRuntimeScheduler({
      store, durableRunRuntime: { run, resume },
    } as unknown as Runtime, {
      store: schedulerStore, workerId: 'observer', leaseMs: 10, batch: 1,
    });

    expect(await scheduler.tick(new Date(fireTime.getTime() + 10))).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect((await schedulerStore.listFires())[0]).toMatchObject({
      state: 'bound', runId: fire!.fireId,
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
      kernel: 'pi', createdAt: fireTime,
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
      state: 'completed',
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
      kernel: 'pi' as const, createdAt: fireTime,
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
      store: schedulerStore, workerId: 'observer', leaseMs: 10, retryDelayMs: 0, batch: 1,
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
      state: 'completed', result: { status: 'succeeded' },
    });
  });

  it('awaits scheduler shutdown before disposing the runtime in production entrypoints', async () => {
    const source = await readFile('src/index.ts', 'utf8');
    expect(source).toContain('await scheduler?.stop()');
    expect(source).not.toContain('runScheduler(');
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
