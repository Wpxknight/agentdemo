import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MemorySchedulerStore,
  MysqlSchedulerStore,
  SchedulerRunner,
  createRunDispatcher,
  type SchedulerMysqlDatabase,
  type ScheduledTask,
} from '../../packages/scheduler-runtime/src/index.js';
import type { DurableRunRuntime, StartRunInput } from '@aiop/control-contracts';
import type { Kysely } from 'kysely';
import { readMysqlConfig } from '../../src/config/mysql.js';
import { createKysely, createMysqlPool, runMigrations } from '../../src/db/index.js';

const fireTime = new Date('2026-07-29T01:00:00.000Z');
const task: ScheduledTask = {
  taskId: 'task-a',
  tenantId: 'tenant-a',
  actorId: 'user-a',
  roles: ['user'],
  sessionId: 'session-a',
  cron: '0 * * * *',
  input: [{ role: 'user', text: 'diagnose' }],
  nextFireAt: fireTime,
};

describe('SchedulerRunner', () => {
  it('dispatches a due fire once when two workers scan concurrently', async () => {
    const store = new MemorySchedulerStore([task]);
    const startScheduledRun = vi.fn(async () => ({ runId: 'run-a' }));
    const options = { store, dispatcher: { startScheduledRun }, leaseMs: 1_000 };

    const [left, right] = await Promise.all([
      new SchedulerRunner({ ...options, workerId: 'worker-a' }).tick(fireTime, 10),
      new SchedulerRunner({ ...options, workerId: 'worker-b' }).tick(fireTime, 10),
    ]);

    expect(left + right).toBe(1);
    expect(startScheduledRun).toHaveBeenCalledOnce();
    expect(startScheduledRun).toHaveBeenCalledWith({
      taskId: 'task-a',
      fireId: 'task-a:2026-07-29T01:00:00.000Z',
      fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a',
      input: [{ role: 'user', text: 'diagnose' }],
      execution: { unattended: true, preApproved: false },
    });
  });

  it('does not dispatch the same fire time twice', async () => {
    const store = new MemorySchedulerStore([task]);
    const startScheduledRun = vi.fn(async () => ({ runId: 'run-a' }));
    const runner = new SchedulerRunner({ store, dispatcher: { startScheduledRun }, workerId: 'worker-a' });

    expect(await runner.tick(fireTime, 10)).toBe(1);
    expect(await runner.tick(fireTime, 10)).toBe(0);
    expect(startScheduledRun).toHaveBeenCalledOnce();
  });

  it('releases a fire for retry when product Run creation fails', async () => {
    const store = new MemorySchedulerStore([task]);
    const startScheduledRun = vi.fn()
      .mockRejectedValueOnce(new Error('run store unavailable'))
      .mockResolvedValueOnce({ runId: 'run-b' });
    const runner = new SchedulerRunner({
      store,
      dispatcher: { startScheduledRun },
      workerId: 'worker-a',
      retryDelayMs: 1_000,
    });

    expect(await runner.tick(fireTime, 10)).toBe(1);
    expect(await runner.tick(new Date(fireTime.getTime() + 999), 10)).toBe(0);
    expect(await runner.tick(new Date(fireTime.getTime() + 1_000), 10)).toBe(1);
    expect(startScheduledRun).toHaveBeenCalledTimes(2);
    expect((await store.listFires())[0]).toMatchObject({ state: 'started', runId: 'run-b', attempts: 2 });
  });

  it('recovers an expired worker claim and compensates by creating the Run once', async () => {
    const store = new MemorySchedulerStore([task]);
    const [abandoned] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'dead-worker', leaseMs: 1_000 });
    expect(abandoned?.state).toBe('claimed');

    const recoveredAt = new Date(fireTime.getTime() + 1_001);
    const startScheduledRun = vi.fn(async () => ({ runId: 'run-recovered' }));
    const runner = new SchedulerRunner({ store, dispatcher: { startScheduledRun }, workerId: 'worker-b' });
    expect(await runner.tick(recoveredAt, 10)).toBe(1);
    expect(startScheduledRun).toHaveBeenCalledOnce();
    expect((await store.listFires())[0]).toMatchObject({ state: 'started', runId: 'run-recovered', attempts: 2 });
  });
});

