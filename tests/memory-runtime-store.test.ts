import { describe, expect, it } from 'vitest';
import { MemoryRuntimeStore } from '../packages/agent-runtime-core/src/memory-store.js';
import type { RunRecord, TurnSnapshot } from '../packages/agent-runtime-core/src/store.js';

const identity = { tenantId: 'tenant-a', runId: 'run-a' } as const;

function run(): RunRecord {
  const now = new Date('2026-07-27T00:00:00.000Z');
  return {
    ...identity, actorId: 'user-a', sessionId: 'session-a', kernel: 'pi', kernelVersion: '0.82.1',
    runtimeVersion: '1', status: 'queued', leaseToken: 0n,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    createdAt: now, updatedAt: now,
  };
}

function snapshot(turnNo = 1): TurnSnapshot {
  return {
    ...identity, attemptId: 'attempt-a', turnNo, sessionVersion: BigInt(turnNo - 1),
    identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
    modelBinding: { provider: 'fake', model: 'fake-1' }, promptVersion: 'prompt-v1',
    toolSetVersion: 'tools-v1', policyVersion: 'policy-v1', messages: [],
    createdAt: new Date(`2026-07-27T00:00:0${turnNo}.000Z`),
  };
}

describe('MemoryRuntimeStore', () => {
  it('keeps turn snapshots immutable', async () => {
    const store = new MemoryRuntimeStore();
    await store.runs.create(run());
    await store.turns.createSnapshot(snapshot());
    await expect(store.turns.createSnapshot({ ...snapshot(), promptVersion: 'changed' }))
      .rejects.toThrow('immutable');
    expect((await store.turns.getSnapshot({ ...identity, attemptId: 'attempt-a', turnNo: 1 }))?.promptVersion)
      .toBe('prompt-v1');
  });

  it('commits messages, events and run state atomically with per-run sequence', async () => {
    const store = new MemoryRuntimeStore();
    await store.runs.create(run());
    await store.runs.acquireLease(identity, 'worker-a', new Date('2026-07-27T00:00:00Z'), 10_000);
    const turn = snapshot();
    await store.turns.createSnapshot(turn);
    const committed = await store.turns.commit({
      leaseOwner: 'worker-a',
      leaseToken: 1n,
      snapshot: turn,
      commit: {
        ...identity, attemptId: 'attempt-a', turnNo: 1, commitId: 'commit-a', transcriptVersion: 1n,
        usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
        messages: [], committedAt: new Date('2026-07-27T00:00:02.000Z'),
      },
      events: [
        {
          ...identity, attemptId: 'attempt-a', turnNo: 1, kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'corr-a',
          type: 'turn', detail: { phase: 'started' }, createdAt: new Date('2026-07-27T00:00:01.000Z'),
        },
        {
          ...identity, attemptId: 'attempt-a', turnNo: 1, kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'corr-a',
          type: 'turn', detail: { phase: 'committed' }, createdAt: new Date('2026-07-27T00:00:02.000Z'),
        },
      ],
      runStatus: 'succeeded',
    });
    expect(committed.eventSequenceEnd).toBe(2n);
    expect((await store.events.list(identity)).map((event) => event.sequence)).toEqual([1n, 2n]);
    expect((await store.runs.get(identity))?.status).toBe('succeeded');
    expect((await store.turns.getLastCommitted(identity))?.commitId).toBe('commit-a');

    const secondTurn = snapshot(2);
    await store.turns.createSnapshot(secondTurn);
    await store.turns.commit({
      leaseOwner: 'worker-a', leaseToken: 1n, snapshot: secondTurn,
      commit: {
        ...identity, attemptId: 'attempt-a', turnNo: 2, commitId: 'commit-b', transcriptVersion: 2n,
        usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        messages: [], committedAt: new Date('2026-07-27T00:00:03.000Z'),
      },
      events: [], runStatus: 'succeeded',
    });
    expect((await store.turns.listCommitted(identity)).map((turn) => turn.commitId)).toEqual(['commit-a', 'commit-b']);
  });

  it('rolls back every repository when a transaction fails', async () => {
    const store = new MemoryRuntimeStore();
    await expect(store.transaction(async (tx) => {
      await tx.runs.create(run());
      await tx.turns.createSnapshot(snapshot());
      throw new Error('fault injection');
    })).rejects.toThrow('fault injection');
    expect(await store.runs.get(identity)).toBeUndefined();
    expect(await store.turns.getSnapshot({ ...identity, attemptId: 'attempt-a', turnNo: 1 })).toBeUndefined();
  });

  it('rejects stale fencing tokens after a lease is reacquired', async () => {
    const store = new MemoryRuntimeStore();
    await store.runs.create(run());
    const first = await store.runs.acquireLease(identity, 'worker-a', new Date('2026-07-27T00:00:00Z'), 10);
    const second = await store.runs.acquireLease(identity, 'worker-b', new Date('2026-07-27T00:00:00.011Z'), 10);
    expect(first?.token).toBe(1n);
    expect(second?.token).toBe(2n);
    await expect(store.runs.assertLease(identity, 'worker-a', 1n, new Date('2026-07-27T00:00:00.012Z')))
      .rejects.toThrow('LEASE_LOST');
  });

  it('rejects a turn commit made with a stale fencing token', async () => {
    const store = new MemoryRuntimeStore();
    await store.runs.create(run());
    await store.runs.acquireLease(identity, 'worker-a', new Date('2026-07-27T00:00:00Z'), 10);
    await store.runs.acquireLease(identity, 'worker-b', new Date('2026-07-27T00:00:00.011Z'), 10_000);
    const turn = snapshot();
    await store.turns.createSnapshot(turn);
    await expect(store.turns.commit({
      leaseOwner: 'worker-a', leaseToken: 1n, snapshot: turn,
      commit: {
        ...identity, attemptId: 'attempt-a', turnNo: 1, commitId: 'stale', transcriptVersion: 1n,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        messages: [], committedAt: new Date('2026-07-27T00:00:01Z'),
      },
      events: [], runStatus: 'succeeded',
    })).rejects.toThrow('LEASE_LOST');
  });
});
