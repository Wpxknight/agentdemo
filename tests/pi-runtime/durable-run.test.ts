import { describe, expect, it } from 'vitest';
import { LeaseLostError } from '@aiop/control-contracts';
import { DurableRunManager, MemoryRunStore, MysqlRunStore } from '../../packages/pi-runtime/src/index.js';
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
});

describe('MysqlRunStore durable contract surface', () => {
  it('implements the same target RunStore and durable sub-ports as memory', () => {
    for (const method of ['create', 'get', 'claim', 'renewLease', 'commitTurn', 'requestCancellation', 'complete'] as const) {
      expect(typeof MysqlRunStore.prototype[method]).toBe('function');
    }
  });
});

async function runStoreContract(store: DurableRunStore, runId: string): Promise<void> {
  const identity = { tenantId: 'pi-runtime-contract', actorId: 'user-a', roles: ['user'] } as const;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const start = new Date('2026-07-28T00:00:00.000Z');
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
  })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  await store.complete({
    tenantId: identity.tenantId, runId, attemptId: second!.attemptId, fencingToken: second!.fencingToken,
    status: 'succeeded', usage, completedAt: new Date(reclaimedAt.getTime() + 1),
  });
  expect((await store.get({ tenantId: identity.tenantId, runId }))?.status).toBe('cancelled');
  await expect(store.claim({
    identity, runId, workerId: 'worker-c', now: new Date(reclaimedAt.getTime() + 2), leaseTtlMs: 10,
  })).resolves.toBeNull();
}

describe('shared RunStore contract', () => {
  it('passes claim, renew, lease loss, cancellation race, and terminal semantics in memory', async () => {
    await runStoreContract(new MemoryRunStore(() => new Date('2026-07-28T00:00:00.012Z')), 'memory-contract');
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
      for (const table of ['agent_run_inbox_messages', 'agent_run_events', 'agent_turn_commits', 'agent_run_attempts', 'agent_runs'] as const) {
        await db.deleteFrom(table).where('tenant_id', '=', 'pi-runtime-contract').where('run_id', '=', runId).execute();
      }
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
      async entries() { return [{
        type: 'message', id: 'leaf-a', parentId: null, timestamp: '2026-07-28T00:00:00.000Z',
        message: { role: 'user', content: 'start', timestamp: 1 },
      }]; },
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
    await expect(handle.result()).resolves.toMatchObject({ status: 'succeeded' });
    expect(continued).toBe(1);
    expect((await store.sessions.get('tenant-a', 'session-a'))?.committedLeafId).toBe('leaf-a');
    expect(await store.listEvents({ tenantId: 'tenant-a', runId: 'run-manager' })).toHaveLength(2);
  });
});
