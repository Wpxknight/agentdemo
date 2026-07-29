import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LeaseLostError } from '@aiop/control-contracts';
import {
  createMysqlDurablePiRuntime, DurableRunManager, GovernedToolOutcomeError, MemoryRunStore, MysqlRunStore,
  piSessionStorageId,
} from '../../packages/pi-runtime/src/index.js';
import type { ManagedPiSession } from '../../packages/pi-runtime/src/index.js';
import type { AgentRunEvent } from '@aiop/control-contracts';
import type { DurableRunStore } from '../../packages/pi-runtime/src/index.js';
import { readMysqlConfig } from '../../src/config/mysql.js';
import { createKysely, createMysqlPool, runMigrations } from '../../src/db/index.js';

const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe('MemoryRunStore durable contract', () => {
  it('claims a resolved interaction when JSON object keys were inserted in a different order', async () => {
    const store = new MemoryRunStore();
    const runId = 'canonical-resolution-claim';
    const now = new Date('2026-07-30T00:00:00.000Z');
    await store.create({ record: {
      tenantId: identity.tenantId, runId, actorId: identity.actorId, sessionId: 'canonical-resolution-session',
      kernel: 'pi', kernelVersion: '0.82.1', status: 'waiting', waitingReason: 'approval', leaseToken: 0n,
      usage, createdAt: now, updatedAt: now,
    } });
    await store.interactions.put({
      tenantId: identity.tenantId, runId, id: 'canonical-resolution', attemptId: 'attempt-a', turnNo: 1,
      kind: 'approval', toolCallId: 'call-a', status: 'resolved', payload: {},
      resolution: { approved: true, audit: { actor: 'user-a', source: 'ui' } }, createdAt: now, resolvedAt: now,
    });

    await expect(store.claim({
      identity, runId, workerId: 'worker-a', now, leaseTtlMs: 1_000, resume: true,
      resolution: {
        interactionId: 'canonical-resolution',
        value: { audit: { source: 'ui', actor: 'user-a' }, approved: true },
      },
    })).resolves.toMatchObject({ record: { status: 'running' } });
  });

  it('isolates same-named sessions by run owner', async () => {
    const store = new MemoryRunStore();
    const now = new Date('2026-07-29T00:00:00.000Z');
    for (const actorId of ['user-a', 'user-b']) {
      await expect(store.create({ record: {
        tenantId: 'tenant-a', runId: `run-${actorId}`, actorId, sessionId: 'shared-session', kernel: 'pi',
        kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
      } })).resolves.toMatchObject({ sessionCreated: true });
    }

    expect(await store.sessions.get('tenant-a', piSessionStorageId('user-a', 'shared-session'))).toBeDefined();
    expect(await store.sessions.get('tenant-a', piSessionStorageId('user-b', 'shared-session'))).toBeDefined();
  });

  it('fences a stale worker from committing after another worker reclaims the lease', async () => {
    const store = new MemoryRunStore();
    const createdAt = new Date('2026-07-28T00:00:00.000Z');
    await store.create({ record: {
      tenantId: identity.tenantId, runId: 'run-a', actorId: identity.actorId, sessionId: 'session-a',
      kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt, updatedAt: createdAt,
    } });
    const first = await store.claim({ identity, runId: 'run-a', workerId: 'worker-a', now: createdAt, leaseTtlMs: 10 });
    const second = await store.claim({
      identity, runId: 'run-a', workerId: 'worker-b', now: new Date(createdAt.getTime() + 11), leaseTtlMs: 10,
    });
    expect(first?.fencingToken).toBe(1n);
    expect(second?.fencingToken).toBe(2n);
    await expect(store.commitTurn({
      tenantId: 'tenant-a', runId: 'run-a', attemptId: first!.attemptId, turnNo: 1,
      fencingToken: first!.fencingToken, checkpoint: { leafId: 'leaf-stale' }, events: [], status: 'running', usage,
      committedAt: new Date(createdAt.getTime() + 11),
    })).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('does not let a stale recovery token overwrite a newer waiting state', async () => {
    const store = new MemoryRunStore();
    const startedAt = new Date('2026-07-29T00:00:00.000Z');
    const runId = 'stale-recovery-token';
    await store.create({ record: {
      tenantId: identity.tenantId, runId, actorId: identity.actorId, sessionId: 'stale-recovery-session',
      kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage,
      createdAt: startedAt, updatedAt: startedAt,
    } });
    const first = await store.claim({ identity, runId, workerId: 'worker-a', now: startedAt, leaseTtlMs: 10 });
    const reclaimedAt = new Date(startedAt.getTime() + 11);
    const second = await store.claim({ identity, runId, workerId: 'worker-b', now: reclaimedAt, leaseTtlMs: 1000 });
    await store.commitTurn({
      tenantId: identity.tenantId, runId, attemptId: second!.attemptId, turnNo: 1,
      fencingToken: second!.fencingToken, checkpoint: {}, events: [], status: 'waiting', waitingReason: 'approval', usage,
      committedAt: new Date(reclaimedAt.getTime() + 1),
    });

    await expect(store.markRecoveryRequired({
      identity, runId, errorMessage: 'delayed worker-a failure', failedAt: new Date(reclaimedAt.getTime() + 2),
      expectedLease: { ownerId: 'worker-a', token: first!.fencingToken },
    })).resolves.toBe(false);
    await expect(store.get({ tenantId: identity.tenantId, runId })).resolves.toMatchObject({
      status: 'waiting', waitingReason: 'approval', leaseToken: second!.fencingToken,
    });
  });

  it('never resolves a run through a different tenant', async () => {
    const store = new MemoryRunStore();
    const now = new Date();
    await store.create({ record: {
      tenantId: 'tenant-a', runId: 'same-id', actorId: 'user-a', sessionId: 'session-a', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    await expect(store.get({ tenantId: 'tenant-b', runId: 'same-id' })).resolves.toBeUndefined();
  });

  it('enforces lease expiry for commit, complete, and inbox acknowledgement', async () => {
    const start = new Date('2026-07-28T00:00:00.000Z');
    const expired = new Date(start.getTime() + 11);
    const store = new MemoryRunStore(() => expired);
    const runId = 'expired-mutations';
    await store.create({ record: {
      tenantId: identity.tenantId, runId, actorId: identity.actorId, sessionId: 'expired-session', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: start, updatedAt: start,
    } });
    const claim = await store.claim({ identity, runId, workerId: 'worker-a', now: start, leaseTtlMs: 10 });
    const inbox = await store.inbox.enqueue({
      identity, tenantId: identity.tenantId, runId, idempotencyKey: 'expired', mode: 'steer',
      message: { role: 'user', text: 'late' }, createdAt: start,
    } as never);
    const claimedInbox = await store.inbox.claimNext({
      tenantId: identity.tenantId, runId, workerId: 'worker-a', fencingToken: claim!.fencingToken,
      now: start, claimTtlMs: 100,
    });
    expect(claimedInbox?.id).toBe(inbox.id);

    await expect(store.commitTurn({
      tenantId: identity.tenantId, runId, attemptId: claim!.attemptId, turnNo: 1,
      fencingToken: claim!.fencingToken, checkpoint: {}, events: [], status: 'running', usage, committedAt: expired,
    } as never)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.complete({
      tenantId: identity.tenantId, runId, attemptId: claim!.attemptId, fencingToken: claim!.fencingToken,
      status: 'failed', usage, completedAt: expired,
    })).rejects.toBeInstanceOf(LeaseLostError);
    const { sequence: _sequence, ...expiredEvent } = toolEvent('tool_execution_start', 'expired-tool-call');
    await expect(store.appendEvents({
      tenantId: identity.tenantId, runId, attemptId: claim!.attemptId, fencingToken: claim!.fencingToken,
      events: [expiredEvent], appendedAt: expired,
    })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.inbox.markConsumed({
      tenantId: identity.tenantId, runId, id: inbox.id, claimToken: claimedInbox!.claimToken!, workerId: 'worker-a',
      fencingToken: claim!.fencingToken, now: expired, consumedAt: expired, claimTtlMs: 100,
    })).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('uses the Run Center owner-or-admin authorization rule atomically', async () => {
    const store = new MemoryRunStore();
    const now = new Date();
    const runId = 'authorized-run';
    await store.create({ record: {
      tenantId: identity.tenantId, runId, actorId: identity.actorId, sessionId: 'authorized-session', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    const admin = { tenantId: identity.tenantId, actorId: 'admin-a', roles: ['tenant_admin'] } as const;
    const outsider = { tenantId: identity.tenantId, actorId: 'user-b', roles: ['user'] } as const;

    await expect(store.claim({ identity: outsider, runId, workerId: 'outsider', now, leaseTtlMs: 1000 })).resolves.toBeNull();
    const claim = await store.claim({ identity: admin, runId, workerId: 'admin', now, leaseTtlMs: 1000 });
    expect(claim).not.toBeNull();
    await expect(store.requestCancellation({ identity: admin, runId, requestedAt: now })).resolves.toBeUndefined();
  });

  it('reopens a failed run only through an explicit authorized resume claim', async () => {
    const store = new MemoryRunStore();
    const now = new Date('2026-07-28T00:00:00.000Z');
    const runId = 'explicit-failed-resume';
    await store.create({ record: {
      tenantId: identity.tenantId, runId, actorId: identity.actorId, sessionId: 'failed-resume-session', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    const first = await store.claim({ identity, runId, workerId: 'worker-a', now, leaseTtlMs: 1000 });
    const failedAt = new Date(now.getTime() + 1);
    await store.complete({
      tenantId: identity.tenantId, runId, attemptId: first!.attemptId, fencingToken: first!.fencingToken,
      status: 'failed', usage, completedAt: failedAt,
    });
    expect((await store.get({ tenantId: identity.tenantId, runId }))?.appendClosedAt).toEqual(failedAt);
    await expect(store.claim({
      identity, runId, workerId: 'ordinary-claim', now: new Date(now.getTime() + 2), leaseTtlMs: 1000,
    })).resolves.toBeNull();

    const admin = { tenantId: identity.tenantId, actorId: 'admin-a', roles: ['tenant_admin'] } as const;
    const resumed = await store.claim({
      identity: admin, runId, workerId: 'resume-worker', now: new Date(now.getTime() + 3), leaseTtlMs: 1000, resume: true,
    });
    expect(resumed?.record.status).toBe('running');
    expect((await store.get({ tenantId: identity.tenantId, runId }))?.appendClosedAt).toBeUndefined();
  });

  it('rejects resuming an old failed run when its session has a newer active run', async () => {
    const store = new MemoryRunStore();
    const now = new Date('2026-07-28T00:00:00.000Z');
    const oldRunId = 'old-failed-run';
    const sessionId = 'shared-resume-session';
    await store.create({ record: {
      tenantId: identity.tenantId, runId: oldRunId, actorId: identity.actorId, sessionId, kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    const oldClaim = await store.claim({ identity, runId: oldRunId, workerId: 'old-worker', now, leaseTtlMs: 1000 });
    await store.complete({
      tenantId: identity.tenantId, runId: oldRunId, attemptId: oldClaim!.attemptId,
      fencingToken: oldClaim!.fencingToken, status: 'failed', usage, completedAt: new Date(now.getTime() + 1),
    });
    await store.create({ record: {
      tenantId: identity.tenantId, runId: 'new-active-run', actorId: identity.actorId, sessionId, kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage,
      createdAt: new Date(now.getTime() + 2), updatedAt: new Date(now.getTime() + 2),
    } });

    await expect(store.claim({
      identity, runId: oldRunId, workerId: 'resume-worker', now: new Date(now.getTime() + 3),
      leaseTtlMs: 1000, resume: true,
    })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
    expect((await store.get({ tenantId: identity.tenantId, runId: oldRunId }))?.status).toBe('failed');
  });

  it('exposes a fenced append cutoff operation on both stores', () => {
    expect(typeof (new MemoryRunStore() as any).closeInbox).toBe('function');
    expect(typeof (new MysqlRunStore({} as never) as any).closeInbox).toBe('function');
    expect(typeof (new MemoryRunStore() as any).appendEvents).toBe('function');
    expect(typeof (new MysqlRunStore({} as never) as any).appendEvents).toBe('function');
  });

  it('runs transaction-scoped create and inbox mutations without self-deadlocking', async () => {
    const store = new MemoryRunStore();
    const now = new Date('2026-07-29T12:00:00.000Z');
    const work = store.transaction(async (tx) => {
      await tx.create({ record: {
        tenantId: identity.tenantId, runId: 'tx-create-run', actorId: identity.actorId, sessionId: 'tx-session',
        kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
      } });
      return tx.inbox.enqueue({
        identity, tenantId: identity.tenantId, runId: 'tx-create-run', idempotencyKey: 'tx-message',
        mode: 'steer', message: { role: 'user', text: 'inside transaction' }, createdAt: now,
      });
    });

    await expect(Promise.race([
      work,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('transaction deadlocked')), 100)),
    ])).resolves.toMatchObject({ idempotencyKey: 'tx-message' });
  });

  it('does not erase a concurrent successful mutation when another transaction rolls back', async () => {
    const store = new MemoryRunStore();
    let transactionEntered!: () => void;
    const entered = new Promise<void>((resolve) => { transactionEntered = resolve; });
    let rejectTransaction!: () => void;
    const rejectGate = new Promise<void>((resolve) => { rejectTransaction = resolve; });
    const record = (id: string) => ({
      id, tenantId: identity.tenantId, runId: 'rollback-run', attemptId: 'attempt-a', turnNo: 1,
      kind: 'approval' as const, status: 'pending' as const, payload: {}, createdAt: new Date(),
    });
    const failing = store.transaction(async (tx) => {
      await tx.interactions.put(record('rolled-back'));
      transactionEntered();
      await rejectGate;
      throw new Error('rollback');
    });
    await entered;
    const successful = store.interactions.put(record('concurrent-success'));
    rejectTransaction();

    await expect(failing).rejects.toThrow('rollback');
    await successful;
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'rollback-run', interactionId: 'concurrent-success',
    })).resolves.toMatchObject({ id: 'concurrent-success' });
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'rollback-run', interactionId: 'rolled-back',
    })).resolves.toBeUndefined();
  });

  it('invalidates escaped transaction contexts before a later rollback', async () => {
    const store = new MemoryRunStore();
    let releaseDescendant!: () => void;
    const descendantGate = new Promise<void>((resolve) => { releaseDescendant = resolve; });
    let descendantAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => { descendantAttempted = resolve; });
    const record = (id: string) => ({
      id, tenantId: identity.tenantId, runId: 'escaped-context-run', attemptId: 'attempt-a', turnNo: 1,
      kind: 'approval' as const, status: 'pending' as const, payload: {}, createdAt: new Date(),
    });
    let descendant!: Promise<void>;

    await store.transaction(async () => {
      descendant = descendantGate.then(async () => {
        descendantAttempted();
        await store.interactions.put(record('descendant-write'));
      });
    });

    let rollbackEntered!: () => void;
    const entered = new Promise<void>((resolve) => { rollbackEntered = resolve; });
    let rejectRollback!: () => void;
    const rollbackGate = new Promise<void>((resolve) => { rejectRollback = resolve; });
    const rollingBack = store.transaction(async (tx) => {
      await tx.interactions.put(record('rolled-back'));
      rollbackEntered();
      await rollbackGate;
      throw new Error('rollback');
    });
    await entered;

    releaseDescendant();
    await attempted;
    rejectRollback();

    await expect(rollingBack).rejects.toThrow('rollback');
    await expect(Promise.race([
      descendant,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('descendant deadlocked')), 100)),
    ])).resolves.toBeUndefined();
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'escaped-context-run', interactionId: 'descendant-write',
    })).resolves.toMatchObject({ id: 'descendant-write' });
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'escaped-context-run', interactionId: 'rolled-back',
    })).resolves.toBeUndefined();
  });

  it('does not let an escaped nested transaction roll back a later successful mutation', async () => {
    const store = new MemoryRunStore();
    let nestedEntered!: () => void;
    const entered = new Promise<void>((resolve) => { nestedEntered = resolve; });
    let rejectNested!: () => void;
    const nestedGate = new Promise<void>((resolve) => { rejectNested = resolve; });
    const record = (id: string) => ({
      id, tenantId: identity.tenantId, runId: 'nested-rollback-run', attemptId: 'attempt-a', turnNo: 1,
      kind: 'approval' as const, status: 'pending' as const, payload: {}, createdAt: new Date(),
    });
    let nested!: Promise<void>;

    await store.transaction(async () => {
      nested = store.transaction(async (tx) => {
        nestedEntered();
        await nestedGate;
        await tx.interactions.put(record('nested-write'));
        throw new Error('nested rollback');
      });
      await entered;
    });

    await store.interactions.put(record('later-success'));
    rejectNested();

    await expect(nested).rejects.toThrow('nested rollback');
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'nested-rollback-run', interactionId: 'later-success',
    })).resolves.toMatchObject({ id: 'later-success' });
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'nested-rollback-run', interactionId: 'nested-write',
    })).resolves.toBeUndefined();
  });

  it('rejects an escaped nested transaction that succeeds after its parent is invalidated', async () => {
    const store = new MemoryRunStore();
    let nestedEntered!: () => void;
    const entered = new Promise<void>((resolve) => { nestedEntered = resolve; });
    let releaseNested!: () => void;
    const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve; });
    const record = (id: string) => ({
      id, tenantId: identity.tenantId, runId: 'nested-success-run', attemptId: 'attempt-a', turnNo: 1,
      kind: 'approval' as const, status: 'pending' as const, payload: {}, createdAt: new Date(),
    });
    let nested!: Promise<string>;

    await store.transaction(async () => {
      nested = store.transaction(async (tx) => {
        nestedEntered();
        await nestedGate;
        await tx.interactions.put(record('nested-write'));
        return 'ok';
      });
      await entered;
    });

    await store.interactions.put(record('later-success'));
    releaseNested();

    await expect(nested).rejects.toMatchObject({
      code: 'RUN_STATE_CONFLICT', message: 'Transaction context is no longer active',
    });
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'nested-success-run', interactionId: 'later-success',
    })).resolves.toMatchObject({ id: 'later-success' });
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'nested-success-run', interactionId: 'nested-write',
    })).resolves.toBeUndefined();
  });

  it('commits a successful nested transaction awaited by its active parent', async () => {
    const store = new MemoryRunStore();
    const record = {
      id: 'awaited-nested-write', tenantId: identity.tenantId, runId: 'awaited-nested-run',
      attemptId: 'attempt-a', turnNo: 1, kind: 'approval' as const, status: 'pending' as const,
      payload: {}, createdAt: new Date(),
    };

    await expect(store.transaction(async (tx) => tx.transaction(async (nested) => {
      await nested.interactions.put(record);
      return 'ok';
    }))).resolves.toBe('ok');
    await expect(store.interactions.get({
      tenantId: identity.tenantId, runId: 'awaited-nested-run', interactionId: 'awaited-nested-write',
    })).resolves.toMatchObject({ id: 'awaited-nested-write' });
  });

  it('does not expose a stale transaction overlay through an escaped read context', async () => {
    const store = new MemoryRunStore();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const record = (version: 'stale' | 'current') => ({
      id: 'overlay-read', tenantId: identity.tenantId, runId: 'overlay-read-run', attemptId: 'attempt-a', turnNo: 1,
      kind: 'approval' as const, status: 'pending' as const, payload: { version }, createdAt: new Date(),
    });
    let escapedRead!: Promise<Awaited<ReturnType<typeof store.interactions.get>>>;

    await store.transaction(async (tx) => {
      await tx.interactions.put(record('stale'));
      escapedRead = readGate.then(() => store.interactions.get({
        tenantId: identity.tenantId, runId: 'overlay-read-run', interactionId: 'overlay-read',
      }));
    });
    await store.interactions.put(record('current'));

    releaseRead();
    await expect(escapedRead).resolves.toMatchObject({ payload: { version: 'current' } });
  });
});

