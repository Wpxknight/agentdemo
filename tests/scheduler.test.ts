import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/db/memory.js';
import { Scheduler } from '../src/scheduler/ticker.js';
import { isValidCron, nextRunAt } from '../src/scheduler/cron.js';
import { buildScheduleTools } from '../src/tools/schedule.js';
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
    const runs = await store.listTaskRuns(rctx, 1);
    expect(runs).toEqual([{ taskId: 1, status: 'success', detail: 'ok', steps: 2 }]);
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
