import { describe, expect, it, vi } from 'vitest';
import { drainDurableInbox, DurableRunManager, MemoryRunStore, type ManagedPiSession } from '../../packages/pi-runtime/src/index.js';

describe('durable Pi recovery', () => {
  it('advances committed leaf only as part of a fenced turn commit', async () => {
    const store = new MemoryRunStore();
    const now = new Date('2026-07-28T00:00:00.000Z');
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 };
    await store.create({ record: {
      tenantId: 'tenant-a', runId: 'run-a', actorId: 'user-a', sessionId: 'session-a', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    await store.sessions.create({ tenantId: 'tenant-a', sessionId: 'session-a', createdAt: now });
    const claim = await store.claim({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] }, runId: 'run-a',
      workerId: 'worker-a', now, leaseTtlMs: 1000,
    });
    await store.sessions.appendEntry('tenant-a', 'session-a', {
      type: 'message', id: 'uncommitted', parentId: null, timestamp: now.toISOString(),
      message: { role: 'user', content: 'work', timestamp: now.getTime() },
    });
    expect((await store.sessions.get('tenant-a', 'session-a'))?.committedLeafId).toBeNull();
    await store.commitTurn({
      tenantId: 'tenant-a', runId: 'run-a', attemptId: claim!.attemptId, turnNo: 1,
      fencingToken: claim!.fencingToken, checkpoint: { piSessionId: 'session-a', piLeafId: 'uncommitted' },
      events: [], status: 'succeeded', usage, committedAt: now,
    });
    expect((await store.sessions.get('tenant-a', 'session-a'))?.committedLeafId).toBe('uncommitted');
  });
});

