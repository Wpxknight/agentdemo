import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@aiop/control-contracts';
import { MemoryRuntimeStore } from '../packages/agent-runtime-core/src/memory-store.js';
import {
  PiToolOutputLimiter,
  ToolConcurrencyController,
  ToolRuntimeEngine,
} from '../packages/tool-runtime/src/index.js';

const context = {
  identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
  runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
} as const;

const interactionCases: Array<['question' | 'plan', JsonValue, string]> = [
  ['question', { answer: ['yes'] }, 'question resolved: {"answer":["yes"]}'],
  ['plan', true, 'plan resolved: true'],
];

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

  it('never starts an external tool when the synchronous started-ledger write fails', async () => {
    const execute = vi.fn(async () => ({ content: 'should not run' }));
    const runtime = new ToolRuntimeEngine({
      ledger: {
        get: async () => undefined,
        putIfAbsent: async () => { throw new Error('ledger unavailable'); },
        update: async () => undefined,
        claimPendingApproval: async () => false,
      },
      definitions: [{
        name: 'write', description: 'write', inputSchema: { type: 'object' }, capability: 'retryable_write', execute,
      }],
    });

    await expect(runtime.execute({
      id: 'call-a', logicalCallId: 'logical-a', name: 'write', arguments: {},
    }, context)).rejects.toThrow('ledger unavailable');
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a durable wait before executing a tool that needs approval', async () => {
    const execute = vi.fn();
    const runtime = new ToolRuntimeEngine({
      ledger: new MemoryRuntimeStore().toolLedger,
      definitions: [{ name: 'write', description: 'write', inputSchema: { type: 'object' }, capability: 'retryable_write', execute }],
      policy: { check: async () => ({ allowed: true, needsApproval: true }) },
      approval: { request: async () => ({
        approved: false, pending: true, interactionId: 'approval-a', payload: { reason: 'production write' },
      }) },
    });
    await expect(runtime.execute({ id: 'call-a', logicalCallId: 'logical-a', name: 'write', arguments: {} }, context))
      .resolves.toMatchObject({
        kind: 'waiting', reason: 'approval', interactionId: 'approval-a',
        ledgerUpdates: [expect.objectContaining({ status: 'pending_approval' })],
        interactionUpdates: [expect.objectContaining({
          id: 'approval-a', kind: 'approval', status: 'pending', payload: { reason: 'production write' },
        })],
      });
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
    await store.toolLedger.update(first.ledgerUpdates![0]!);
    const freshRuntime = new ToolRuntimeEngine({
      ledger: store.toolLedger,
      definitions: [{ name: 'create', description: 'create', inputSchema: { type: 'object' }, capability: 'non_idempotent_write', execute }],
      policy: { check: async () => ({ allowed: true }) },
    });
    const reused = await freshRuntime.execute(call, { ...context, attemptId: 'attempt-b' });
    expect(reused).toMatchObject({ kind: 'result', result: { content: 'created' } });
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

  it('keeps external success provisional until the caller commits the returned final ledger fact', async () => {
    const execute = vi.fn(async () => ({ content: 'created' }));
    const store = new MemoryRuntimeStore();
    const runtime = new ToolRuntimeEngine({
      ledger: store.toolLedger,
      definitions: [{
        name: 'create', description: 'create', inputSchema: { type: 'object' }, capability: 'non_idempotent_write', execute,
      }],
    });
    const call = { id: 'call-a', logicalCallId: 'logical-a', name: 'create', arguments: {} } as const;

    const outcome = await runtime.execute(call, context);

    expect(outcome).toMatchObject({ kind: 'result', result: { content: 'created' } });
    expect(outcome.ledgerUpdates).toHaveLength(1);
    expect(outcome.ledgerUpdates![0]).toMatchObject({ status: 'completed', result: { content: 'created' } });
    const provisional = await store.toolLedger.get({
      tenantId: context.identity.tenantId, runId: context.runId, logicalCallId: call.logicalCallId,
    });
    expect(provisional).toMatchObject({ status: 'started' });
    expect(provisional?.result).toBeUndefined();
  });

  it.each([
    ['tenant', { maxConcurrentPerTenant: 1, maxConcurrentPerTool: 2, maxConcurrentPerResource: 2 },
      [{ name: 'write-a', resourceKey: 'r-a' }, { name: 'write-b', resourceKey: 'r-b' }]],
    ['tool', { maxConcurrentPerTenant: 2, maxConcurrentPerTool: 1, maxConcurrentPerResource: 2 },
      [{ name: 'write-a', resourceKey: 'r-a' }, { name: 'write-a', resourceKey: 'r-b' }]],
    ['resource', { maxConcurrentPerTenant: 2, maxConcurrentPerTool: 2, maxConcurrentPerResource: 1 },
      [{ name: 'write-a', resourceKey: 'shared' }, { name: 'write-b', resourceKey: 'shared' }]],
  ] as const)('enforces the trusted %s concurrency ceiling in FIFO order', async (_kind, concurrency, calls) => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runtime = new ToolRuntimeEngine({
      ledger: new MemoryRuntimeStore().toolLedger,
      concurrency,
      definitions: ['write-a', 'write-b'].map((name) => ({
        name, description: name, inputSchema: { type: 'object' }, capability: 'retryable_write' as const,
        execute: async (call: { id: string }) => {
          started.push(call.id);
          if (call.id === 'call-1') await firstGate;
          return { content: call.id };
        },
      })),
      policy: { check: async (call) => ({
        allowed: true,
        resourceKey: call.id === 'call-1' ? calls[0].resourceKey : calls[1].resourceKey,
      }) },
    });
    const first = runtime.execute({
      id: 'call-1', logicalCallId: 'logical-1', name: calls[0].name, arguments: {},
    }, { ...context, runId: 'run-1' });
    await vi.waitFor(() => expect(started).toEqual(['call-1']));
    const second = runtime.execute({
      id: 'call-2', logicalCallId: 'logical-2', name: calls[1].name, arguments: {},
    }, { ...context, runId: 'run-2' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(['call-1']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(['call-1', 'call-2']);
  });

  it.each([
    ['tenant', { maxConcurrentPerTenant: 1, maxConcurrentPerTool: 2, maxConcurrentPerResource: 2 }, 'write-a', 'write-b', 'r-a', 'r-b'],
    ['tool', { maxConcurrentPerTenant: 2, maxConcurrentPerTool: 1, maxConcurrentPerResource: 2 }, 'write-a', 'write-a', 'r-a', 'r-b'],
    ['resource', { maxConcurrentPerTenant: 2, maxConcurrentPerTool: 2, maxConcurrentPerResource: 1 }, 'write-a', 'write-b', 'shared', 'shared'],
  ] as const)('shares the trusted %s FIFO ceiling across fresh runtime instances', async (
    _kind, limits, firstTool, secondTool, firstResource, secondResource,
  ) => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const controller = new ToolConcurrencyController(limits);
    const definitions = ['write-a', 'write-b'].map((name) => ({
      name, description: name, inputSchema: { type: 'object' }, capability: 'retryable_write' as const,
      execute: async (call: { id: string }) => {
        started.push(call.id);
        if (call.id === 'call-1') await firstGate;
        return { content: call.id };
      },
    }));
    const createRuntime = (resourceKey: string) => new ToolRuntimeEngine({
      ledger: new MemoryRuntimeStore().toolLedger,
      concurrencyController: controller,
      definitions,
      policy: { check: async () => ({ allowed: true, resourceKey }) },
    });
    const first = createRuntime(firstResource).execute({
      id: 'call-1', logicalCallId: 'logical-1', name: firstTool, arguments: {},
    }, { ...context, runId: 'run-1' });
    await vi.waitFor(() => expect(started).toEqual(['call-1']));
    const second = createRuntime(secondResource).execute({
      id: 'call-2', logicalCallId: 'logical-2', name: secondTool, arguments: {},
    }, { ...context, runId: 'run-2' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(['call-1']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(['call-1', 'call-2']);
  });

  it.each(interactionCases)('durably waits for and deterministically resolves a %s tool without executing it', async (
    interactionKind, value, expectedContent,
  ) => {
    const execute = vi.fn(async () => ({ content: 'must not execute' }));
    const store = new MemoryRuntimeStore();
    const definition = {
      name: `${interactionKind}-tool`, description: interactionKind, inputSchema: { type: 'object' },
      capability: 'read' as const, interactionKind, execute,
    };
    const call = {
      id: `call-${interactionKind}`, logicalCallId: `logical-${interactionKind}`,
      name: definition.name, arguments: { prompt: 'continue?' },
    } as const;
    const waiting = await new ToolRuntimeEngine({ ledger: store.toolLedger, definitions: [definition] })
      .execute(call, { ...context, sessionId: 'session-a' });
    expect(waiting).toMatchObject({
      kind: 'waiting', reason: interactionKind,
      ledgerUpdates: [expect.objectContaining({ status: 'pending_approval' })],
      interactionUpdates: [expect.objectContaining({
        userId: 'user-a', sessionId: 'session-a', kind: interactionKind,
        toolCallId: call.id, payload: call.arguments, status: 'pending',
      })],
    });
    if (waiting.kind !== 'waiting') throw new Error('expected durable interaction wait');
    await store.toolLedger.putIfAbsent(waiting.ledgerUpdates![0]!);

    const resolved = await new ToolRuntimeEngine({ ledger: store.toolLedger, definitions: [definition] })
      .execute(call, {
        ...context, attemptId: 'attempt-b', sessionId: 'session-a',
        interactionResolution: {
          interactionId: waiting.interactionId!, kind: interactionKind, toolCallId: call.id, value,
        },
      });
    expect(resolved).toMatchObject({
      kind: 'result', result: { callId: call.id, content: expectedContent },
      ledgerUpdates: [expect.objectContaining({
        status: 'completed', result: expect.objectContaining({ content: expectedContent }),
      })],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('resumes approved calls with the original idempotency key and finalizes denied calls without execution', async () => {
    const store = new MemoryRuntimeStore();
    const execute = vi.fn(async (_call, executionContext: { idempotencyKey: string }) => ({
      content: executionContext.idempotencyKey,
    }));
    const definition = {
      name: 'write', description: 'write', inputSchema: { type: 'object' },
      capability: 'retryable_write' as const, execute,
    };
    const createPending = async (suffix: string) => {
      const call = {
        id: `call-${suffix}`, logicalCallId: `logical-${suffix}`, name: 'write', arguments: { suffix },
      } as const;
      const waiting = await new ToolRuntimeEngine({
        ledger: store.toolLedger, definitions: [definition],
        policy: { check: async () => ({ allowed: true, needsApproval: true }) },
        approval: { request: async () => ({
          approved: false, pending: true, interactionId: `approval-${suffix}`,
        }) },
      }).execute(call, context);
      if (waiting.kind !== 'waiting') throw new Error('expected durable approval wait');
      await store.toolLedger.putIfAbsent(waiting.ledgerUpdates![0]!);
      return { call, waiting };
    };

    const approved = await createPending('approved');
    const approvalRequest = vi.fn();
    const approvedOutcome = await new ToolRuntimeEngine({
      ledger: store.toolLedger, definitions: [definition],
      policy: { check: async () => ({ allowed: true, needsApproval: true }) },
      approval: { request: approvalRequest },
    }).execute(approved.call, {
      ...context, attemptId: 'attempt-b', interactionResolution: {
        interactionId: approved.waiting.interactionId!, kind: 'approval',
        toolCallId: approved.call.id, value: true,
      },
    });
    const originalKey = approved.waiting.ledgerUpdates![0]!.idempotencyKey;
    expect(approvedOutcome).toMatchObject({
      kind: 'result', result: { content: originalKey },
      ledgerUpdates: [expect.objectContaining({ status: 'completed', idempotencyKey: originalKey })],
    });
    expect(approvalRequest).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();

    const denied = await createPending('denied');
    const deniedOutcome = await new ToolRuntimeEngine({
      ledger: store.toolLedger, definitions: [definition],
      policy: { check: async () => ({ allowed: true, needsApproval: true }) },
    }).execute(denied.call, {
      ...context, attemptId: 'attempt-c', interactionResolution: {
        interactionId: denied.waiting.interactionId!, kind: 'approval',
        toolCallId: denied.call.id, value: false,
      },
    });
    expect(deniedOutcome).toMatchObject({
      kind: 'result', result: { callId: denied.call.id, isError: true, content: 'approval denied' },
      ledgerUpdates: [expect.objectContaining({
        status: 'completed', result: expect.objectContaining({ content: 'approval denied' }),
      })],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('releases concurrency permits after tool failure', async () => {
    const started: string[] = [];
    const runtime = new ToolRuntimeEngine({
      ledger: new MemoryRuntimeStore().toolLedger,
      concurrency: { maxConcurrentPerTenant: 1 },
      definitions: [{
        name: 'write', description: 'write', inputSchema: { type: 'object' }, capability: 'retryable_write',
        execute: async (call) => {
          started.push(call.id);
          if (call.id === 'call-1') throw new Error('boom');
          return { content: 'ok' };
        },
      }],
    });

    const outcomes = await Promise.all([
      runtime.execute({ id: 'call-1', logicalCallId: 'logical-1', name: 'write', arguments: {} }, { ...context, runId: 'run-1' }),
      runtime.execute({ id: 'call-2', logicalCallId: 'logical-2', name: 'write', arguments: {} }, { ...context, runId: 'run-2' }),
    ]);
    expect(started).toEqual(['call-1', 'call-2']);
    expect(outcomes[1]).toMatchObject({ kind: 'result', result: { content: 'ok' } });
  });

  it('removes a cancelled FIFO waiter and releases permits for the next tool', async () => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runtime = new ToolRuntimeEngine({
      ledger: new MemoryRuntimeStore().toolLedger,
      concurrency: { maxConcurrentPerTenant: 1 },
      definitions: [{
        name: 'write', description: 'write', inputSchema: { type: 'object' }, capability: 'retryable_write',
        execute: async (call) => {
          started.push(call.id);
          if (call.id === 'call-1') await firstGate;
          return { content: call.id };
        },
      }],
    });
    const cancelled = new AbortController();
    const first = runtime.execute(
      { id: 'call-1', logicalCallId: 'logical-1', name: 'write', arguments: {} },
      { ...context, runId: 'run-1' },
    );
    await vi.waitFor(() => expect(started).toEqual(['call-1']));
    const second = runtime.execute(
      { id: 'call-2', logicalCallId: 'logical-2', name: 'write', arguments: {} },
      { ...context, runId: 'run-2', signal: cancelled.signal },
    );
    const third = runtime.execute(
      { id: 'call-3', logicalCallId: 'logical-3', name: 'write', arguments: {} },
      { ...context, runId: 'run-3' },
    );
    cancelled.abort(new Error('cancel queued tool'));
    releaseFirst();
    const outcomes = await Promise.all([first, second, third]);

    expect(started).toEqual(['call-1', 'call-3']);
    expect(outcomes[1]).toMatchObject({ kind: 'result', result: { isError: true, content: 'cancel queued tool' } });
    expect(outcomes[2]).toMatchObject({ kind: 'result', result: { content: 'call-3' } });
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
