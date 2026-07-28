import { describe, expect, it } from 'vitest';
import { LeaseLostError } from '@aiop/control-contracts';
import { createMysqlDurablePiRuntime, DurableRunManager, MemoryRunStore, MysqlRunStore } from '../../packages/pi-runtime/src/index.js';
import type { ManagedPiSession } from '../../packages/pi-runtime/src/index.js';
import type { AgentRunEvent } from '@aiop/control-contracts';
import type { DurableRunStore } from '../../packages/pi-runtime/src/index.js';
import { readMysqlConfig } from '../../src/config/mysql.js';
import { createKysely, createMysqlPool, runMigrations } from '../../src/db/index.js';

const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe('MemoryRunStore durable contract', () => {
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
      await db.deleteFrom('pi_session_entries').where('tenant_id', '=', 'pi-runtime-contract').where('session_id', '=', `session-${runId}-success`).execute();
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', 'pi-runtime-contract').where('session_id', '=', `session-${runId}-success`).execute();
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
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).execute();
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
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).execute();
      await db.destroy();
    }
  });
});

describe('DurableRunManager', () => {
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
    expect((await store.sessions.get('tenant-a', 'session-a'))?.committedLeafId).toBe('leaf-a');
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

function emptySession(id: string): ManagedPiSession {
  return {
    async *continue() {}, async entries() { return []; }, async leafId() { return null; },
    async metadata() { return { id, tenantId: 'tenant-a', createdAt: new Date().toISOString() }; },
    async abort() {}, async close() {}, async steer() {}, async followUp() {}, async appendCustomEntry() { return 'marker'; },
  };
}