describe('fault recovery boundaries', () => {
  it('observes cross-worker cancellation while the active session produces no events', async () => {
    const store = new MemoryRunStore();
    let aborted!: () => void;
    const abortCalled = new Promise<void>((resolve) => { aborted = resolve; });
    const session: ManagedPiSession = {
      async *continue(signal) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      async abort() { aborted(); }, async close() {}, async steer() {}, async followUp() {},
      async appendCustomEntry() { return 'custom'; }, async entries() { return []; }, async leafId() { return null; },
      async metadata() { return { id: 'session-stalled', tenantId: 'tenant-a', createdAt: new Date().toISOString() }; },
    };
    const manager = new DurableRunManager({
      store, workerId: 'worker-a', heartbeatMs: 0, inboxPollMs: 1,
      sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
    const handle = await manager.run({
      runId: 'run-stalled-cancel', identity, sessionId: 'session-stalled', input: [{ role: 'user', text: 'start' }],
    });
    await vi.waitFor(async () => expect((await store.get({ tenantId: 'tenant-a', runId: 'run-stalled-cancel' }))?.status).toBe('running'));
    await store.requestCancellation({
      identity: { tenantId: 'tenant-a', actorId: 'admin', roles: ['tenant_admin'] },
      runId: 'run-stalled-cancel', requestedAt: new Date(), reason: 'stop elsewhere',
    });

    await abortCalled;
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('does not recover a waiting interaction without an explicit resolution', async () => {
    const store = new MemoryRunStore();
    const now = new Date();
    await store.create({ record: {
      tenantId: 'tenant-a', runId: 'run-waiting', actorId: 'user-a', sessionId: 'session-waiting', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'waiting', waitingReason: 'question', leaseToken: 0n,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, createdAt: now, updatedAt: now,
    } });
    const manager = new DurableRunManager({
      store, sessions: { create: async () => { throw new Error('unused'); }, load: async () => { throw new Error('must not load'); } },
      eventOptions: () => ({}),
    });
    await expect(manager.resume({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] }, runId: 'run-waiting',
    })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  });

  it('rejects duplicate recovery while the first recovery owns the run', async () => {
    const store = new MemoryRunStore();
    const now = new Date();
    await store.create({ record: {
      tenantId: 'tenant-a', runId: 'run-duplicate', actorId: 'user-a', sessionId: 'session-duplicate', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'failed', leaseToken: 0n,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, createdAt: now, updatedAt: now,
    } });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const session: ManagedPiSession = {
      async *continue() { await wait; }, async abort() { release(); }, async close() {}, async steer() {}, async followUp() {},
      async appendCustomEntry() { return 'custom'; }, async entries() { return []; }, async leafId() { return null; },
      async metadata() { return { id: 'session-duplicate', tenantId: 'tenant-a', createdAt: now.toISOString() }; },
    };
    const manager = new DurableRunManager({
      store, workerId: 'worker-a', heartbeatMs: 0, sessions: { create: async () => session, load: async () => session },
      eventOptions: () => ({}),
    });
    const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
    const first = await manager.resume({ identity, runId: 'run-duplicate' });
    await expect(manager.resume({ identity, runId: 'run-duplicate' }))
      .rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
    release();
    await first.result();
  });

  it('persists recovery_required instead of auto-replaying an uncertain non-idempotent failure', async () => {
    const store = new MemoryRunStore();
    const error = Object.assign(new Error('external result unknown'), { code: 'TOOL_RESULT_UNKNOWN' });
    const session: ManagedPiSession = {
      async *continue() { throw error; }, async abort() {}, async close() {}, async steer() {}, async followUp() {},
      async appendCustomEntry() { return 'custom'; }, async entries() { return []; }, async leafId() { return null; },
      async metadata() { return { id: 'session-unknown', tenantId: 'tenant-a', createdAt: new Date().toISOString() }; },
    };
    const manager = new DurableRunManager({
      store, workerId: 'worker-a', heartbeatMs: 0, sessions: { create: async () => session, load: async () => session },
      eventOptions: () => ({}),
    });
    const handle = await manager.run({
      runId: 'run-unknown', identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-unknown', input: [{ role: 'user', text: 'write externally' }],
    });
    await expect(handle.result()).resolves.toMatchObject({ status: 'recovery_required' });
    expect((await store.get({ tenantId: 'tenant-a', runId: 'run-unknown' }))?.status).toBe('recovery_required');
  });

  it('lets durable cancellation win a race with turn commit', async () => {
    const store = new MemoryRunStore();
    const now = new Date('2026-07-28T00:00:00.000Z');
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
    await store.create({ record: {
      tenantId: 'tenant-a', runId: 'run-cancel-race', actorId: 'user-a', sessionId: 'session-a', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    const claim = await store.claim({ identity, runId: 'run-cancel-race', workerId: 'worker-a', now, leaseTtlMs: 1000 });
    await store.requestCancellation({ identity, runId: 'run-cancel-race', requestedAt: now, reason: 'stop' });
    await expect(store.commitTurn({
      tenantId: 'tenant-a', runId: 'run-cancel-race', attemptId: claim!.attemptId, turnNo: 1,
      fencingToken: claim!.fencingToken, checkpoint: {}, events: [], status: 'succeeded', usage, committedAt: now,
    })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  });

  it('reconciles a Pi-consumed inbox command after the ack worker crashes', async () => {
    let current = new Date('2026-07-28T00:00:00.000Z');
    const store = new MemoryRunStore(() => current);
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
    await store.create({ record: {
      tenantId: 'tenant-a', runId: 'run-inbox-crash', actorId: 'user-a', sessionId: 'session-a', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: current, updatedAt: current,
    } });
    const first = await store.claim({ identity, runId: 'run-inbox-crash', workerId: 'worker-a', now: current, leaseTtlMs: 10 });
    const item = await store.inbox.enqueue({
      identity,
      tenantId: 'tenant-a', runId: 'run-inbox-crash', idempotencyKey: 'once', mode: 'steer',
      message: { role: 'user', text: 'only once' }, createdAt: current,
    });
    await store.inbox.claimNext({
      tenantId: 'tenant-a', runId: 'run-inbox-crash', workerId: 'worker-a', fencingToken: first!.fencingToken,
      now: current, claimTtlMs: 10,
    });
    current = new Date(current.getTime() + 11);
    const second = await store.claim({ identity, runId: 'run-inbox-crash', workerId: 'worker-b', now: current, leaseTtlMs: 1000 });
    let deliveries = 0;
    await drainDurableInbox({
      store,
      session: {
        async steer() { deliveries += 1; }, async followUp() { deliveries += 1; },
        async appendCustomEntry() { return 'unused'; },
      },
      entries: [{
        type: 'custom', customType: 'aiop.inbox_consumed', data: { inboxMessageId: item.id }, id: 'custom-a',
        parentId: null, timestamp: current.toISOString(),
      }],
      tenantId: 'tenant-a', runId: 'run-inbox-crash', workerId: 'worker-b', fencingToken: second!.fencingToken,
      now: () => current, claimTtlMs: 10,
    });
    expect(deliveries).toBe(0);
    expect((await store.inbox.list('tenant-a', 'run-inbox-crash'))[0]?.status).toBe('consumed');
  });
});