describe('scheduler runtime boundaries', () => {
  it('adapts DurableRunRuntime.run into product Run dispatch', async () => {
    const run = vi.fn(async (_input: StartRunInput) => ({ runId: 'run-a' }));
    const dispatcher = createRunDispatcher({ run } as unknown as DurableRunRuntime);

    expect(await dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    })).toEqual({ runId: 'run-a' });
    expect(run).toHaveBeenCalledWith({
      runId: 'fire-a',
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a',
      input: [{ role: 'user', text: 'diagnose' }],
    });
  });

  it('preserves unattended policy selection, deadline, and cancellation when dispatching a scheduled Run', async () => {
    const run = vi.fn(async (_input: StartRunInput) => ({ runId: 'run-a' }));
    const dispatcher = createRunDispatcher({ run } as unknown as DurableRunRuntime);
    const abort = new AbortController();
    const deadlineAt = new Date('2026-07-29T01:05:00.000Z');

    await dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
      execution: { unattended: true, preApproved: true },
      limits: { deadlineAt },
      signal: abort.signal,
    } as never);

    expect(run).toHaveBeenCalledWith({
      runId: 'fire-a',
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a',
      input: [{ role: 'user', text: 'diagnose' }],
      execution: { unattended: true, preApproved: true },
      limits: { deadlineAt },
      signal: abort.signal,
    });
    abort.abort(new Error('scheduler stopped'));
    expect((run.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it('treats an existing deterministic Run as successful crash compensation', async () => {
    const run = vi.fn(async () => { throw new Error('数据库写入结果未知'); });
    const findScheduledRun = vi.fn(async () => ({ runId: 'fire-a' }));
    const dispatcher = createRunDispatcher(
      { run } as unknown as DurableRunRuntime,
      { findScheduledRun },
    );

    await expect(dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    })).resolves.toEqual({ runId: 'fire-a' });
    expect(findScheduledRun).toHaveBeenCalledWith({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    });
  });

  it('does not infer duplicate Runs from an error message', async () => {
    const error = new Error('Run already exists');
    const run = vi.fn(async () => { throw error; });
    const dispatcher = createRunDispatcher({ run } as unknown as DurableRunRuntime);

    await expect(dispatcher.startScheduledRun({
      taskId: 'task-a', fireId: 'fire-a', fireTime,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    })).rejects.toBe(error);
  });

  it('exports the consolidated MySQL scheduler store', () => {
    expect(MysqlSchedulerStore).toBeTypeOf('function');
  });

  it('keeps fire completion, durable Run association, and legacy task history in one MySQL transaction', async () => {
    const source = await readFile(new URL('../../packages/scheduler-runtime/src/mysql.ts', import.meta.url), 'utf8');
    const completeFire = source.slice(source.indexOf('async completeFire'), source.indexOf('async releaseFire'));

    expect(completeFire).toContain('transaction().execute');
    expect(completeFire).toContain("insertInto('task_runs')");
    expect(completeFire).toContain("insertInto('task_agent_runs')");
    expect(completeFire).toContain("updateTable('scheduler_fires')");
    expect(completeFire).toContain('onDuplicateKeyUpdate');
  });

  it('dispatches product Runs without importing or entering the Pi loop', async () => {
    const sourceRoot = join(process.cwd(), 'packages/scheduler-runtime/src');
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');

    expect(source).toContain('startScheduledRun');
    expect(source).not.toContain('@earendil-works/pi-agent-core');
    expect(source).not.toMatch(/resolveAgentRuntime|createAgentSession|\.prompt\s*\(/);
  });
});