describe('MysqlRunStore durable contract surface', () => {
  it('implements the same target RunStore and durable sub-ports as memory', () => {
    for (const method of ['create', 'get', 'claim', 'renewLease', 'commitTurn', 'requestCancellation', 'complete'] as const) {
      expect(typeof MysqlRunStore.prototype[method]).toBe('function');
    }
  });

  it('provides a constructible Task 4 assembly sharing one MySQL store and committed recovery repository', () => {
    const assembly = createMysqlDurablePiRuntime({ db: {} as never, models: {} as never, model: {} as never });
    expect(assembly.runtime).toBeInstanceOf(DurableRunManager);
    expect(assembly.store).toBeInstanceOf(MysqlRunStore);
    expect(assembly.sessions).toBeDefined();
  });

  it('checks an expected recovery token even after the durable lease is cleared', () => {
    const source = readFileSync(new URL('../../packages/pi-runtime/src/store/mysql.ts', import.meta.url), 'utf8');
    expect(source).toContain('if (input.expectedLease) {');
    expect(source).toContain('BigInt(row.lease_token) !== input.expectedLease.token');
    expect(source).not.toContain('if (activeLease && (!input.expectedLease');
  });

  it('executes owner-scoped SQL reservations for same-tenant actors sharing an external session id', async () => {
    const db = new MysqlCreateContractDb();
    const store = new MysqlRunStore(db as never);
    const now = new Date('2026-07-29T00:00:00.000Z');
    const record = (actorId: string) => ({
      tenantId: 'tenant-a', runId: `run-${actorId}`, actorId, sessionId: 'shared-session', kernel: 'pi' as const,
      kernelVersion: '0.82.1', status: 'queued' as const, leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    });

    await expect(store.create({ record: record('user-a') })).resolves.toMatchObject({ sessionCreated: true });
    await expect(store.create({ record: record('user-b') })).resolves.toMatchObject({ sessionCreated: true });

    expect(db.rows.pi_sessions.map((row) => row.session_id).sort()).toEqual([
      piSessionStorageId('user-a', 'shared-session'),
      piSessionStorageId('user-b', 'shared-session'),
    ].sort());
    expect(db.rows.agent_runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 'tenant-a', user_id: 'user-a', session_id: 'shared-session' }),
      expect.objectContaining({ tenant_id: 'tenant-a', user_id: 'user-b', session_id: 'shared-session' }),
    ]));
  });

  it('normalizes MySQL interaction timestamps for get and list reads', async () => {
    const timestamp = '2026-07-30T08:09:10.123Z';
    const row = {
      tenant_id: 'tenant-a', run_id: 'run-a', id: 'interaction-a', user_id: 'user-a', session_id: 'session-a',
      attempt_id: 'attempt-a', turn_no: 1, kind: 'approval', tool_call_id: 'call-a', status: 'resolved',
      payload: '{}', resolution: 'true', resolved_by: 'user-a',
      expires_at: timestamp, created_at: timestamp, resolved_at: timestamp,
    };
    const store = new MysqlRunStore(new MysqlInteractionReadDb(row) as never);

    const interaction = await store.interactions.get({
      tenantId: 'tenant-a', runId: 'run-a', interactionId: 'interaction-a',
    });
    const listed = await store.interactions.list({ tenantId: 'tenant-a', runId: 'run-a' });

    for (const record of [interaction, listed[0]]) {
      expect(record?.createdAt).toBeInstanceOf(Date);
      expect(record?.expiresAt).toBeInstanceOf(Date);
      expect(record?.resolvedAt).toBeInstanceOf(Date);
      expect(record?.createdAt.toISOString()).toBe(timestamp);
    }
  });
});

