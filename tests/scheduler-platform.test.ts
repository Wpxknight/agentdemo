import { describe, expect, it, vi } from 'vitest';
import { MemorySchedulerStore, SchedulerRunner } from '../packages/scheduler-runtime/src/index.js';

describe('Scheduler runtime package', () => {
  it('only claims due fires and asks the dispatcher to create product Runs', async () => {
    const fireTime = new Date('2026-07-27T00:00:00Z');
    const store = new MemorySchedulerStore([{
      taskId: 'task-a', tenantId: 'tenant-a', actorId: 'user-a', sessionId: 'session-a',
      cron: '0 * * * *', input: [{ role: 'user', text: 'diagnose' }], nextFireAt: fireTime,
    }]);
    const startScheduledRun = vi.fn(async (_input, onStarted) => {
      await onStarted?.('run-a');
      return {
        runId: 'run-a',
        result: {
          runId: 'run-a', status: 'succeeded' as const,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        },
      };
    });
    const scheduler = new SchedulerRunner({ store, dispatcher: { startScheduledRun }, workerId: 'worker-a' });

    expect(await scheduler.tick(fireTime, 10)).toBe(1);
    expect(startScheduledRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }],
    }), expect.any(Function));
    expect((await store.listFires())[0]).toMatchObject({ state: 'started', runId: 'run-a' });
  });
});
