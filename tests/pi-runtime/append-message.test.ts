import { describe, expect, it } from 'vitest';
import { DurableRunManager, MemoryRunStore, type ManagedPiSession } from '../../packages/pi-runtime/src/index.js';
import type { AgentRunEvent } from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';

describe('durable run inbox', () => {
  it('deduplicates commands and reclaims an expired claim in sequence order', async () => {
    const store = new MemoryRunStore();
    const now = new Date('2026-07-28T00:00:00.000Z');
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    await store.create({ record: {
      tenantId: 'tenant-a', runId: 'run-a', actorId: 'user-a', sessionId: 'session-a', kernel: 'pi',
      kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, usage, createdAt: now, updatedAt: now,
    } });
    const firstLease = await store.claim({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] }, runId: 'run-a',
      workerId: 'worker-a', now, leaseTtlMs: 10,
    });
    const input = {
      tenantId: 'tenant-a', runId: 'run-a', idempotencyKey: 'append-1', mode: 'steer' as const,
      message: { role: 'user' as const, text: 'please adjust' }, createdAt: now,
    };
    const first = await store.inbox.enqueue(input);
    const duplicate = await store.inbox.enqueue(input);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.sequence).toBe(1n);
    const claimed = await store.inbox.claimNext({
      tenantId: 'tenant-a', runId: 'run-a', workerId: 'worker-a', fencingToken: firstLease!.fencingToken, now, claimTtlMs: 10,
    });
    expect(claimed?.id).toBe(first.id);
    const secondLease = await store.claim({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] }, runId: 'run-a',
      workerId: 'worker-b', now: new Date(now.getTime() + 11), leaseTtlMs: 10,
    });
    const reclaimed = await store.inbox.claimNext({
      tenantId: 'tenant-a', runId: 'run-a', workerId: 'worker-b', fencingToken: secondLease!.fencingToken,
      now: new Date(now.getTime() + 11), claimTtlMs: 10,
    });
    expect(reclaimed?.id).toBe(first.id);
    expect(reclaimed?.claimToken).not.toBe(claimed?.claimToken);
  });

  it('rejects a claim when the tenant has no matching leased run', async () => {
    const store = new MemoryRunStore();
    await expect(store.inbox.claimNext({
      tenantId: 'tenant-b', runId: 'run-a', workerId: 'worker-a', fencingToken: 1n,
      now: new Date(), claimTtlMs: 10,
    })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
});

describe('active durable inbox delivery', () => {
  it('polls and steers Pi while continue is waiting without requiring an event yield', async () => {
    const store = new MemoryRunStore();
    let release!: () => void;
    const steered = new Promise<void>((resolve) => { release = resolve; });
    const entries: SessionTreeEntry[] = [{
      type: 'message', id: 'leaf-a', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'start', timestamp: Date.now() },
    }];
    const session: ManagedPiSession = {
      async *continue(): AsyncGenerator<AgentRunEvent> {
        await steered;
        yield {
          tenantId: 'tenant-a', runId: 'run-poll', sequence: 0n, type: 'done', attemptId: '', turnNo: 1,
          kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'done', createdAt: new Date(),
        };
      },
      async steer() { release(); }, async followUp() { release(); }, async abort() { release(); }, async close() {},
      async metadata() { return { id: 'session-poll', tenantId: 'tenant-a', createdAt: new Date().toISOString() }; },
      async entries() { return entries; },
      async leafId() { return entries.at(-1)?.id ?? null; },
      async appendCustomEntry(customType, data) {
        const id = `custom-${entries.length}`;
        entries.push({ type: 'custom', customType, data, id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString() });
        return id;
      },
    };
    const manager = new DurableRunManager({
      store, workerId: 'worker-a', leaseTtlMs: 1000, heartbeatMs: 0, inboxPollMs: 5,
      sessions: { create: async () => session, load: async () => session }, eventOptions: () => ({}),
    });
    const abort = new AbortController();
    const handle = await manager.run({
      runId: 'run-poll', identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-poll', input: [{ role: 'user', text: 'start' }], signal: abort.signal,
    });
    await manager.append({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] }, runId: 'run-poll',
      message: { role: 'user', text: 'steer now' }, mode: 'steer', idempotencyKey: 'poll-1',
    });
    const startedAt = Date.now();
    const timeout = setTimeout(() => { abort.abort(new Error('inbox was not polled')); release(); }, 100);
    const result = await handle.result();
    clearTimeout(timeout);
    expect(result.status).toBe('succeeded');
    expect(Date.now() - startedAt).toBeLessThan(80);
    expect(entries).toContainEqual(expect.objectContaining({ type: 'custom', customType: 'aiop.inbox_consumed' }));
  });
});