async function runStoreContract(store: DurableRunStore, runId: string): Promise<void> {
  const identity = { tenantId: 'pi-runtime-contract', actorId: 'user-a', roles: ['user'] } as const;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const start = new Date();
  await store.create({ record: {
    tenantId: identity.tenantId, runId, actorId: identity.actorId, sessionId: `session-${runId}`, kernel: 'pi',
    kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: start, updatedAt: start,
  } });
  const first = await store.claim({ identity, runId, workerId: 'worker-a', now: start, leaseTtlMs: 10 });
  expect(first?.fencingToken).toBe(1n);
  await expect(store.renewLease({
    tenantId: identity.tenantId, runId, workerId: 'worker-a', fencingToken: first!.fencingToken,
    now: new Date(start.getTime() + 1), leaseTtlMs: 10,
  })).resolves.toBeUndefined();
  await expect(store.claim({
    identity, runId, workerId: 'worker-b', now: new Date(start.getTime() + 2), leaseTtlMs: 10,
  })).resolves.toBeNull();
  const reclaimedAt = new Date(start.getTime() + 12);
  const second = await store.claim({ identity, runId, workerId: 'worker-b', now: reclaimedAt, leaseTtlMs: 1000 });
  expect(second?.fencingToken).toBe(2n);
  await expect(store.renewLease({
    tenantId: identity.tenantId, runId, workerId: 'worker-a', fencingToken: first!.fencingToken,
    now: reclaimedAt, leaseTtlMs: 10,
  })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  await store.requestCancellation({ identity, runId, requestedAt: reclaimedAt, reason: 'stop' });
  await expect(store.commitTurn({
    tenantId: identity.tenantId, runId, attemptId: second!.attemptId, turnNo: 1,
    fencingToken: second!.fencingToken, checkpoint: {}, events: [], status: 'succeeded', usage,
    committedAt: reclaimedAt,
  })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  await store.complete({
    tenantId: identity.tenantId, runId, attemptId: second!.attemptId, fencingToken: second!.fencingToken,
    status: 'succeeded', usage, completedAt: new Date(reclaimedAt.getTime() + 1),
  });
  expect((await store.get({ tenantId: identity.tenantId, runId }))?.status).toBe('cancelled');
  await expect(store.claim({
    identity, runId, workerId: 'worker-c', now: new Date(reclaimedAt.getTime() + 2), leaseTtlMs: 10,
  })).resolves.toBeNull();

  const successRunId = `${runId}-success`;
  const successSessionId = `session-${successRunId}`;
  await store.create({ record: {
    tenantId: identity.tenantId, runId: successRunId, actorId: identity.actorId, sessionId: successSessionId,
    kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: start, updatedAt: start,
  } });
  await store.sessions.create({ tenantId: identity.tenantId, sessionId: successSessionId, createdAt: start });
  await store.sessions.appendEntry(identity.tenantId, successSessionId, {
    type: 'message', id: 'committed-leaf', parentId: null, timestamp: start.toISOString(),
    message: { role: 'user', content: 'committed', timestamp: start.getTime() },
  });
  const successClaim = await store.claim({ identity, runId: successRunId, workerId: 'worker-success', now: start, leaseTtlMs: 1000 });
  await store.commitTurn({
    tenantId: identity.tenantId, runId: successRunId, attemptId: successClaim!.attemptId, turnNo: 1,
    fencingToken: successClaim!.fencingToken,
    checkpoint: { piSessionId: successSessionId, piLeafId: 'committed-leaf' },
    events: [{
      tenantId: identity.tenantId, runId: successRunId, type: 'turn_end', attemptId: successClaim!.attemptId,
      turnNo: 1, kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'commit-success', createdAt: start,
    }],
    status: 'running', usage, committedAt: start,
  });
  expect((await store.sessions.get(identity.tenantId, successSessionId))?.committedLeafId).toBe('committed-leaf');
  expect(await store.listEvents({ tenantId: identity.tenantId, runId: successRunId })).toHaveLength(1);
  await store.complete({
    tenantId: identity.tenantId, runId: successRunId, attemptId: successClaim!.attemptId,
    fencingToken: successClaim!.fencingToken, status: 'succeeded', usage, completedAt: new Date(start.getTime() + 1),
  });
  expect((await store.get({ tenantId: identity.tenantId, runId: successRunId }))?.status).toBe('succeeded');
  await expect(store.claim({
    identity, runId: successRunId, workerId: 'worker-late', now: new Date(start.getTime() + 2), leaseTtlMs: 10,
  })).resolves.toBeNull();
}

describe('shared RunStore contract', () => {
  it('passes claim, renew, lease loss, cancellation race, and terminal semantics in memory', async () => {
    await runStoreContract(new MemoryRunStore(() => new Date('2026-07-28T00:00:00.012Z')), 'memory-contract');
  });

  it('atomically reserves one active run per tenant session', async () => {
    const store = new MemoryRunStore();
    const now = new Date();
    const record = (runId: string) => ({
      tenantId: 'tenant-exclusive', runId, actorId: 'user-a', sessionId: 'shared-session', kernel: 'pi' as const,
      kernelVersion: '0.82.1', status: 'queued' as const, leaseToken: 0n,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      createdAt: now, updatedAt: now,
    });

    const results = await Promise.allSettled([
      store.create({ record: record('run-exclusive-a') }),
      store.create({ record: record('run-exclusive-b') }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }) }),
    ]);
  });
});

describe.runIf(Boolean(process.env.MYSQL_HOST))('shared RunStore MySQL integration contract', () => {
  it('does not let a stale MySQL recovery token overwrite a newer waiting state', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const suffix = `${Date.now()}`;
    const tenantId = 'pi-runtime-recovery-fence';
    const runId = `stale-recovery-${suffix}`;
    const sessionId = `session-${suffix}`;
    const owner = { tenantId, actorId: 'owner-a', roles: ['user'] } as const;
    const startedAt = new Date('2026-07-29T00:00:00.000Z');
    const store = new MysqlRunStore(db);
    try {
      await store.create({ record: {
        tenantId, runId, actorId: owner.actorId, sessionId, kernel: 'pi', kernelVersion: '0.82.1',
        status: 'queued', leaseToken: 0n, usage, createdAt: startedAt, updatedAt: startedAt,
      } });
      const first = await store.claim({ identity: owner, runId, workerId: 'worker-a', now: startedAt, leaseTtlMs: 10 });
      const reclaimedAt = new Date(startedAt.getTime() + 11);
      const second = await store.claim({ identity: owner, runId, workerId: 'worker-b', now: reclaimedAt, leaseTtlMs: 1000 });
      await store.commitTurn({
        tenantId, runId, attemptId: second!.attemptId, turnNo: 1, fencingToken: second!.fencingToken,
        checkpoint: {}, events: [], status: 'waiting', waitingReason: 'approval', usage,
        committedAt: new Date(reclaimedAt.getTime() + 1),
      });

      await expect(store.markRecoveryRequired({
        identity: owner, runId, errorMessage: 'delayed worker-a failure', failedAt: new Date(reclaimedAt.getTime() + 2),
        expectedLease: { ownerId: 'worker-a', token: first!.fencingToken },
      })).resolves.toBe(false);
      await expect(store.get({ tenantId, runId })).resolves.toMatchObject({
        status: 'waiting', waitingReason: 'approval', leaseToken: second!.fencingToken,
      });
    } finally {
      for (const table of ['agent_turn_commits', 'agent_run_attempts', 'agent_runs'] as const) {
        await db.deleteFrom(table).where('tenant_id', '=', tenantId).where('run_id', '=', runId).execute();
      }
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId)
        .where('session_id', '=', piSessionStorageId(owner.actorId, sessionId)).execute();
      await db.destroy();
    }
  });

  it.each(['queued', 'waiting'] as const)('atomically cancels an inactive MySQL %s run', async (status) => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const suffix = `${status}-${Date.now()}`;
    const tenantId = 'pi-runtime-cancel-contract';
    const runId = `cancel-${suffix}`;
    const owner = { tenantId, actorId: 'owner-a', roles: ['user'] } as const;
    const now = new Date();
    const store = new MysqlRunStore(db, false, () => new Date(now.getTime() + 1));
    try {
      await store.create({ record: {
        tenantId, runId, actorId: owner.actorId, sessionId: `session-${suffix}`, kernel: 'pi',
        kernelVersion: '0.82.1', status, waitingReason: status === 'waiting' ? 'approval' : undefined,
        leaseToken: 0n, usage, createdAt: now, updatedAt: now,
      } });
      const manager = new DurableRunManager({
        store, heartbeatMs: 0,
        sessions: { create: async () => emptySession('unused'), load: async () => emptySession('unused') },
        eventOptions: () => ({}), now: () => new Date(now.getTime() + 1),
      });

      await manager.cancel({ identity: owner, runId, reason: 'mysql terminate' });

      await expect(store.get({ tenantId, runId })).resolves.toMatchObject({
        status: 'cancelled', errorMessage: 'mysql terminate', appendClosedAt: expect.any(Date),
        leaseOwner: undefined, leaseExpiresAt: undefined,
      });
    } finally {
      for (const table of ['agent_run_attempts', 'agent_runs'] as const) {
        await db.deleteFrom(table).where('tenant_id', '=', tenantId).where('run_id', '=', runId).execute();
      }
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId)
        .where('session_id', '=', piSessionStorageId(owner.actorId, `session-${suffix}`)).execute();
      await db.destroy();
    }
  });

  it('passes the same lifecycle and fencing semantics against MySQL', async () => {
    const config = readMysqlConfig()!;
    const pool = createMysqlPool(config);
    await runMigrations(pool);
    const db = createKysely(pool);
    const runId = `mysql-contract-${Date.now()}`;
    try {
      await runStoreContract(new MysqlRunStore(db), runId);
    } finally {
      for (const targetRunId of [runId, `${runId}-success`]) {
        for (const table of ['agent_run_inbox_messages', 'agent_run_events', 'agent_turn_commits', 'agent_run_attempts', 'agent_runs'] as const) {
          await db.deleteFrom(table).where('tenant_id', '=', 'pi-runtime-contract').where('run_id', '=', targetRunId).execute();
        }
      }
      const sessionIds = [
        piSessionStorageId('user-a', `session-${runId}`),
        piSessionStorageId('user-a', `session-${runId}-success`),
        `session-${runId}-success`,
      ];
      await db.deleteFrom('pi_session_entries').where('tenant_id', '=', 'pi-runtime-contract').where('session_id', 'in', sessionIds).execute();
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', 'pi-runtime-contract').where('session_id', 'in', sessionIds).execute();
      await db.destroy();
    }
  });

  it('serializes competing active-run creation through the shared Pi session row', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const suffix = `${Date.now()}`;
    const tenantId = 'pi-runtime-exclusive';
    const sessionId = `session-${suffix}`;
    const now = new Date();
    const record = (runId: string) => ({
      tenantId, runId, actorId: 'user-a', sessionId, kernel: 'pi' as const, kernelVersion: '0.82.1',
      status: 'queued' as const, leaseToken: 0n,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      createdAt: now, updatedAt: now,
    });
    const runIds = [`run-a-${suffix}`, `run-b-${suffix}`];
    try {
      const results = await Promise.allSettled([
        new MysqlRunStore(db).create({ record: record(runIds[0]!) }),
        new MysqlRunStore(db).create({ record: record(runIds[1]!) }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ code: 'RUN_STATE_CONFLICT' }) }),
      ]);
    } finally {
      for (const runId of runIds) {
        await db.deleteFrom('agent_runs').where('tenant_id', '=', tenantId).where('run_id', '=', runId).execute();
      }
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId)
        .where('session_id', '=', piSessionStorageId('user-a', sessionId)).execute();
      await db.destroy();
    }
  });

  it('returns the atomic reused-session fact when a concurrent starter reserves after the first run terminates', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const suffix = `mysql-${Date.now()}`;
    const sessionId = `atomic-session-classification-${suffix}`;
    const runIds = [`atomic-first-run-${suffix}`, `atomic-second-run-${suffix}`];
    try {
      const result = await runAtomicSessionClassificationRace(new MysqlRunStore(db), suffix);
      expect(result).toMatchObject({ firstStatus: 'failed', secondStatus: 'succeeded', factoryCreates: 1, factoryLoads: 1 });
    } finally {
      for (const runId of runIds) {
        for (const table of ['agent_run_inbox_messages', 'agent_run_events', 'agent_turn_commits', 'agent_run_attempts', 'agent_runs'] as const) {
          await db.deleteFrom(table).where('tenant_id', '=', identity.tenantId).where('run_id', '=', runId).execute();
        }
      }
      const storageId = piSessionStorageId(identity.actorId, sessionId);
      await db.deleteFrom('pi_session_entries').where('tenant_id', '=', identity.tenantId).where('session_id', '=', storageId).execute();
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', identity.tenantId).where('session_id', '=', storageId).execute();
      await db.destroy();
    }
  });

  it('serializes idempotent inbox appends, fences cutoff, and round-trips limits and cost', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const suffix = `${Date.now()}`;
    const tenantId = 'pi-runtime-inbox-contract';
    const runId = `run-${suffix}`;
    const sessionId = `session-${suffix}`;
    const now = new Date('2026-07-28T00:00:00.000Z');
    const owner = { tenantId, actorId: 'owner-a', roles: ['user'] } as const;
    const limits = { maxAttempts: 3, maxTurns: 4, maxCostUsd: 1.5, deadlineAt: new Date('2026-07-29T00:00:00.000Z') };
    const persistedUsage = { ...usage, costUsd: 0.125 };
    const store = new MysqlRunStore(db);
    try {
      await store.create({ record: {
        tenantId, runId, actorId: owner.actorId, sessionId, kernel: 'pi', kernelVersion: '0.82.1',
        status: 'queued', leaseToken: 0n, usage: persistedUsage, limits, createdAt: now, updatedAt: now,
      } });
      await expect(store.get({ tenantId, runId })).resolves.toMatchObject({
        usage: { costUsd: 0.125 },
        limits: { maxAttempts: 3, maxTurns: 4, maxCostUsd: 1.5, deadlineAt: limits.deadlineAt },
      });
      const claim = await store.claim({ identity: owner, runId, workerId: 'worker-a', now, leaseTtlMs: 1000 });
      const append = {
        identity: owner, tenantId, runId, idempotencyKey: 'same-key', mode: 'steer' as const,
        message: { role: 'user' as const, text: 'accepted before close' }, createdAt: now,
      };
      const [first, duplicate] = await Promise.all([
        new MysqlRunStore(db).inbox.enqueue(append),
        new MysqlRunStore(db).inbox.enqueue(append),
      ]);
      expect(duplicate).toEqual(first);
      await expect(store.inbox.enqueue({
        ...append, identity: { tenantId, actorId: 'admin-a', roles: ['tenant_admin'] }, idempotencyKey: 'admin-key',
      })).resolves.toMatchObject({ status: 'pending' });
      await expect(store.inbox.enqueue({
        ...append, identity: { tenantId: 'another-tenant', actorId: 'admin-a', roles: ['platform_admin'] },
        tenantId: 'another-tenant', idempotencyKey: 'cross-tenant',
      })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });

      await store.closeInbox({ tenantId, runId, workerId: 'worker-a', fencingToken: claim!.fencingToken, now });
      await expect(store.inbox.enqueue({ ...append, idempotencyKey: 'after-close' }))
        .rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
      await expect(store.inbox.claimNext({
        tenantId, runId, workerId: 'worker-a', fencingToken: claim!.fencingToken, now, claimTtlMs: 1000,
      })).resolves.toMatchObject({ id: first.id, message: { text: 'accepted before close' } });
    } finally {
      for (const table of ['agent_run_inbox_messages', 'agent_run_attempts', 'agent_runs'] as const) {
        await db.deleteFrom(table).where('tenant_id', '=', tenantId).where('run_id', '=', runId).execute();
      }
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId)
        .where('session_id', '=', piSessionStorageId(owner.actorId, sessionId)).execute();
      await db.destroy();
    }
  });

  it('rejects cross-worker resume when a newer run is active in the same MySQL session', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const suffix = `${Date.now()}`;
    const tenantId = 'pi-runtime-resume-contract';
    const sessionId = `session-${suffix}`;
    const oldRunId = `old-${suffix}`;
    const activeRunId = `active-${suffix}`;
    const owner = { tenantId, actorId: 'owner-a', roles: ['user'] } as const;
    const now = new Date();
    const record = (runId: string, createdAt: Date) => ({
      tenantId, runId, actorId: owner.actorId, sessionId, kernel: 'pi' as const, kernelVersion: '0.82.1',
      status: 'queued' as const, leaseToken: 0n, usage, createdAt, updatedAt: createdAt,
    });
    const store = new MysqlRunStore(db);
    try {
      await store.create({ record: record(oldRunId, now) });
      const oldClaim = await store.claim({ identity: owner, runId: oldRunId, workerId: 'worker-old', now, leaseTtlMs: 1000 });
      await store.complete({
        tenantId, runId: oldRunId, attemptId: oldClaim!.attemptId, fencingToken: oldClaim!.fencingToken,
        status: 'failed', usage, completedAt: new Date(now.getTime() + 1),
      });
      await store.create({ record: record(activeRunId, new Date(now.getTime() + 2)) });

      await expect(new MysqlRunStore(db).claim({
        identity: owner, runId: oldRunId, workerId: 'worker-resume', now: new Date(now.getTime() + 3),
        leaseTtlMs: 1000, resume: true,
      })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
      await expect(store.get({ tenantId, runId: oldRunId })).resolves.toMatchObject({ status: 'failed' });
    } finally {
      for (const runId of [oldRunId, activeRunId]) {
        for (const table of ['agent_run_attempts', 'agent_runs'] as const) {
          await db.deleteFrom(table).where('tenant_id', '=', tenantId).where('run_id', '=', runId).execute();
        }
      }
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId)
        .where('session_id', '=', piSessionStorageId(owner.actorId, sessionId)).execute();
      await db.destroy();
    }
  });
});

