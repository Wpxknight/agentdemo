import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MemorySchedulerStore,
  MysqlSchedulerStore,
  SchedulerRunner,
  createRunDispatcher,
  type ScheduledTask,
} from '../../packages/scheduler-runtime/src/index.js';
import type { DurableRunRuntime } from '@aiop/control-contracts';

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
    const run = vi.fn(async () => ({ runId: 'run-a' }));
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

  it('dispatches product Runs without importing or entering the Pi loop', async () => {
    const sourceRoot = join(process.cwd(), 'packages/scheduler-runtime/src');
    const files = await sourceFiles(sourceRoot);
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');

    expect(source).toContain('startScheduledRun');
    expect(source).not.toContain('@earendil-works/pi-agent-core');
    expect(source).not.toMatch(/resolveAgentRuntime|createAgentSession|\.prompt\s*\(/);
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
