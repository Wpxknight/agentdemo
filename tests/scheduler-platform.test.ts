import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../packages/scheduler-core/src/index.js';

describe('Scheduler core', () => {
  it('only claims due tasks, creates agent runs and records task links', async () => {
    const run = vi.fn(async () => ({ runId: 'run-a', status: 'queued' as const, events: emptyEvents(), result: vi.fn() }));
    const recordRunLink = vi.fn();
    const scheduler = new Scheduler({
      store: {
        claimDue: async () => [{
          taskId: 'task-a', tenantId: 'tenant-a', actorId: 'user-a', sessionId: 'session-a', input: 'diagnose',
        }],
        recordRunLink,
      },
      runtime: { run, resume: vi.fn(), cancel: vi.fn() },
    });
    expect(await scheduler.tick(new Date('2026-07-27T00:00:00Z'), 10)).toBe(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a', input: [{ role: 'user', text: 'diagnose' }] }));
    expect(recordRunLink).toHaveBeenCalledWith({ taskId: 'task-a', tenantId: 'tenant-a', runId: 'run-a' });
  });
});

async function* emptyEvents() { return; }