describe('DurableRunManager', () => {
  it('creates a genuinely new Pi session instead of loading committed state', async () => {
    const store = new MemoryRunStore();
    const session = emptySession('brand-new-session');
    let createCalls = 0;
    let loadCalls = 0;
    const manager = new DurableRunManager({
      store, heartbeatMs: 0,
      sessions: {
        create: async () => { createCalls += 1; return session; },
        load: async () => { loadCalls += 1; return session; },
      },
      eventOptions: () => ({}),
    });

    const result = await (await manager.run({
      runId: 'brand-new-run', identity, sessionId: 'brand-new-session', input: [{ role: 'user', text: 'start' }],
    })).result();

    expect(result.status).toBe('succeeded');
    expect(createCalls).toBe(1);
    expect(loadCalls).toBe(0);
  });

  it('persists the scheduled execution profile and supplies it to the Pi session factory', async () => {
    const store = new MemoryRunStore();
    const session = emptySession('scheduled-profile-session');
    let createInput: unknown;
    const manager = new DurableRunManager({
      store, heartbeatMs: 0,
      sessions: {
        create: async (input) => { createInput = input; return session; },
        load: async () => session,
      },
      eventOptions: () => ({}),
    });
    const execution = { unattended: true, preApproved: true };

    await (await manager.run({
      runId: 'scheduled-profile-run', identity, sessionId: 'scheduled-profile-session',
      input: [{ role: 'user', text: 'scheduled' }], execution,
    })).result();

    expect(createInput).toMatchObject({ execution });
    expect(await store.get({ tenantId: identity.tenantId, runId: 'scheduled-profile-run' }))
      .toMatchObject({ execution });
  });

  it.each(['failed', 'cancelled', 'recovery_required'] as const)(
    'loads the committed leaf for a new run after a %s run',
    async (terminalStatus) => {
      const store = new MemoryRunStore();
      const sessionId = `committed-after-${terminalStatus}`;
      const oldRunId = `old-${terminalStatus}`;
      const now = new Date('2026-07-29T00:00:00.000Z');
      await store.create({ record: {
        tenantId: identity.tenantId, runId: oldRunId, actorId: identity.actorId, sessionId, kernel: 'pi',
        kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
      } });
      await store.sessions.create({ tenantId: identity.tenantId, sessionId, createdAt: now });
      const oldClaim = await store.claim({ identity, runId: oldRunId, workerId: 'old-worker', now, leaseTtlMs: 1000 });
      await store.complete({
        tenantId: identity.tenantId, runId: oldRunId, attemptId: oldClaim!.attemptId,
        fencingToken: oldClaim!.fencingToken, status: terminalStatus, usage, completedAt: new Date(now.getTime() + 1),
      });

      const committedRoot = messageEntryForUsage(`committed-root-${terminalStatus}`, null, 'user');
      const committedLeaf = messageEntryForUsage(`committed-leaf-${terminalStatus}`, committedRoot.id, 'assistant', {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0,
      });
      const committedSession: ManagedPiSession = {
        ...emptySession(sessionId),
        async entries() { return [committedRoot, committedLeaf]; },
        async leafId() { return committedLeaf.id; },
      };
      let loadedMetadata: { id: string; tenantId?: string } | undefined;
      const manager = new DurableRunManager({
        store, heartbeatMs: 0,
        sessions: {
          create: async () => { throw new Error('current leaf leaked into new run'); },
          load: async ({ metadata }) => { loadedMetadata = metadata; return committedSession; },
        },
        eventOptions: () => ({}),
      });

      const result = await (await manager.run({
        runId: `new-after-${terminalStatus}`, identity, sessionId, input: [{ role: 'user', text: 'start fresh' }],
      })).result();

      expect(result.status).toBe('succeeded');
      expect(loadedMetadata).toMatchObject({ id: piSessionStorageId(identity.actorId, sessionId), tenantId: identity.tenantId });
    },
  );

  it('uses the atomic session reservation result when concurrent starters observed a missing session', async () => {
    const result = await runAtomicSessionClassificationRace(new MemoryRunStore(), 'memory');
    expect(result).toMatchObject({ firstStatus: 'failed', secondStatus: 'succeeded', factoryCreates: 1, factoryLoads: 1 });
  });

  it('coordinates a Pi session and commits its leaf without running a copied agent loop', async () => {
    const store = new MemoryRunStore(() => new Date('2026-07-28T00:00:00.100Z'));
    let continued = 0;
    const session: ManagedPiSession = {
      async *continue(): AsyncGenerator<AgentRunEvent> {
        continued += 1;
        yield {
          tenantId: 'tenant-a', runId: 'run-manager', sequence: 0n, type: 'message', attemptId: '', turnNo: 1,
          kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'event-1', detail: { text: 'done' },
          createdAt: new Date('2026-07-28T00:00:00.050Z'),
        };
        yield {
          tenantId: 'tenant-a', runId: 'run-manager', sequence: 0n, type: 'usage', attemptId: '', turnNo: 1,
          kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'event-2', detail: { outputTokens: 2 },
          createdAt: new Date('2026-07-28T00:00:00.060Z'),
        };
      },
      async replayInteraction() {},
      async metadata() { return { id: 'session-a', tenantId: 'tenant-a', createdAt: '2026-07-28T00:00:00.000Z' }; },
      async entries() { return [
        {
          type: 'message' as const, id: 'root-a', parentId: null, timestamp: '2026-07-28T00:00:00.000Z',
          message: { role: 'user' as const, content: 'start', timestamp: 1 },
        },
        {
          type: 'message' as const, id: 'leaf-a', parentId: 'root-a', timestamp: '2026-07-28T00:00:00.001Z',
          message: {
            role: 'assistant' as const, content: [{ type: 'text' as const, text: 'durable answer' }],
            api: 'test', provider: 'test', model: 'test', stopReason: 'stop' as const, timestamp: 2,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          },
        },
      ]; },
      async leafId() { return 'leaf-a'; },
      async abort() {}, async close() {}, async steer() {}, async followUp() {},
      async appendCustomEntry() { return 'consumed'; },
    };
    const manager = new DurableRunManager({
      store, workerId: 'worker-a', leaseTtlMs: 1000,
      sessions: { create: async () => session, load: async () => session },
      eventOptions: () => ({ tenantId: 'tenant-a', runId: 'run-manager', attemptId: '', turnNo: 1, kernel: 'pi', kernelVersion: '0.82.1' }),
    });
    const handle = await manager.run({
      runId: 'run-manager', identity, sessionId: 'session-a', input: [{ role: 'user', text: 'start' }], kernel: 'pi',
    });
    await expect(handle.result()).resolves.toMatchObject({ status: 'succeeded', text: 'durable answer' });
    expect(continued).toBe(1);
    expect((await store.sessions.get('tenant-a', piSessionStorageId(identity.actorId, 'session-a')))?.committedLeafId).toBe('leaf-a');
    expect(await store.listEvents({ tenantId: 'tenant-a', runId: 'run-manager' })).toHaveLength(2);
  });

  it('uses Pi entry deltas as the single authoritative usage source without double counting events', async () => {
    const store = new MemoryRunStore();
    let finished = false;
    const root = {
      type: 'message' as const, id: 'usage-root', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user' as const, content: 'start', timestamp: Date.now() },
    };
    const assistant = {
      type: 'message' as const, id: 'usage-leaf', parentId: root.id, timestamp: new Date().toISOString(),
      message: {
        role: 'assistant' as const, content: [{ type: 'text' as const, text: 'answer' }], api: 'test', provider: 'test', model: 'test',
        stopReason: 'stop' as const, timestamp: Date.now(),
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } },
      },
    };
    const session: ManagedPiSession = {
      async *continue() {
        yield {
          tenantId: '', runId: '', sequence: 1n, type: 'message_end', attemptId: '', turnNo: 0,
          kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'usage', createdAt: new Date(),
          detail: { message: { usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, costTotal: 0.33 } } },
        };
        finished = true;
      },
      async replayInteraction() {},
      async entries() { return finished ? [root, assistant] : [root]; }, async leafId() { return assistant.id; },
      async metadata() { return { id: 'usage-session', tenantId: 'tenant-a', createdAt: new Date().toISOString() }; },
      async abort() {}, async close() {}, async steer() {}, async followUp() {}, async appendCustomEntry() { return 'marker'; },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const handle = await manager.run({
      runId: 'usage-run', identity, sessionId: 'usage-session', input: [{ role: 'user', text: 'start' }],
    });
    const result = await handle.result();
    expect(result.usage).toEqual({
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 3, costUsd: 0.33,
    });
    expect((await store.get({ tenantId: identity.tenantId, runId: 'usage-run' }))?.usage).toEqual(result.usage);
  });

  it('waits for a priced usage fact before enforcing a cost limit', async () => {
    const store = new MemoryRunStore();
    let finished = false;
    const root = messageEntryForUsage('cost-root', null, 'user');
    const assistant = messageEntryForUsage('cost-leaf', root.id, 'assistant', {
      input: 2, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0.05,
    });
    const session: ManagedPiSession = {
      ...emptySession('cost-sequence-session'),
      async *continue() {
        for (const type of ['agent_start', 'turn_start'] as const) {
          yield { tenantId: '', runId: '', sequence: 1n, type, attemptId: '', turnNo: 0,
            kernel: 'pi', kernelVersion: '0.82.1', correlationId: type, createdAt: new Date() };
        }
        yield { tenantId: '', runId: '', sequence: 2n, type: 'message_end', attemptId: '', turnNo: 0,
          kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'unpriced', createdAt: new Date(),
          detail: { message: { usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } } } as AgentRunEvent;
        yield { tenantId: '', runId: '', sequence: 2n, type: 'message_end', attemptId: '', turnNo: 0,
          kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'priced', createdAt: new Date(),
          detail: { message: { usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0.05 } } } } as AgentRunEvent;
        finished = true;
      },
      async entries() { return finished ? [root, assistant] : [root]; },
      async leafId() { return assistant.id; },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const result = await (await manager.run({
      runId: 'cost-sequence-run', identity, sessionId: 'cost-sequence-session',
      input: [{ role: 'user', text: 'start' }], limits: { maxCostUsd: 0.1 },
    })).result();
    expect(result).toMatchObject({ status: 'succeeded', usage: { costUsd: 0.05 } });
  });

  it('commits a governed waiting outcome and resumes it immediately on another worker with its resolution', async () => {
    const store = new MemoryRunStore();
    const runId = 'governed-waiting-run';
    const sessionId = 'governed-waiting-session';
    const waitingSession: ManagedPiSession = {
      ...emptySession(sessionId),
      async *continue() {
        throw new GovernedToolOutcomeError({
          kind: 'waiting', reason: 'approval', interactionId: 'approval-a',
          interactionUpdates: [{
            tenantId: identity.tenantId, runId, id: 'approval-a', attemptId: 'attempt-a', turnNo: 1,
            kind: 'approval', toolCallId: 'call-a', status: 'pending', payload: {}, createdAt: new Date(),
          }],
        });
      },
    };
    let receivedResolution: unknown;
    let replayedResolution: unknown;
    const resumedSession: ManagedPiSession = {
      ...emptySession(sessionId),
      async replayInteraction(resolution) { replayedResolution = resolution; },
    };
    const firstManager = new DurableRunManager({
      store, workerId: 'waiting-worker-a', heartbeatMs: 0,
      sessions: { create: async () => waitingSession, load: async () => waitingSession },
      eventOptions: () => ({}),
    });
    const secondManager = new DurableRunManager({
      store, workerId: 'waiting-worker-b', heartbeatMs: 0,
      sessions: {
        create: async () => resumedSession,
        load: async ({ interactionResolution }) => {
          receivedResolution = interactionResolution;
          return resumedSession;
        },
      },
      eventOptions: () => ({}),
    });

    const waitingResult = await (await firstManager.run({
      runId, identity, sessionId, input: [{ role: 'user', text: 'needs approval' }],
    })).result();

    expect(waitingResult).toMatchObject({ status: 'waiting' });
    const waitingRun = await store.get({ tenantId: identity.tenantId, runId });
    expect(waitingRun).toMatchObject({
      status: 'waiting', waitingReason: 'approval', leaseOwner: undefined, leaseExpiresAt: undefined,
    });
    expect(waitingRun?.appendClosedAt).toBeUndefined();

    const committedResolution = { approved: true, audit: { actor: 'user-a', source: 'ui' } };
    const resolution = {
      interactionId: 'approval-a',
      value: { audit: { source: 'ui', actor: 'user-a' }, approved: true },
    };
    const pendingInteraction = await store.getInteraction({
      tenantId: identity.tenantId, runId, interactionId: resolution.interactionId,
    });
    await expect(store.resolveInteraction({
      ...pendingInteraction!, status: 'resolved', resolution: committedResolution, resolvedAt: new Date(),
    })).resolves.toBe(true);
    const resumedResult = await (await secondManager.resume({ identity, runId, resolution })).result();

    const trustedResolution = {
      interactionId: resolution.interactionId, value: committedResolution, kind: 'approval', toolCallId: 'call-a',
    };
    expect(receivedResolution).toEqual(trustedResolution);
    expect(replayedResolution).toEqual(trustedResolution);
    expect(resumedResult.status).toBe('succeeded');
    expect((await store.get({ tenantId: identity.tenantId, runId }))?.waitingReason).toBeUndefined();
  });

  it('cancels after resume load without replaying the resolved governed call', async () => {
    const store = new MemoryRunStore();
    const runId = 'cancel-before-replay-run';
    const binding = await seedResolvedWaitingReplay(store, runId);
    let replayCalls = 0;
    let providerCalls = 0;
    const session: ManagedPiSession = {
      ...emptySession('cancel-before-replay-session'),
      async replayInteraction() { replayCalls++; },
      async *continue() { providerCalls++; },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0,
      sessions: {
        create: async () => session,
        load: async () => {
          await store.requestCancellation({ identity, runId, requestedAt: new Date(), reason: 'cancel before replay' });
          return session;
        },
      },
      eventOptions: () => ({}),
    });

    const result = await (await manager.resume({
      identity, runId, resolution: { interactionId: binding.interactionId, value: true },
    })).result();

    expect(result.status).toBe('cancelled');
    expect(replayCalls).toBe(0);
    expect(providerCalls).toBe(0);
    expect(await store.get({ tenantId: identity.tenantId, runId })).toMatchObject({
      status: 'cancelled', leaseOwner: undefined, leaseExpiresAt: undefined,
    });
    expect(await store.attempts.list({ tenantId: identity.tenantId, runId })).toEqual([
      expect.objectContaining({ status: 'cancelled', completedAt: expect.any(Date) }),
    ]);
    expect(await store.toolLedger.get({
      tenantId: identity.tenantId, runId, logicalCallId: binding.logicalCallId,
    })).toMatchObject({ status: 'pending_approval', toolCallId: binding.toolCallId });
    expect(await store.interactions.get({
      tenantId: identity.tenantId, runId, interactionId: binding.interactionId,
    })).toMatchObject({ status: 'resolved', toolCallId: binding.toolCallId, resolution: true });
  });

  it('aborts a blocked replay before its governed side effect can start when cancellation wins', async () => {
    const store = new MemoryRunStore();
    const runId = 'cancel-blocked-replay-run';
    const binding = await seedResolvedWaitingReplay(store, runId);
    await store.inbox.enqueue({
      identity, tenantId: identity.tenantId, runId, idempotencyKey: 'must-not-deliver', mode: 'steer',
      message: { role: 'user', text: 'must not steer during replay' }, createdAt: new Date(),
    });
    let replayEntered!: () => void;
    const entered = new Promise<void>((resolve) => { replayEntered = resolve; });
    let releaseReplay!: () => void;
    const released = new Promise<void>((resolve) => { releaseReplay = resolve; });
    let sideEffectCalls = 0;
    let providerCalls = 0;
    let steerCalls = 0;
    let replaySignalAborted = false;
    const session: ManagedPiSession = {
      ...emptySession('cancel-blocked-replay-session'),
      async replayInteraction(_resolution, signal, guard?: () => Promise<void>) {
        replayEntered();
        await released;
        try {
          await guard?.();
        } catch (error) {
          replaySignalAborted = signal?.aborted === true;
          throw error;
        }
        if (!signal?.aborted) sideEffectCalls++;
      },
      async *continue() { providerCalls++; },
      async steer() { steerCalls++; },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, inboxPollMs: 60_000,
      sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const handle = await manager.resume({
      identity, runId, resolution: { interactionId: binding.interactionId, value: true },
    });
    await entered;
    await store.requestCancellation({ identity, runId, requestedAt: new Date(), reason: 'cancel blocked replay' });
    releaseReplay();

    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' });
    expect(replaySignalAborted).toBe(true);
    expect(sideEffectCalls).toBe(0);
    expect(providerCalls).toBe(0);
    expect(steerCalls).toBe(0);
    expect(await store.get({ tenantId: identity.tenantId, runId })).toMatchObject({
      status: 'cancelled', leaseOwner: undefined, leaseExpiresAt: undefined,
    });
    expect(await store.attempts.list({ tenantId: identity.tenantId, runId })).toEqual([
      expect.objectContaining({ status: 'cancelled', completedAt: expect.any(Date) }),
    ]);
    expect(await store.toolLedger.get({
      tenantId: identity.tenantId, runId, logicalCallId: binding.logicalCallId,
    })).toMatchObject({ status: 'pending_approval', toolCallId: binding.toolCallId });
    expect(await store.interactions.get({
      tenantId: identity.tenantId, runId, interactionId: binding.interactionId,
    })).toMatchObject({ status: 'resolved', toolCallId: binding.toolCallId, resolution: true });
  });

  it('preserves a governed recovery-required outcome instead of classifying it as a model failure', async () => {
    const store = new MemoryRunStore();
    const session = {
      ...emptySession('governed-recovery-session'),
      async *continue() {
        throw new GovernedToolOutcomeError({
          kind: 'recovery_required', correlationId: 'external-a', message: 'external result is uncertain',
        });
      },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });

    const result = await (await manager.run({
      runId: 'governed-recovery-run', identity, sessionId: 'governed-recovery-session',
      input: [{ role: 'user', text: 'write externally' }],
    })).result();

    expect(result).toMatchObject({
      status: 'recovery_required',
      error: { code: 'TOOL_RESULT_UNKNOWN', message: 'external result is uncertain', retryable: false },
    });
    expect(await store.get({ tenantId: identity.tenantId, runId: 'governed-recovery-run' })).toMatchObject({
      status: 'recovery_required', appendClosedAt: expect.any(Date),
    });
  });

  it('lets cancellation win when it lands between governed outcome arbitration and commit', async () => {
    const base = new MemoryRunStore();
    let committed: Record<string, unknown> | undefined;
    let cancellationInjected = false;
    const store = new Proxy(base, {
      get(target, property) {
        if (property === 'commitTurn') return async (input: Record<string, unknown>) => {
          committed = input;
          if (input.status === 'recovery_required' && !cancellationInjected) {
            cancellationInjected = true;
            await target.requestCancellation({
              identity, runId: 'cancel-governed-run', requestedAt: new Date(), reason: 'stop',
            });
          }
          return target.commitTurn(input as never);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ledgerUpdate = {
      tenantId: identity.tenantId, runId: 'cancel-governed-run', attemptId: 'tool-attempt', turnNo: 1,
      logicalCallId: 'logical-cancel', toolCallId: 'call-cancel', toolName: 'sandbox_run_command',
      argsDigest: 'digest', capability: 'non_idempotent_write' as const, idempotencyKey: 'cancel-key',
      status: 'recovery_required' as const,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const session: ManagedPiSession = {
      ...emptySession('cancel-governed-session'),
      async *continue() {
        throw new GovernedToolOutcomeError({
          kind: 'recovery_required', correlationId: 'external-cancel', message: 'external result is uncertain',
        });
      },
      takeToolExecutionFacts: () => ({ ledgerUpdates: [ledgerUpdate], interactionUpdates: [] }),
    };
    const manager = new DurableRunManager({
      store: store as never, heartbeatMs: 0,
      sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const handle = await manager.run({
      runId: 'cancel-governed-run', identity, sessionId: 'cancel-governed-session',
      input: [{ role: 'user', text: 'run a non-idempotent tool' }],
    });

    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' });
    expect(await base.get({ tenantId: identity.tenantId, runId: handle.runId })).toMatchObject({
      status: 'cancelled', leaseOwner: undefined, leaseExpiresAt: undefined,
    });
    expect(await base.attempts.list({ tenantId: identity.tenantId, runId: handle.runId })).toEqual([
      expect.objectContaining({ status: 'cancelled', completedAt: expect.any(Date) }),
    ]);
    expect(await base.toolLedger.get({
      tenantId: identity.tenantId, runId: handle.runId, logicalCallId: ledgerUpdate.logicalCallId,
    })).toEqual(ledgerUpdate);
    expect(committed).toMatchObject({ status: 'cancelled', ledgerUpdates: [ledgerUpdate] });
  });

  it('commits governed ledger and interaction facts through the fenced turn transaction', async () => {
    const base = new MemoryRunStore();
    let committed: Record<string, unknown> | undefined;
    const store = new Proxy(base, {
      get(target, property) {
        if (property === 'commitTurn') return async (input: Record<string, unknown>) => {
          committed = input;
          return target.commitTurn(input as never);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ledgerUpdate = {
      tenantId: identity.tenantId, runId: 'governed-facts-run', attemptId: 'tool-attempt', turnNo: 1,
      logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'deploy', argsDigest: 'digest',
      capability: 'non_idempotent_write' as const, idempotencyKey: 'idempotency-a', status: 'pending_approval' as const,
      approvedInteractionId: 'approval-a', createdAt: new Date(), updatedAt: new Date(),
    };
    const interactionUpdate = {
      tenantId: identity.tenantId, runId: 'governed-facts-run', id: 'approval-a', attemptId: 'tool-attempt',
      turnNo: 1, kind: 'approval' as const, toolCallId: 'call-a', status: 'pending' as const,
      payload: {}, createdAt: new Date(),
    };
    const session = {
      ...emptySession('governed-facts-session'),
      async *continue() {
        throw new GovernedToolOutcomeError({
          kind: 'waiting', reason: 'approval', interactionId: 'approval-a',
          ledgerUpdates: [ledgerUpdate], interactionUpdates: [interactionUpdate],
        });
      },
    };
    const manager = new DurableRunManager({
      store: store as never, heartbeatMs: 0,
      sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });

    await (await manager.run({
      runId: 'governed-facts-run', identity, sessionId: 'governed-facts-session', input: [{ role: 'user', text: 'deploy' }],
    })).result();

    expect(committed).toMatchObject({ ledgerUpdates: [ledgerUpdate], interactionUpdates: [interactionUpdate] });
  });

  it('finalizes governed recovery-required in the turn transaction without a second completion write', async () => {
    const base = new MemoryRunStore();
    const store = new Proxy(base, {
      get(target, property) {
        if (property === 'complete') return async () => { throw new Error('second completion write must not run'); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const session = {
      ...emptySession('atomic-recovery-session'),
      async *continue() {
        throw new GovernedToolOutcomeError({ kind: 'recovery_required', message: 'uncertain' });
      },
    };
    const manager = new DurableRunManager({
      store: store as never, heartbeatMs: 0,
      sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });

    await expect((await manager.run({
      runId: 'atomic-recovery-run', identity, sessionId: 'atomic-recovery-session',
      input: [{ role: 'user', text: 'deploy' }],
    })).result()).resolves.toMatchObject({ status: 'recovery_required' });
  });

  it('rejects a waiting resume whose resolution is not the resolved interaction for that run', async () => {
    const base = new MemoryRunStore();
    const now = new Date();
    await base.create({ record: {
      tenantId: identity.tenantId, runId: 'validated-resume-run', actorId: identity.actorId,
      sessionId: 'validated-resume-session', kernel: 'pi', kernelVersion: '0.82.1', status: 'waiting',
      waitingReason: 'approval', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    const store = new Proxy(base, {
      get(target, property) {
        if (property === 'getInteraction') return async () => ({
          tenantId: identity.tenantId, runId: 'different-run', id: 'approval-a', attemptId: 'attempt-a', turnNo: 1,
          kind: 'approval', toolCallId: 'call-a', status: 'resolved', payload: {}, resolution: true, createdAt: now,
        });
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const manager = new DurableRunManager({
      store: store as never, heartbeatMs: 0,
      sessions: { create: async () => { throw new Error('must not create'); }, load: async () => { throw new Error('must not load'); } },
      eventOptions: () => ({}),
    });

    await expect(manager.resume({
      identity, runId: 'validated-resume-run', resolution: { interactionId: 'approval-a', value: true },
    })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
    expect((await base.get({ tenantId: identity.tenantId, runId: 'validated-resume-run' }))?.status).toBe('waiting');
  });

  it('rejects an atomic waiting claim that omits the required resolution', async () => {
    const store = new MemoryRunStore();
    const now = new Date();
    await store.create({ record: {
      tenantId: identity.tenantId, runId: 'claim-without-resolution', actorId: identity.actorId,
      sessionId: 'claim-without-resolution-session', kernel: 'pi', kernelVersion: '0.82.1', status: 'waiting',
      waitingReason: 'approval', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });

    await expect(store.claim({
      identity, runId: 'claim-without-resolution', workerId: 'worker-b', now, leaseTtlMs: 1_000, resume: true,
    })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
    expect((await store.get({ tenantId: identity.tenantId, runId: 'claim-without-resolution' }))?.status)
      .toBe('waiting');
  });

  it('commits accumulated governed facts when a later provider operation fails', async () => {
    const base = new MemoryRunStore();
    let committed: Record<string, unknown> | undefined;
    const store = new Proxy(base, {
      get(target, property) {
        if (property === 'commitTurn') return async (input: Record<string, unknown>) => {
          committed = input;
          return target.commitTurn(input as never);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ledgerUpdate = {
      tenantId: identity.tenantId, runId: 'facts-before-provider-failure', attemptId: 'attempt-a', turnNo: 1,
      logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'deploy', argsDigest: 'digest',
      capability: 'non_idempotent_write' as const, idempotencyKey: 'key-a', status: 'completed' as const,
      result: { callId: 'call-a', content: 'ok' }, createdAt: new Date(), updatedAt: new Date(),
    };
    const session: ManagedPiSession = {
      ...emptySession('facts-before-provider-failure-session'),
      async *continue() { throw new Error('provider failed after tool completion'); },
      takeToolExecutionFacts: () => ({ ledgerUpdates: [ledgerUpdate], interactionUpdates: [] }),
    };
    const manager = new DurableRunManager({
      store: store as never, heartbeatMs: 0,
      sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });

    await expect((await manager.run({
      runId: 'facts-before-provider-failure', identity, sessionId: 'facts-before-provider-failure-session',
      input: [{ role: 'user', text: 'deploy' }],
    })).result()).resolves.toMatchObject({ status: 'failed' });
    expect(committed).toMatchObject({ status: 'failed', ledgerUpdates: [ledgerUpdate], interactionUpdates: [] });
  });

  it.each([
    ['provider failure', new Error('provider failed'), 'failed'],
    ['unknown tool result', Object.assign(new Error('unknown result'), { code: 'TOOL_RESULT_UNKNOWN' }), 'recovery_required'],
  ] as const)('persists authoritative entry usage after %s', async (_name, failure, expectedStatus) => {
    const store = new MemoryRunStore();
    let finished = false;
    const root = messageEntryForUsage(`terminal-root-${expectedStatus}`, null, 'user');
    const assistant = messageEntryForUsage(`terminal-leaf-${expectedStatus}`, root.id, 'assistant', {
      input: 7, output: 3, cacheRead: 1, cacheWrite: 2, costTotal: 0.4,
    });
    const session: ManagedPiSession = {
      ...emptySession(`terminal-session-${expectedStatus}`),
      async *continue() {
        yield { tenantId: '', runId: '', sequence: 1n, type: 'message_end', attemptId: '', turnNo: 0,
          kernel: 'pi', kernelVersion: '0.82.1', correlationId: expectedStatus, createdAt: new Date(),
          detail: { message: { usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 2, costTotal: 0.4 } } } };
        finished = true;
        throw failure;
      },
      async entries() { return finished ? [root, assistant] : [root]; },
      async leafId() { return assistant.id; },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const runId = `terminal-${expectedStatus}`;
    const result = await (await manager.run({
      runId, identity, sessionId: `terminal-session-${expectedStatus}`, input: [{ role: 'user', text: 'start' }],
    })).result();
    const expectedUsage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 2, costUsd: 0.4 };
    expect(result).toMatchObject({ status: expectedStatus, usage: expectedUsage });
    expect((await store.get({ tenantId: identity.tenantId, runId }))?.usage).toEqual(expectedUsage);
    expect(await store.listEvents({ tenantId: identity.tenantId, runId })).toHaveLength(1);
  });

  it('persists authoritative entry usage when cancellation follows a usage event', async () => {
    const store = new MemoryRunStore();
    let usageProcessed!: () => void;
    const processed = new Promise<void>((resolve) => { usageProcessed = resolve; });
    let assistantAvailable = false;
    const root = messageEntryForUsage('cancel-root', null, 'user');
    const assistant = messageEntryForUsage('cancel-leaf', root.id, 'assistant', {
      input: 5, output: 2, cacheRead: 1, cacheWrite: 0, costTotal: 0.2,
    });
    const session: ManagedPiSession = {
      ...emptySession('cancel-usage-session'),
      async *continue(signal) {
        const activeSignal = signal!;
        assistantAvailable = true;
        yield { tenantId: '', runId: '', sequence: 1n, type: 'message_end', attemptId: '', turnNo: 0,
          kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'cancel-usage', createdAt: new Date(),
          detail: { message: { usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, costTotal: 0.2 } } } };
        usageProcessed();
        await new Promise<never>((_resolve, reject) => {
          const fail = () => reject(activeSignal.reason);
          if (activeSignal.aborted) fail();
          else activeSignal.addEventListener('abort', fail, { once: true });
        });
      },
      async entries() { return assistantAvailable ? [root, assistant] : [root]; },
      async leafId() { return assistant.id; },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const runId = 'cancel-usage-run';
    const handle = await manager.run({
      runId, identity, sessionId: 'cancel-usage-session', input: [{ role: 'user', text: 'start' }],
    });
    await processed;
    await manager.cancel({ identity, runId, reason: 'stop after usage' });
    const result = await handle.result();
    const expectedUsage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheCreationTokens: 0, costUsd: 0.2 };
    expect(result).toMatchObject({ status: 'cancelled', usage: expectedUsage });
    expect((await store.get({ tenantId: identity.tenantId, runId }))?.usage).toEqual(expectedUsage);
    expect(await store.listEvents({ tenantId: identity.tenantId, runId })).toHaveLength(1);
  });

  it.each(['queued', 'waiting'] as const)(
    'atomically cancels an inactive %s run without a local worker',
    async (status) => {
      const store = new MemoryRunStore();
      const now = new Date('2026-07-29T10:00:00.000Z');
      const runId = `inactive-${status}`;
      await store.create({ record: {
        tenantId: identity.tenantId, runId, actorId: identity.actorId, sessionId: `session-${status}`,
        kernel: 'pi', kernelVersion: '0.82.1', status, waitingReason: status === 'waiting' ? 'approval' : undefined,
        leaseToken: 0n, usage, createdAt: now, updatedAt: now,
      } });
      const manager = new DurableRunManager({
        store, heartbeatMs: 0,
        sessions: { create: async () => emptySession('unused'), load: async () => emptySession('unused') },
        eventOptions: () => ({}), now: () => new Date(now.getTime() + 1),
      });

      await manager.cancel({ identity, runId, reason: 'session terminated' });

      expect(await store.get({ tenantId: identity.tenantId, runId })).toMatchObject({
        status: 'cancelled', cancelReason: 'session terminated', errorMessage: 'session terminated',
        appendClosedAt: expect.any(Date),
        leaseOwner: undefined, leaseExpiresAt: undefined,
      });
    },
  );

  it('keeps a running live lease request-only until its worker commits cancellation', async () => {
    const store = new MemoryRunStore();
    const now = new Date('2026-07-29T10:01:00.000Z');
    await store.create({ record: {
      tenantId: identity.tenantId, runId: 'live-running', actorId: identity.actorId, sessionId: 'live-session',
      kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    await store.claim({ identity, runId: 'live-running', workerId: 'remote-worker', now, leaseTtlMs: 60_000 });
    const manager = new DurableRunManager({
      store, heartbeatMs: 0,
      sessions: { create: async () => emptySession('unused'), load: async () => emptySession('unused') },
      eventOptions: () => ({}), now: () => new Date(now.getTime() + 1),
    });

    await manager.cancel({ identity, runId: 'live-running', reason: 'stop remotely' });

    expect(await store.get({ tenantId: identity.tenantId, runId: 'live-running' })).toMatchObject({
      status: 'running', cancelRequestedAt: expect.any(Date), leaseOwner: 'remote-worker',
    });
  });

  it('passes an already-aborted external signal into the session immediately', async () => {
    const store = new MemoryRunStore();
    const external = new AbortController();
    const reason = new Error('already stopped');
    external.abort(reason);
    let received: AbortSignal | undefined;
    const session: ManagedPiSession = {
      ...emptySession('already-aborted-session'),
      async *continue(signal) {
        received = signal!;
        signal!.throwIfAborted();
      },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const result = await (await manager.run({
      runId: 'already-aborted-run', identity, sessionId: 'already-aborted-session',
      input: [{ role: 'user', text: 'start' }], signal: external.signal,
    })).result();
    expect(received?.aborted).toBe(true);
    expect(received?.reason).toBe(reason);
    expect(result.status).toBe('recovery_required');
  });

  it('establishes the append cutoff before its final inbox drain', async () => {
    const calls: string[] = [];
    const base = new MemoryRunStore();
    const store = new Proxy(base, {
      get(target, property) {
        if (property === 'closeInbox') return async (...args: unknown[]) => {
          calls.push('close');
          return Reflect.apply(target.closeInbox, target, args);
        };
        if (property === 'inbox') return {
          ...target.inbox,
          claimNext: async (...args: unknown[]) => {
            calls.push('drain');
            return (target.inbox.claimNext as (...values: unknown[]) => Promise<unknown>)(...args);
          },
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const session = emptySession('cutoff-session');
    const manager = new DurableRunManager({
      store: store as never, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const result = await (await manager.run({
      runId: 'cutoff-run', identity, sessionId: 'cutoff-session', input: [{ role: 'user', text: 'start' }],
    })).result();
    expect(result.status).toBe('succeeded');
    expect(calls.lastIndexOf('close')).toBeGreaterThanOrEqual(0);
    expect(calls.lastIndexOf('close')).toBeLessThan(calls.lastIndexOf('drain'));
  });

  it('does not charge a new run for tool calls from a previous run in the same session', async () => {
    const store = new MemoryRunStore();
    const sessionId = 'shared-tool-budget-session';
    const oldToolEntry = toolCallEntry('old-tool-entry', null, 'old-call');
    const firstSession: ManagedPiSession = {
      ...emptySession(sessionId),
      async *continue() {
        yield toolEvent('tool_execution_start', 'old-call');
        yield toolEvent('tool_result', 'old-call');
      },
      async entries() { return [oldToolEntry]; }, async leafId() { return oldToolEntry.id; },
    };
    const secondSession: ManagedPiSession = {
      ...emptySession(sessionId), async entries() { return [oldToolEntry]; }, async leafId() { return oldToolEntry.id; },
    };
    let createCount = 0;
    const manager = new DurableRunManager({
      store, heartbeatMs: 0,
      sessions: {
        create: async () => (++createCount === 1 ? firstSession : secondSession),
        load: async () => secondSession,
      },
      eventOptions: () => ({}),
    });
    expect((await (await manager.run({
      runId: 'tool-run-one', identity, sessionId, input: [{ role: 'user', text: 'first' }], limits: { maxToolCalls: 1 },
    })).result()).status).toBe('succeeded');

    const second = await (await manager.run({
      runId: 'tool-run-two', identity, sessionId, input: [{ role: 'user', text: 'second' }], limits: { maxToolCalls: 0 },
    })).result();
    expect(second.status).toBe('succeeded');
  });

  it('does not charge tool calls from an abandoned session branch', async () => {
    const store = new MemoryRunStore();
    const root = messageEntryForUsage('branch-root', null, 'user');
    const abandoned = toolCallEntry('abandoned-tool', root.id, 'abandoned-call');
    const current = messageEntryForUsage('branch-current', root.id, 'user');
    const session: ManagedPiSession = {
      ...emptySession('abandoned-branch-session'),
      async entries() { return [root, abandoned, current]; }, async leafId() { return current.id; },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const result = await (await manager.run({
      runId: 'abandoned-branch-run', identity, sessionId: 'abandoned-branch-session',
      input: [{ role: 'user', text: 'continue current branch' }], limits: { maxToolCalls: 0 },
    })).result();
    expect(result.status).toBe('succeeded');
  });

  it('carries the same run tool-call budget across a resumed attempt without double counting results', async () => {
    const store = new MemoryRunStore();
    const runId = 'resumed-tool-budget';
    const sessionId = 'resumed-tool-session';
    const firstSession: ManagedPiSession = {
      ...emptySession(sessionId),
      async *continue() {
        yield toolEvent('tool_execution_start', 'prior-call');
        yield toolEvent('tool_result', 'prior-call');
        throw new Error('provider failed after tool result');
      },
    };
    const resumedSession: ManagedPiSession = {
      ...emptySession(sessionId), async *continue() { yield toolEvent('tool_execution_start', 'current-call'); },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0,
      sessions: { create: async () => firstSession, load: async () => resumedSession },
      eventOptions: () => ({}),
    });

    const firstResult = await (await manager.run({
      runId, identity, sessionId, input: [{ role: 'user', text: 'first attempt' }], limits: { maxToolCalls: 1 },
    })).result();
    expect(firstResult.status).toBe('failed');
    expect((await store.sessions.get(identity.tenantId, piSessionStorageId(identity.actorId, sessionId)))?.committedLeafId).toBeNull();
    expect((await store.listEvents({ tenantId: identity.tenantId, runId })).map((event) => event.detail)).toEqual([
      expect.objectContaining({ toolCallId: 'prior-call' }),
      expect.objectContaining({ toolCallId: 'prior-call' }),
    ]);

    const result = await (await manager.resume({ identity, runId })).result();
    expect(result).toMatchObject({ status: 'failed', error: { code: 'RUN_LIMIT_EXCEEDED', message: 'Maximum tool calls exceeded' } });
    expect((await store.listEvents({ tenantId: identity.tenantId, runId })).map((event) =>
      (event.detail as { toolCallId?: string } | undefined)?.toolCallId)).toEqual(['prior-call', 'prior-call', 'current-call']);
  });

  it.each([
    [{ maxAttempts: 0 }, 'Maximum attempts exceeded'],
    [{ maxTurns: 0 }, 'Maximum turns exceeded'],
    [{ deadlineAt: new Date('2020-01-01T00:00:00.000Z') }, 'Run deadline exceeded'],
  ] as const)('enforces pre-execution run limits %j', async (limits, message) => {
    const manager = new DurableRunManager({
      store: new MemoryRunStore(), sessions: { create: async () => { throw new Error('session must not start'); }, load: async () => { throw new Error('session must not load'); } },
      eventOptions: () => ({}), now: () => new Date('2026-07-28T00:00:00.000Z'), heartbeatMs: 0,
    });
    const handle = await manager.run({
      runId: `limit-${message}`, identity, sessionId: `session-${message}`, input: [{ role: 'user', text: 'start' }], limits,
    });
    await expect(handle.result()).rejects.toThrow(message);
  });

  it('rejects maxTurns before claiming or reopening the run', async () => {
    const store = new MemoryRunStore();
    const manager = new DurableRunManager({
      store, sessions: { create: async () => { throw new Error('session must not start'); }, load: async () => { throw new Error('session must not load'); } },
      eventOptions: () => ({}), heartbeatMs: 0,
    });
    const handle = await manager.run({
      runId: 'preclaim-max-turns', identity, sessionId: 'preclaim-max-turns-session',
      input: [{ role: 'user', text: 'start' }], limits: { maxTurns: 0 },
    });
    await expect(handle.result()).rejects.toThrow('Maximum turns exceeded');
    await expect(store.get({ tenantId: identity.tenantId, runId: 'preclaim-max-turns' })).resolves.toMatchObject({
      status: 'queued', leaseToken: 0n,
    });
    const stored = await store.get({ tenantId: identity.tenantId, runId: 'preclaim-max-turns' });
    expect(stored?.leaseOwner).toBeUndefined();
    expect(stored?.appendClosedAt).toBeUndefined();
    expect(await store.countAttempts({ tenantId: identity.tenantId, runId: 'preclaim-max-turns' })).toBe(0);
  });

  it.each([
    ['input', { maxInputTokens: 1 }, 'message_end', { message: { usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } } }],
    ['output', { maxOutputTokens: 1 }, 'message_end', { message: { usage: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 } } }],
    ['cost', { maxCostUsd: 0.1 }, 'message_end', { message: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0.2 } } }],
    ['tool', { maxToolCalls: 0 }, 'tool_execution_start', { toolCallId: 'call-a', toolName: 'write' }],
  ] as const)('enforces observed %s limits during execution', async (name, limits, type, detail) => {
    const store = new MemoryRunStore();
    let terminal = false;
    const session: ManagedPiSession = {
      ...emptySession(`limit-${name}`),
      async entries() {
        if (!terminal) return [];
        throw new Error('terminal entries unavailable');
      },
      async *continue() {
        try {
          yield {
            tenantId: '', runId: '', sequence: 1n, type, attemptId: '', turnNo: 0,
            kernel: 'pi', kernelVersion: '0.82.1', correlationId: name, createdAt: new Date(), detail,
          };
        } finally {
          terminal = true;
        }
      },
    };
    const manager = new DurableRunManager({
      store, heartbeatMs: 0, sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const result = await (await manager.run({
      runId: `observed-${name}`, identity, sessionId: `limit-${name}`, input: [{ role: 'user', text: 'start' }], limits,
    })).result();
    expect(result).toMatchObject({ status: 'failed', error: { code: 'RUN_LIMIT_EXCEEDED' } });
    if (name === 'cost') expect(result.error?.message).toBe('Maximum cost exceeded');
    if (name !== 'tool') {
      const eventUsage = (detail as { message: { usage: Record<string, number> } }).message.usage;
      expect(result.usage).toMatchObject({
        inputTokens: eventUsage.input, outputTokens: eventUsage.output,
        cacheReadTokens: eventUsage.cacheRead, cacheCreationTokens: eventUsage.cacheWrite,
        ...(eventUsage.costTotal === undefined ? {} : { costUsd: eventUsage.costTotal }),
      });
      expect((await store.get({ tenantId: identity.tenantId, runId: `observed-${name}` }))?.usage).toEqual(result.usage);
    }
  });
});

function messageEntryForUsage(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  usageDetail?: { input: number; output: number; cacheRead: number; cacheWrite: number; costTotal: number },
) {
  if (role === 'user') return {
    type: 'message' as const, id, parentId, timestamp: new Date().toISOString(),
    message: { role: 'user' as const, content: 'start', timestamp: Date.now() },
  };
  const values = usageDetail!;
  return {
    type: 'message' as const, id, parentId, timestamp: new Date().toISOString(),
    message: {
      role: 'assistant' as const, content: [{ type: 'text' as const, text: 'answer' }], api: 'test', provider: 'test', model: 'test',
      stopReason: 'stop' as const, timestamp: Date.now(),
      usage: { input: values.input, output: values.output, cacheRead: values.cacheRead, cacheWrite: values.cacheWrite,
        totalTokens: values.input + values.output + values.cacheRead + values.cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: values.costTotal } },
    },
  };
}

function toolCallEntry(id: string, parentId: string | null, callId: string) {
  return {
    type: 'message' as const, id, parentId, timestamp: new Date().toISOString(),
    message: {
      role: 'assistant' as const,
      content: [{ type: 'toolCall' as const, id: callId, name: 'lookup', arguments: {} }],
      api: 'test', provider: 'test', model: 'test', stopReason: 'toolUse' as const, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  };
}

function toolEvent(type: 'tool_execution_start' | 'tool_result', toolCallId: string): AgentRunEvent {
  return {
    tenantId: '', runId: '', sequence: 1n, type, attemptId: '', turnNo: 0, kernel: 'pi', kernelVersion: '0.82.1',
    correlationId: toolCallId, detail: { toolCallId, toolName: 'lookup' }, createdAt: new Date(),
  };
}

async function runAtomicSessionClassificationRace(base: DurableRunStore, suffix: string) {
  let reservationStarted = false;
  let createCalls = 0;
  let preReservationGets = 0;
  let releasePreObservations!: () => void;
  const bothPreObserved = new Promise<void>((resolve) => { releasePreObservations = resolve; });
  let releaseSecondReservation!: () => void;
  const firstRunCompleted = new Promise<void>((resolve) => { releaseSecondReservation = resolve; });
  const sessions = new Proxy(base.sessions, {
    get(target, property) {
      if (property === 'get') return async (tenantId: string, sessionId: string) => {
        if (!reservationStarted) {
          preReservationGets += 1;
          if (preReservationGets === 2) releasePreObservations();
          await bothPreObserved;
          return undefined;
        }
        return target.get(tenantId, sessionId);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = new Proxy(base, {
    get(target, property) {
      if (property === 'sessions') return sessions;
      if (property === 'create') return async (...args: Parameters<DurableRunStore['create']>) => {
        reservationStarted = true;
        createCalls += 1;
        if (createCalls === 2) await firstRunCompleted;
        return target.create(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const sessionId = `atomic-session-classification-${suffix}`;
  const runIds = [`atomic-first-run-${suffix}`, `atomic-second-run-${suffix}`] as const;
  const failedSession: ManagedPiSession = {
    ...emptySession(sessionId), async *continue() { throw new Error('first run failed'); },
  };
  const committedSession = emptySession(sessionId);
  let factoryCreates = 0;
  let factoryLoads = 0;
  const manager = new DurableRunManager({
    store, heartbeatMs: 0,
    sessions: {
      create: async () => {
        factoryCreates += 1;
        if (factoryCreates > 1) throw new Error('stale pre-observation selected current leaf');
        return failedSession;
      },
      load: async () => { factoryLoads += 1; return committedSession; },
    },
    eventOptions: () => ({}),
  });

  const firstHandlePromise = manager.run({
    runId: runIds[0], identity, sessionId, input: [{ role: 'user', text: 'first' }],
  });
  const secondHandlePromise = manager.run({
    runId: runIds[1], identity, sessionId, input: [{ role: 'user', text: 'second' }],
  });
  const firstResult = await (await firstHandlePromise).result();
  releaseSecondReservation();
  const secondResult = await (await secondHandlePromise).result();
  return {
    firstStatus: firstResult.status, secondStatus: secondResult.status, factoryCreates, factoryLoads, sessionId, runIds,
  };
}

function emptySession(id: string): ManagedPiSession {
  return {
    async *continue() {}, async entries() { return []; }, async leafId() { return null; },
    async replayInteraction() {},
    async metadata() { return { id, tenantId: 'tenant-a', createdAt: new Date().toISOString() }; },
    async abort() {}, async close() {}, async steer() {}, async followUp() {}, async appendCustomEntry() { return 'marker'; },
  };
}

async function seedResolvedWaitingReplay(store: MemoryRunStore, runId: string) {
  const now = new Date('2026-07-30T00:00:00.000Z');
  const toolCallId = `call-${runId}`;
  const logicalCallId = `logical-${runId}`;
  const interactionId = `approval-${runId}`;
  await store.create({ record: {
    tenantId: identity.tenantId, runId, actorId: identity.actorId, sessionId: `session-${runId}`,
    kernel: 'pi', kernelVersion: '0.82.1', status: 'waiting', waitingReason: 'approval', leaseToken: 0n,
    usage, createdAt: now, updatedAt: now,
  } });
  await store.toolLedger.putIfAbsent({
    tenantId: identity.tenantId, runId, attemptId: 'attempt-waiting', turnNo: 1,
    logicalCallId, toolCallId, toolName: 'deploy', argsDigest: 'digest', capability: 'retryable_write',
    idempotencyKey: `key-${runId}`, approvedInteractionId: interactionId,
    status: 'pending_approval', createdAt: now, updatedAt: now,
  });
  const pending = {
    tenantId: identity.tenantId, runId, id: interactionId, attemptId: 'attempt-waiting', turnNo: 1,
    kind: 'approval' as const, toolCallId, status: 'pending' as const,
    payload: { call: { id: toolCallId, name: 'deploy', args: {} } }, createdAt: now,
  };
  await store.interactions.put(pending);
  await store.resolveInteraction({ ...pending, status: 'resolved', resolution: true, resolvedAt: now });
  return { toolCallId, logicalCallId, interactionId };
}

type MysqlContractRow = Record<string, any>;

class MysqlInteractionReadDb {
  constructor(private readonly row: MysqlContractRow) {}

  selectFrom() { return new MysqlInteractionReadSelect(this.row); }
}

class MysqlInteractionReadSelect {
  constructor(private readonly row: MysqlContractRow) {}

  selectAll() { return this; }
  where() { return this; }
  orderBy() { return this; }
  async executeTakeFirst() { return { ...this.row }; }
  async execute() { return [{ ...this.row }]; }
}

class MysqlCreateContractDb {
  readonly rows = { pi_sessions: [] as MysqlContractRow[], agent_runs: [] as MysqlContractRow[] };

  transaction() {
    return { execute: async <T>(work: (db: MysqlCreateContractDb) => Promise<T>) => work(this) };
  }

  insertInto(table: keyof MysqlCreateContractDb['rows']) { return new MysqlContractInsert(this, table); }
  selectFrom(table: keyof MysqlCreateContractDb['rows']) { return new MysqlContractSelect(this, table); }
}

class MysqlContractInsert {
  private value!: MysqlContractRow;
  private ignored = false;

  constructor(
    private readonly db: MysqlCreateContractDb,
    private readonly table: keyof MysqlCreateContractDb['rows'],
  ) {}

  values(value: MysqlContractRow) { this.value = value; return this; }
  ignore() { this.ignored = true; return this; }

  async executeTakeFirst() {
    const rows = this.db.rows[this.table];
    const duplicate = this.table === 'pi_sessions' && rows.some((row) =>
      row.tenant_id === this.value.tenant_id && row.session_id === this.value.session_id);
    if (!duplicate) rows.push({ ...this.value });
    else if (!this.ignored) throw new Error('duplicate key');
    return { numInsertedOrUpdatedRows: duplicate ? 0n : 1n };
  }

  async execute() { await this.executeTakeFirst(); return []; }
}

class MysqlContractSelect {
  private readonly filters: Array<(row: MysqlContractRow) => boolean> = [];
  private columns?: string[];
  private limitCount?: number;

  constructor(
    private readonly db: MysqlCreateContractDb,
    private readonly table: keyof MysqlCreateContractDb['rows'],
  ) {}

  select(columns: string | string[]) { this.columns = Array.isArray(columns) ? columns : [columns]; return this; }
  where(column: string, operator: string, value: unknown) {
    this.filters.push((row) => operator === '=' ? row[column] === value
      : operator === 'in' ? (value as unknown[]).includes(row[column]) : false);
    return this;
  }
  forUpdate() { return this; }
  limit(count: number) { this.limitCount = count; return this; }

  async execute() {
    let rows = this.db.rows[this.table].filter((row) => this.filters.every((filter) => filter(row)));
    if (this.limitCount !== undefined) rows = rows.slice(0, this.limitCount);
    return rows.map((row) => this.columns
      ? Object.fromEntries(this.columns.map((column) => [column, row[column]]))
      : { ...row });
  }

  async executeTakeFirst() { return (await this.execute())[0]; }
  async executeTakeFirstOrThrow() {
    const row = await this.executeTakeFirst();
    if (!row) throw new Error('not found');
    return row;
  }
}
