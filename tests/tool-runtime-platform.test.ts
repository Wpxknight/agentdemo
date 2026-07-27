import { describe, expect, it, vi } from 'vitest';
import { MemoryRuntimeStore } from '../packages/agent-runtime-core/src/memory-store.js';
import { PiToolOutputLimiter, ToolRuntimeEngine } from '../packages/tool-runtime/src/index.js';

const context = {
  identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
  runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
} as const;

describe('ToolRuntimeEngine', () => {
  it('executes the fixed production safety pipeline in order', async () => {
    const order: string[] = [];
    const store = new MemoryRuntimeStore();
    const runtime = new ToolRuntimeEngine({
      ledger: store.toolLedger,
      definitions: [{
        name: 'read', description: 'read', inputSchema: { type: 'object', required: ['id'] }, capability: 'read',
        execute: async () => { order.push('execute'); return { content: 'ok' }; },
      }],
      policy: { check: async () => { order.push('policy'); return { allowed: true, resourceKey: 'r1' }; } },
      approval: { request: async () => { order.push('approval'); return { approved: true, interactionId: 'approval-a' }; } },
      hooks: { before: async () => { order.push('hook'); return { allowed: true }; } },
      audit: { record: async () => { order.push('audit'); } },
      onLedger: () => { order.push('ledger'); },
      onLock: () => { order.push('lock'); },
    });
    const outcome = await runtime.execute({
      id: 'call-a', logicalCallId: 'logical-a', name: 'read', arguments: { id: 1 },
    }, context);
    expect(outcome).toMatchObject({ kind: 'result', result: { content: 'ok' } });
    expect(order).toEqual(['policy', 'approval', 'hook', 'ledger', 'lock', 'execute', 'audit']);
  });

  it('returns a durable wait before executing a tool that needs approval', async () => {
    const execute = vi.fn();
    const runtime = new ToolRuntimeEngine({
      ledger: new MemoryRuntimeStore().toolLedger,
      definitions: [{ name: 'write', description: 'write', inputSchema: { type: 'object' }, capability: 'retryable_write', execute }],
      policy: { check: async () => ({ allowed: true, needsApproval: true }) },
      approval: { request: async () => ({ approved: false, pending: true, interactionId: 'approval-a' }) },
    });
    await expect(runtime.execute({ id: 'call-a', logicalCallId: 'logical-a', name: 'write', arguments: {} }, context))
      .resolves.toEqual({ kind: 'waiting', reason: 'approval', interactionId: 'approval-a' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reuses completed calls and protects unknown non-idempotent writes', async () => {
    const execute = vi.fn(async () => ({ content: 'created' }));
    const store = new MemoryRuntimeStore();
    const runtime = new ToolRuntimeEngine({
      ledger: store.toolLedger,
      definitions: [{ name: 'create', description: 'create', inputSchema: { type: 'object' }, capability: 'non_idempotent_write', execute }],
      policy: { check: async () => ({ allowed: true }) },
    });
    const call = { id: 'call-a', logicalCallId: 'logical-a', name: 'create', arguments: {} } as const;
    const first = await runtime.execute(call, context);
    const reused = await runtime.execute(call, { ...context, attemptId: 'attempt-b' });
    expect(first).toEqual(reused);
    expect(execute).toHaveBeenCalledOnce();

    await store.toolLedger.putIfAbsent({
      tenantId: context.identity.tenantId, runId: context.runId, attemptId: context.attemptId, turnNo: context.turnNo,
      logicalCallId: 'logical-unknown', toolCallId: 'call-unknown', toolName: 'create',
      capability: 'non_idempotent_write', idempotencyKey: 'key', argsDigest: 'digest', status: 'started',
      createdAt: new Date(), updatedAt: new Date(),
    });
    const unknown = await runtime.execute({
      id: 'call-unknown', logicalCallId: 'logical-unknown', name: 'create', arguments: {},
    }, { ...context, attemptId: 'attempt-b' });
    expect(unknown.kind).toBe('recovery_required');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('uses Pi truncation and stores the original output only when configured', async () => {
    const save = vi.fn(async () => 'blob://tool-output/a');
    const limiter = new PiToolOutputLimiter({ direction: 'head', maxLines: 2, maxBytes: 100, saveOriginal: save });
    const limited = await limiter.limit(
      { callId: 'call-a', content: 'one\ntwo\nthree\nfour' },
      { name: 'read', description: 'read', inputSchema: {}, capability: 'read', execute: vi.fn() },
    );
    expect(limited.content).toContain('one\ntwo');
    expect(limited.content).toContain('[truncated:lines; original=blob://tool-output/a]');
    expect(save).toHaveBeenCalledWith('one\ntwo\nthree\nfour');
  });
});
