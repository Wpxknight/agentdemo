import { describe, expect, it, vi } from 'vitest';
import type {
  DurableInteractionUpdate,
  DurableToolLedgerUpdate,
  JsonValue,
  ToolCall,
  ToolExecutionContext,
} from '@aiop/control-contracts';
import {
  GovernedToolFactory,
  ResourceConcurrencyController,
  digestToolValue,
  type ToolInteractionStore,
  type ToolLedgerStore,
} from '../../packages/pi-runtime/src/index.js';

const context: ToolExecutionContext = {
  identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
  runId: 'run-a',
  attemptId: 'attempt-a',
  turnNo: 1,
  sessionId: 'session-a',
};

class MemoryLedger implements ToolLedgerStore {
  private readonly records = new Map<string, DurableToolLedgerUpdate>();

  async putIfAbsent(record: DurableToolLedgerUpdate): Promise<boolean> {
    const key = this.key(record.tenantId, record.runId, record.logicalCallId);
    if (this.records.has(key)) return false;
    this.records.set(key, structuredClone(record));
    return true;
  }

  async get(input: { tenantId: string; runId: string; logicalCallId: string }) {
    return structuredClone(this.records.get(this.key(input.tenantId, input.runId, input.logicalCallId)));
  }

  async update(record: DurableToolLedgerUpdate): Promise<void> {
    this.records.set(this.key(record.tenantId, record.runId, record.logicalCallId), structuredClone(record));
  }

  private key(tenantId: string, runId: string, logicalCallId: string): string {
    return `${tenantId}:${runId}:${logicalCallId}`;
  }
}

class MemoryInteractions implements ToolInteractionStore {
  constructor(private readonly records: DurableInteractionUpdate[]) {}

  async get(input: { tenantId: string; runId: string; interactionId: string }) {
    return this.records.find((record) => record.tenantId === input.tenantId
      && record.runId === input.runId && record.id === input.interactionId);
  }
}

const call = (logicalCallId = 'logical-a'): ToolCall => ({
  id: 'call-a', logicalCallId, name: 'write', arguments: { resource: 'deployment/a' },
});

const approvalPayload = (callValue: JsonValue = {
  id: 'call-a', name: 'write', args: { resource: 'deployment/a' },
}): JsonValue => ({ call: callValue, reason: 'production change' });

