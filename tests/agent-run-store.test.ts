import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/db/memory.js';
import type { RequestContext } from '../src/auth/types.js';
import type { AgentRunBinding } from '../src/db/store.js';

const userA: RequestContext = { tenantId: 'tenant-a', userId: 'user-a', role: 'user' };
const userB: RequestContext = { tenantId: 'tenant-a', userId: 'user-b', role: 'user' };
const tenantAdmin: RequestContext = { tenantId: 'tenant-a', userId: 'admin-a', role: 'tenant_admin' };
const otherTenant: RequestContext = { tenantId: 'tenant-b', userId: 'admin-b', role: 'tenant_admin' };

function binding(runId: string, userId = 'user-a', tenantId = 'tenant-a'): AgentRunBinding {
  return {
    tenantId,
    userId,
    sessionId: `session-${runId}`,
    runId,
    kernel: 'pi',
    graphName: 'aiop-agent',
    graphVersion: 'v1',
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
  };
}

describe('Agent run Store contract', () => {
  it('creates a queued lifecycle record and enforces user/tenant read scope', async () => {
    const store = new MemoryStore();
    await store.putAgentRunBindingIfAbsent(binding('run-a'));
    await store.putAgentRunBindingIfAbsent(binding('run-b', 'user-b'));
    await store.putAgentRunBindingIfAbsent(binding('run-c', 'user-c', 'tenant-b'));

    expect(await store.getAgentRun(userA, 'run-a')).toMatchObject({
      runId: 'run-a', status: 'queued', stepCount: 0, leaseToken: 0,
    });
    expect(await store.getAgentRun(userB, 'run-a')).toBeUndefined();
    expect((await store.listAgentRuns(userA)).map((run) => run.runId)).toEqual(['run-a']);
    expect((await store.listAgentRuns(tenantAdmin)).map((run) => run.runId).sort()).toEqual(['run-a', 'run-b']);
    expect(await store.getAgentRun(otherTenant, 'run-a')).toBeUndefined();
  });

  it('updates lifecycle fields and filters paginated results', async () => {
    const store = new MemoryStore();
    await store.putAgentRunBindingIfAbsent(binding('run-a'));
    await store.putAgentRunBindingIfAbsent(binding('run-b'));
    await store.updateAgentRun('tenant-a', 'run-a', {
      status: 'running', currentNode: 'model', stepCount: 2,
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 1 },
      startedAt: new Date('2026-07-22T00:01:00.000Z'),
      updatedAt: new Date('2026-07-22T00:02:00.000Z'),
    });

    expect(await store.getAgentRun(userA, 'run-a')).toMatchObject({
      status: 'running', currentNode: 'model', stepCount: 2,
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 1 },
    });
    expect(await store.countAgentRuns(userA, { status: 'running' })).toBe(1);
    expect((await store.listAgentRuns(userA, { status: 'running', limit: 1, offset: 0 }))[0]?.runId).toBe('run-a');
  });

  it('appends an ordered timeline and exposes run-scoped interaction/tool records', async () => {
    const store = new MemoryStore();
    await store.putAgentRunBindingIfAbsent(binding('run-a'));
    await store.appendAgentRunEvent({
      tenantId: 'tenant-a', runId: 'run-a', type: 'node', node: 'prepare', status: 'started',
      detail: { attempt: 1 }, createdAt: new Date('2026-07-22T00:00:01.000Z'),
    });
    await store.appendAgentRunEvent({
      tenantId: 'tenant-a', runId: 'run-a', type: 'node', node: 'prepare', status: 'completed',
      createdAt: new Date('2026-07-22T00:00:02.000Z'),
    });
    await store.putInteraction({
      id: 'interaction-a', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-run-a', runId: 'run-a',
      kind: 'approval', payload: {}, status: 'pending', expiresAt: new Date('2026-07-23T00:00:00.000Z'),
      createdAt: new Date('2026-07-22T00:00:03.000Z'),
    });
    await store.putToolExecutionIfAbsent({
      tenantId: 'tenant-a', runId: 'run-a', sessionId: 'session-run-a', toolCallId: 'tool-a', toolName: 'echo',
      argsDigest: 'digest', status: 'completed', result: { id: 'tool-a', content: 'ok' },
      startedAt: new Date('2026-07-22T00:00:04.000Z'), completedAt: new Date('2026-07-22T00:00:05.000Z'),
      updatedAt: new Date('2026-07-22T00:00:05.000Z'),
    });

    expect((await store.listAgentRunEvents(userA, 'run-a')).map((event) => event.status)).toEqual(['started', 'completed']);
    expect((await store.listAgentRunInteractions(userA, 'run-a')).map((item) => item.id)).toEqual(['interaction-a']);
    expect((await store.listAgentRunToolExecutions(userA, 'run-a')).map((item) => item.toolCallId)).toEqual(['tool-a']);
    expect(await store.listAgentRunEvents(userB, 'run-a')).toEqual([]);
  });

  it('acquires, renews, expires and fences leases with monotonic tokens', async () => {
    const store = new MemoryStore();
    await store.putAgentRunBindingIfAbsent(binding('run-a'));
    const started = new Date('2026-07-22T00:00:00.000Z');
    const first = await store.acquireAgentRunLease('tenant-a', 'run-a', 'owner-a', started, 30_000);

    expect(first).toMatchObject({ token: 1, ownerId: 'owner-a' });
    expect(await store.acquireAgentRunLease('tenant-a', 'run-a', 'owner-b', started, 30_000)).toBeUndefined();
    await expect(store.assertAgentRunLease('tenant-a', 'run-a', 'owner-a', first!.token, started)).resolves.toBeUndefined();
    await store.renewAgentRunLease('tenant-a', 'run-a', 'owner-a', first!.token, new Date('2026-07-22T00:00:10.000Z'), 30_000);

    const takeover = await store.acquireAgentRunLease(
      'tenant-a', 'run-a', 'owner-b', new Date('2026-07-22T00:00:41.000Z'), 30_000,
    );
    expect(takeover).toMatchObject({ token: 2, ownerId: 'owner-b' });
    await expect(store.assertAgentRunLease(
      'tenant-a', 'run-a', 'owner-a', first!.token, new Date('2026-07-22T00:00:41.000Z'),
    )).rejects.toThrow(/lease/i);
  });

  it('persists cancellation and clears leases on terminal transition', async () => {
    const store = new MemoryStore();
    await store.putAgentRunBindingIfAbsent(binding('run-a'));
    const now = new Date('2026-07-22T00:00:00.000Z');
    const lease = await store.acquireAgentRunLease('tenant-a', 'run-a', 'owner-a', now, 30_000);
    expect(await store.requestAgentRunCancellation(userA, 'run-a', new Date('2026-07-22T00:00:01.000Z'))).toBe(true);
    expect(await store.isAgentRunCancellationRequested('tenant-a', 'run-a')).toBe(true);

    await store.updateAgentRun('tenant-a', 'run-a', {
      status: 'cancelled', completedAt: new Date('2026-07-22T00:00:02.000Z'),
      updatedAt: new Date('2026-07-22T00:00:02.000Z'), clearLease: true,
    });
    await expect(store.assertAgentRunLease('tenant-a', 'run-a', 'owner-a', lease!.token, now)).rejects.toThrow(/lease/i);
    expect((await store.getAgentRun(userA, 'run-a'))?.status).toBe('cancelled');
  });
});