describe.runIf(Boolean(process.env.MYSQL_HOST))('MysqlSchedulerStore production contract', () => {
  it('covers competing workers, stable fires, Run failure, lease recovery, and atomic associations', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const schedulerDb = db as unknown as Kysely<SchedulerMysqlDatabase>;
    const suffix = `${Date.now()}`;
    const tenantId = `scheduler-contract-${suffix}`;
    const fireAt = new Date(Date.now() - 60_000);
    const taskIds: number[] = [];
    const insertTask = async (label: string): Promise<number> => {
      const inserted = await db.insertInto('scheduled_tasks').values({
        tenant_id: tenantId, user_id: 'user-a', session_id: `session-${label}`,
        title: label, cron: '* * * * *', task: label, pre_approved: 1, enabled: 1,
        next_run_at: fireAt, last_run_at: null,
      }).executeTakeFirstOrThrow();
      const id = Number(inserted.insertId);
      taskIds.push(id);
      return id;
    };

    try {
      const firstTaskId = await insertTask('competing');
      const startScheduledRun = vi.fn(async (input: { fireId: string }) => ({ runId: input.fireId }));
      const shared = { dispatcher: { startScheduledRun }, leaseMs: 1000 };
      const [left, right] = await Promise.all([
        new SchedulerRunner({ store: new MysqlSchedulerStore(schedulerDb), workerId: 'worker-a', ...shared }).tick(fireAt, 1),
        new SchedulerRunner({ store: new MysqlSchedulerStore(schedulerDb), workerId: 'worker-b', ...shared }).tick(fireAt, 1),
      ]);
      expect(left + right).toBe(1);
      expect(startScheduledRun).toHaveBeenCalledOnce();
      expect(await db.selectFrom('scheduler_fires').selectAll().where('task_id', '=', firstTaskId).execute())
        .toHaveLength(1);
      expect(await db.selectFrom('task_agent_runs').selectAll().where('task_id', '=', firstTaskId).execute())
        .toHaveLength(1);
      expect(await db.selectFrom('task_runs').selectAll().where('task_id', '=', firstTaskId).execute())
        .toEqual([expect.objectContaining({ status: 'success', run_id: expect.any(String), fire_id: expect.any(String) })]);

      const failedTaskId = await insertTask('retry');
      const retryDispatcher = vi.fn()
        .mockRejectedValueOnce(new Error('Run creation failed'))
        .mockImplementation(async (input: { fireId: string }) => ({ runId: input.fireId }));
      const retryRunner = new SchedulerRunner({
        store: new MysqlSchedulerStore(schedulerDb), dispatcher: { startScheduledRun: retryDispatcher },
        workerId: 'worker-retry', retryDelayMs: 10,
      });
      expect(await retryRunner.tick(fireAt, 1)).toBe(1);
      expect(await db.selectFrom('scheduler_fires').select(['state', 'last_error'])
        .where('task_id', '=', failedTaskId).executeTakeFirst()).toMatchObject({ state: 'pending' });
      expect(await retryRunner.tick(new Date(fireAt.getTime() + 10), 1)).toBe(1);
      expect(retryDispatcher).toHaveBeenCalledTimes(2);

      const recoveredTaskId = await insertTask('recovery');
      const abandonedStore = new MysqlSchedulerStore(schedulerDb);
      const [abandoned] = await abandonedStore.claimDue({ now: fireAt, limit: 1, workerId: 'dead', leaseMs: 10 });
      expect(abandoned?.taskId).toBe(String(recoveredTaskId));
      const recoveredDispatcher = vi.fn(async (input: { fireId: string }) => ({ runId: input.fireId }));
      const recoveryRunner = new SchedulerRunner({
        store: new MysqlSchedulerStore(schedulerDb), dispatcher: { startScheduledRun: recoveredDispatcher }, workerId: 'recovery',
      });
      expect(await recoveryRunner.tick(new Date(fireAt.getTime() + 11), 1)).toBe(1);
      expect(recoveredDispatcher).toHaveBeenCalledOnce();
    } finally {
      if (taskIds.length) {
        await db.deleteFrom('task_runs').where('task_id', 'in', taskIds).execute();
        await db.deleteFrom('task_agent_runs').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('scheduler_fires').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('scheduled_tasks').where('tenant_id', '=', tenantId).execute();
      }
      await db.destroy();
    }
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}
