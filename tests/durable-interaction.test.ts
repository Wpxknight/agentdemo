import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/db/memory.js';
import { DurableInteractionService } from '../src/agent/interactions/store.js';
import { DurableToolLedger, RecoveryRequiredError } from '../src/agent/tool-ledger/store.js';
import type { RequestContext } from '../src/auth/types.js';

const owner: RequestContext = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  role: 'user',
};

describe('DurableInteractionService', () => {
  it('restores pending interactions after service restart and resolves once', async () => {
    const store = new MemoryStore();
    const first = new DurableInteractionService(store);
    const pending = await first.create({
      kind: 'question',
      tenantId: owner.tenantId,
      userId: owner.userId,
      sessionId: 'session-a',
      runId: 'run-a',
      payload: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const restarted = new DurableInteractionService(store);
    expect(await restarted.listPending(owner)).toMatchObject([{ id: pending.id, runId: 'run-a', status: 'pending' }]);
    await expect(restarted.resolve(owner, pending.id, {
      sessionId: 'session-a',
      runId: 'run-a',
      value: { 'Continue?': ['Yes'] },
    })).resolves.toMatchObject({ status: 'resolved' });
    await expect(restarted.resolve(owner, pending.id, {
      sessionId: 'session-a', runId: 'run-a', value: {},
    })).rejects.toThrow('已处理');
  });

  it('rejects cross-tenant, cross-user, mismatched run, and expired resolution', async () => {
    const store = new MemoryStore();
    const service = new DurableInteractionService(store);
    const create = (expiresAt: Date) => service.create({
      kind: 'question' as const,
      tenantId: owner.tenantId,
      userId: owner.userId,
      sessionId: 'session-a',
      runId: 'run-a',
      payload: {},
      expiresAt,
    });

    const pending = await create(new Date(Date.now() + 60_000));
    await expect(service.resolve({ ...owner, tenantId: 'tenant-b' }, pending.id, {
      sessionId: 'session-a', runId: 'run-a', value: {},
    })).rejects.toThrow('不存在');
    await expect(service.resolve({ ...owner, userId: 'user-b' }, pending.id, {
      sessionId: 'session-a', runId: 'run-a', value: {},
    })).rejects.toThrow('无权');
    await expect(service.resolve(owner, pending.id, {
      sessionId: 'session-a', runId: 'run-b', value: {},
    })).rejects.toThrow('运行不匹配');

    const expired = await create(new Date(Date.now() - 1));
    await expect(service.resolve(owner, expired.id, {
      sessionId: 'session-a', runId: 'run-a', value: {},
    })).rejects.toThrow('已过期');
  });
});

describe('DurableToolLedger', () => {
  it('reuses completed results and blocks unknown non-idempotent recovery', async () => {
    const store = new MemoryStore();
    const ledger = new DurableToolLedger(store);
    const identity = {
      tenantId: 'tenant-a', runId: 'run-a', sessionId: 'session-a',
      toolCallId: 'call-a', toolName: 'dangerous', args: { value: 1 },
    };
    expect(await ledger.begin(identity)).toEqual({ action: 'execute' });
    await ledger.complete(identity, { id: 'call-a', content: 'ok' });
    await expect(ledger.begin(identity)).resolves.toEqual({
      action: 'reuse', result: { id: 'call-a', content: 'ok' },
    });

    const uncertain = { ...identity, toolCallId: 'call-b' };
    expect(await ledger.begin(uncertain)).toEqual({ action: 'execute' });
    const restarted = new DurableToolLedger(store);
    await expect(restarted.begin(uncertain)).rejects.toBeInstanceOf(RecoveryRequiredError);
    expect((await store.getToolExecution('tenant-a', 'run-a', 'call-b'))?.status).toBe('recovery_required');
  });

  it('rejects the same idempotency key with different args', async () => {
    const store = new MemoryStore();
    const ledger = new DurableToolLedger(store);
    const base = {
      tenantId: 'tenant-a', runId: 'run-a', sessionId: 'session-a',
      toolCallId: 'call-a', toolName: 'echo', args: { value: 1 },
    };
    await ledger.begin(base);
    await expect(ledger.begin({ ...base, args: { value: 2 } })).rejects.toThrow('参数摘要不一致');
  });
});