describe('GovernedToolFactory', () => {
  it('does not execute the original tool when policy denies it', async () => {
    const execute = vi.fn(async () => ({ content: 'changed' }));
    const audit = { record: vi.fn(async () => undefined) };
    const runtime = new GovernedToolFactory({
      ledger: new MemoryLedger(),
      policy: { check: async () => ({ allowed: false, reason: 'read only role' }) },
      audit,
    }).create([{ name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write', execute }]);

    await expect(runtime.execute(call(), context)).resolves.toMatchObject({
      kind: 'result', result: { isError: true, content: 'blocked by policy: read only role' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      call: expect.objectContaining({ name: 'write' }),
      outcome: expect.objectContaining({ kind: 'result' }),
    }));
  });

  it('leaves argument validation to Pi before governance', async () => {
    const execute = vi.fn(async () => ({ content: 'received' }));
    const runtime = new GovernedToolFactory({ ledger: new MemoryLedger() }).create([{
      name: 'write',
      description: 'write',
      inputSchema: { type: 'object', required: ['requiredByPi'] },
      capability: 'retryable_write',
      execute,
    }]);

    await expect(runtime.execute({ ...call(), arguments: {} }, context)).resolves.toMatchObject({
      kind: 'result', result: { content: 'received' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('waits for approval and resumes with the stable idempotency key', async () => {
    const ledger = new MemoryLedger();
    const execute = vi.fn(async (_call, execution) => ({ content: execution.idempotencyKey }));
    const definition = {
      name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write' as const, execute,
    };
    const waiting = await new GovernedToolFactory({
      ledger,
      policy: { check: async () => ({ allowed: true, needsApproval: true }) },
      approval: { request: async () => ({ approved: false, pending: true, interactionId: 'approval-a' }) },
    }).create([definition]).execute(call(), context);

    expect(waiting).toMatchObject({
      kind: 'waiting', reason: 'approval', interactionId: 'approval-a',
      ledgerUpdates: [expect.objectContaining({ status: 'pending_approval' })],
    });
    expect(execute).not.toHaveBeenCalled();
    await ledger.putIfAbsent(waiting.ledgerUpdates![0]!);

    const interactions = new MemoryInteractions([{
      tenantId: 'tenant-a', runId: 'run-a', id: 'approval-a', attemptId: 'attempt-a',
      toolCallId: 'call-a', kind: 'approval', status: 'resolved', resolution: true,
      turnNo: 1, payload: approvalPayload(), createdAt: new Date(),
    }]);
    const resumed = await new GovernedToolFactory({ ledger, interactions }).create([definition]).execute(call(), {
      ...context,
      attemptId: 'attempt-b',
      interactionResolution: {
        interactionId: 'approval-a', kind: 'approval', toolCallId: 'call-a', value: true,
      },
    });
    expect(resumed).toMatchObject({
      kind: 'result',
      result: { content: 'tenant-a:run-a:logical-a' },
      ledgerUpdates: [expect.objectContaining({ status: 'completed' })],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing pending ledger', undefined, {
      tenantId: 'tenant-a', runId: 'run-a', id: 'approval-a', attemptId: 'attempt-a',
      toolCallId: 'call-a', kind: 'approval' as const, status: 'resolved' as const, resolution: true,
      turnNo: 1, payload: null, createdAt: new Date(),
    }],
    ['forged interaction id', 'approval-real', {
      tenantId: 'tenant-a', runId: 'run-a', id: 'approval-forged', attemptId: 'attempt-a',
      toolCallId: 'call-a', kind: 'approval' as const, status: 'resolved' as const, resolution: true,
      turnNo: 1, payload: null, createdAt: new Date(),
    }],
    ['stale attempt binding', 'approval-a', {
      tenantId: 'tenant-a', runId: 'run-a', id: 'approval-a', attemptId: 'attempt-stale',
      toolCallId: 'call-a', kind: 'approval' as const, status: 'resolved' as const, resolution: true,
      turnNo: 1, payload: null, createdAt: new Date(),
    }],
    ['stale turn binding', 'approval-a', {
      tenantId: 'tenant-a', runId: 'run-a', id: 'approval-a', attemptId: 'attempt-a',
      toolCallId: 'call-a', kind: 'approval' as const, status: 'resolved' as const, resolution: true,
      turnNo: 99, payload: null, createdAt: new Date(),
    }],
    ['cross-call binding', 'approval-a', {
      tenantId: 'tenant-a', runId: 'run-a', id: 'approval-a', attemptId: 'attempt-a',
      toolCallId: 'call-other', kind: 'approval' as const, status: 'resolved' as const, resolution: true,
      turnNo: 1, payload: null, createdAt: new Date(),
    }],
    ['cross-tenant binding', 'approval-a', {
      tenantId: 'tenant-b', runId: 'run-a', id: 'approval-a', attemptId: 'attempt-a',
      toolCallId: 'call-a', kind: 'approval' as const, status: 'resolved' as const, resolution: true,
      turnNo: 1, payload: null, createdAt: new Date(),
    }],
  ])('rejects a true resolution with %s', async (_case, pendingInteractionId, interaction) => {
    const ledger = new MemoryLedger();
    if (pendingInteractionId) {
      await ledger.putIfAbsent({
        tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
        logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'write',
        argsDigest: digestToolValue({ resource: 'deployment/a' }), capability: 'retryable_write',
        idempotencyKey: 'tenant-a:run-a:logical-a', approvedInteractionId: pendingInteractionId,
        status: 'pending_approval', createdAt: new Date(), updatedAt: new Date(),
      });
    }
    const execute = vi.fn(async () => ({ content: 'must not execute' }));
    const runtime = new GovernedToolFactory({
      ledger, interactions: new MemoryInteractions([interaction]),
    }).create([{
      name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write', execute,
    }]);

    await expect(runtime.execute(call(), {
      ...context,
      attemptId: 'attempt-resume',
      interactionResolution: {
        interactionId: interaction.id, kind: 'approval', toolCallId: 'call-a', value: true,
      },
    })).resolves.toMatchObject({ kind: 'recovery_required' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['null payload', null],
    ['wrong tool name', approvalPayload({
      id: 'call-a', name: 'delete', args: { resource: 'deployment/a' },
    })],
    ['wrong arguments', approvalPayload({
      id: 'call-a', name: 'write', args: { resource: 'deployment/b' },
    })],
    ['malformed call', { call: 'write', reason: 'production change' }],
    ['cross-ledger substituted pair', approvalPayload({
      id: 'call-other', name: 'delete', args: { resource: 'deployment/b' },
    })],
  ] satisfies Array<[string, JsonValue]>)('rejects approval resume with %s', async (_case, payload) => {
    const ledger = new MemoryLedger();
    await ledger.putIfAbsent({
      tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'write',
      argsDigest: digestToolValue({ resource: 'deployment/a' }), capability: 'retryable_write',
      idempotencyKey: 'tenant-a:run-a:logical-a', approvedInteractionId: 'approval-a',
      status: 'pending_approval', createdAt: new Date(), updatedAt: new Date(),
    });
    const execute = vi.fn(async () => ({ content: 'must not execute' }));
    const interactions = new MemoryInteractions([{
      tenantId: 'tenant-a', runId: 'run-a', id: 'approval-a', attemptId: 'attempt-a', turnNo: 1,
      toolCallId: 'call-a', kind: 'approval', status: 'resolved', resolution: true,
      payload, createdAt: new Date(),
    }]);
    const runtime = new GovernedToolFactory({ ledger, interactions }).create([{
      name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write', execute,
    }]);

    await expect(runtime.execute(call(), {
      ...context,
      attemptId: 'attempt-resume',
      interactionResolution: {
        interactionId: 'approval-a', kind: 'approval', toolCallId: 'call-a', value: true,
      },
    })).resolves.toMatchObject({ kind: 'recovery_required' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a committed completed ledger result without re-executing', async () => {
    const ledger = new MemoryLedger();
    const execute = vi.fn(async () => ({ content: 'changed' }));
    const definition = {
      name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write' as const, execute,
    };
    const runtime = new GovernedToolFactory({ ledger }).create([definition]);
    const first = await runtime.execute(call(), context);
    await ledger.update(first.ledgerUpdates![0]!);

    await expect(runtime.execute(call(), { ...context, attemptId: 'attempt-b' })).resolves.toMatchObject({
      kind: 'result', result: { content: 'changed' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not request approval again for a committed completed result', async () => {
    const ledger = new MemoryLedger();
    const execute = vi.fn(async () => ({ content: 'changed' }));
    const definition = {
      name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write' as const, execute,
    };
    const first = await new GovernedToolFactory({ ledger }).create([definition]).execute(call(), context);
    await ledger.update(first.ledgerUpdates![0]!);
    const approval = { request: vi.fn(async () => ({
      approved: false, pending: true, interactionId: 'approval-duplicate',
    })) };

    await expect(new GovernedToolFactory({
      ledger,
      policy: { check: async () => ({ allowed: true, needsApproval: true }) },
      approval,
    }).create([definition]).execute(call(), { ...context, attemptId: 'attempt-b' })).resolves.toMatchObject({
      kind: 'result', result: { content: 'changed' },
    });
    expect(approval.request).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('serializes the same resource across factories but isolates tenants', async () => {
    const controller = new ResourceConcurrencyController();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const definition = {
      name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write' as const,
      execute: async (current: ToolCall) => {
        started.push(current.logicalCallId);
        if (current.logicalCallId === 'logical-1') await gate;
        return { content: current.logicalCallId };
      },
    };
    const factory = () => new GovernedToolFactory({
      ledger: new MemoryLedger(),
      concurrency: controller,
      policy: { check: async () => ({ allowed: true, resourceKey: 'cluster-a:deployment-a' }) },
    }).create([definition]);

    const first = factory().execute(call('logical-1'), { ...context, runId: 'run-1' });
    await vi.waitFor(() => expect(started).toEqual(['logical-1']));
    const sameTenant = factory().execute(call('logical-2'), { ...context, runId: 'run-2' });
    const otherTenant = factory().execute(call('logical-3'), {
      ...context, identity: { ...context.identity, tenantId: 'tenant-b' }, runId: 'run-3',
    });
    await vi.waitFor(() => expect(started).toEqual(['logical-1', 'logical-3']));
    release();
    await Promise.all([first, sameTenant, otherTenant]);
    expect(started).toEqual(['logical-1', 'logical-3', 'logical-2']);
  });
});
