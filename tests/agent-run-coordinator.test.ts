import { describe, expect, it } from 'vitest';
import { AgentRunCancelledError, AgentRunCoordinator, AgentRunLeaseLostError } from '../src/agent/run-coordinator.js';
import { RecoveryRequiredError } from '../src/agent/tool-ledger/store.js';
import { MemoryStore } from '../src/db/memory.js';
import type { RequestContext } from '../src/auth/types.js';

const ctx: RequestContext = { tenantId: 'tenant-a', userId: 'user-a', role: 'user' };

async function seededStore(runId = 'run-a') {
  const store = new MemoryStore();
  await store.putAgentRunBindingIfAbsent({
    tenantId: ctx.tenantId, userId: ctx.userId, sessionId: 'session-a', runId,
    kernel: 'langgraph', graphName: 'aiop-agent', graphVersion: 'v1',
    createdAt: new Date('2026-07-22T00:00:00.000Z'),
  });
  return store;
}

describe('AgentRunCoordinator', () => {
  it('records lifecycle, node timeline and terminal usage', async () => {
    const store = await seededStore();
    let nowMs = Date.parse('2026-07-22T00:01:00.000Z');
    const coordinator = new AgentRunCoordinator(store, {
      ownerId: 'owner-a', now: () => new Date(nowMs), leaseTtlMs: 30_000, heartbeatMs: 0,
    });
    const execution = await coordinator.start(ctx, 'run-a');
    await execution.guard();
    await execution.nodeStarted('model');
    nowMs += 1_000;
    await execution.nodeCompleted('model', { steps: 1 });
    await execution.succeed({
      messages: [], text: 'ok', steps: 1, compacted: false,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 1 },
    });

    expect(await store.getAgentRun(ctx, 'run-a')).toMatchObject({
      status: 'succeeded', currentNode: undefined, stepCount: 1,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 1 },
      leaseOwner: undefined,
    });
    expect((await store.listAgentRunEvents(ctx, 'run-a')).map((event) => `${event.type}:${event.status}`)).toEqual([
      'run:running', 'node:started', 'node:completed', 'run:succeeded',
    ]);
  });

  it('rejects a competing owner and fences a stale execution after takeover', async () => {
    const store = await seededStore();
    let nowMs = Date.parse('2026-07-22T00:01:00.000Z');
    const first = new AgentRunCoordinator(store, {
      ownerId: 'owner-a', now: () => new Date(nowMs), leaseTtlMs: 10_000, heartbeatMs: 0,
    });
    const second = new AgentRunCoordinator(store, {
      ownerId: 'owner-b', now: () => new Date(nowMs), leaseTtlMs: 10_000, heartbeatMs: 0,
    });
    const execution = await first.start(ctx, 'run-a');
    await expect(second.start(ctx, 'run-a')).rejects.toBeInstanceOf(AgentRunLeaseLostError);

    nowMs += 11_000;
    const takeover = await second.start(ctx, 'run-a');
    await expect(execution.guard()).rejects.toBeInstanceOf(AgentRunLeaseLostError);
    await takeover.fail(new Error('stop'));
  });

  it('observes durable cancellation at a guard boundary', async () => {
    const store = await seededStore();
    const coordinator = new AgentRunCoordinator(store, { ownerId: 'owner-a', heartbeatMs: 0 });
    const execution = await coordinator.start(ctx, 'run-a');
    await store.requestAgentRunCancellation(ctx, 'run-a');

    await expect(execution.guard()).rejects.toBeInstanceOf(AgentRunCancelledError);
    await execution.fail(new AgentRunCancelledError());
    expect((await store.getAgentRun(ctx, 'run-a'))?.status).toBe('cancelled');
  });

  it('classifies uncertain tool outcomes as recovery_required and redacts long errors', async () => {
    const store = await seededStore();
    const coordinator = new AgentRunCoordinator(store, { ownerId: 'owner-a', heartbeatMs: 0 });
    const execution = await coordinator.start(ctx, 'run-a');
    await execution.fail(new RecoveryRequiredError(`secret-token ${'x'.repeat(3_000)}`));

    const run = await store.getAgentRun(ctx, 'run-a');
    expect(run?.status).toBe('recovery_required');
    expect(run?.errorMessage).not.toContain('secret-token');
    expect(run?.errorMessage?.length).toBeLessThanOrEqual(1_024);
  });
});
