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
  type ToolAuditEvent,
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
  protected readonly records = new Map<string, DurableToolLedgerUpdate>();

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

  async claimPendingApproval(input: {
    tenantId: string; runId: string; logicalCallId: string; attemptId: string; turnNo: number;
    toolCallId: string; toolName: string; argsDigest: string; approvedInteractionId: string;
    started: DurableToolLedgerUpdate;
  }): Promise<boolean> {
    const key = this.key(input.tenantId, input.runId, input.logicalCallId);
    const current = this.records.get(key);
    if (!current || current.status !== 'pending_approval' || current.attemptId !== input.attemptId
      || current.turnNo !== input.turnNo || current.toolCallId !== input.toolCallId
      || current.toolName !== input.toolName || current.argsDigest !== input.argsDigest
      || current.approvedInteractionId !== input.approvedInteractionId) return false;
    this.records.set(key, structuredClone(input.started));
    return true;
  }

  protected key(tenantId: string, runId: string, logicalCallId: string): string {
    return `${tenantId}:${runId}:${logicalCallId}`;
  }
}

class BarrierMemoryLedger extends MemoryLedger {
  private reads = 0;
  private releaseReads!: () => void;
  private readonly readsReady = new Promise<void>((resolve) => { this.releaseReads = resolve; });

  override async get(input: { tenantId: string; runId: string; logicalCallId: string }) {
    const record = await super.get(input);
    this.reads++;
    if (this.reads === 2) this.releaseReads();
    if (this.reads <= 2) await this.readsReady;
    return record;
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
    expect(audit.record).toHaveBeenCalledOnce();
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
    ['missing tool call id', approvalPayload({
      name: 'write', args: { resource: 'deployment/a' },
    })],
    ['empty tool call id', approvalPayload({
      id: '', name: 'write', args: { resource: 'deployment/a' },
    })],
    ['non-string tool call id', approvalPayload({
      id: 42, name: 'write', args: { resource: 'deployment/a' },
    })],
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

  it('atomically consumes one resolved approval across concurrent resumes', async () => {
    const ledger = new BarrierMemoryLedger();
    await ledger.putIfAbsent({
      tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'write',
      argsDigest: digestToolValue({ resource: 'deployment/a' }), capability: 'non_idempotent_write',
      idempotencyKey: 'tenant-a:run-a:logical-a', approvedInteractionId: 'approval-a',
      status: 'pending_approval', createdAt: new Date(), updatedAt: new Date(),
    });
    const interactions = new MemoryInteractions([{
      tenantId: 'tenant-a', runId: 'run-a', id: 'approval-a', attemptId: 'attempt-a', turnNo: 1,
      toolCallId: 'call-a', kind: 'approval', status: 'resolved', resolution: true,
      payload: approvalPayload(), createdAt: new Date(),
    }]);
    let executionCount = 0;
    let releaseExecution!: () => void;
    const executionRelease = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let duplicateExecution!: () => void;
    const duplicate = new Promise<'duplicate'>((resolve) => {
      duplicateExecution = () => resolve('duplicate');
    });
    const execute = vi.fn(async () => {
      executionCount++;
      if (executionCount === 2) duplicateExecution();
      await executionRelease;
      return { content: 'changed once' };
    });
    const runtime = new GovernedToolFactory({ ledger, interactions }).create([{
      name: 'write', description: 'write', inputSchema: {}, capability: 'non_idempotent_write', execute,
    }]);
    const resumeContext: ToolExecutionContext = {
      ...context,
      attemptId: 'attempt-resume',
      interactionResolution: {
        interactionId: 'approval-a', kind: 'approval', toolCallId: 'call-a', value: true,
      },
    };

    const first = runtime.execute(call(), resumeContext);
    const second = runtime.execute(call(), resumeContext);
    const raceResult = await Promise.race([
      Promise.race([first, second]).then(() => 'settled' as const),
      duplicate,
    ]);
    releaseExecution();
    await Promise.all([first, second]);
    expect(raceResult).toBe('settled');
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

  it('removes an aborted queued resource waiter without leaking the permit', async () => {
    const controller = new ResourceConcurrencyController();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const executed: string[] = [];
    const first = controller.run({ tenantId: 'tenant-a', resourceKey: 'resource-a' }, async () => {
      executed.push('first');
      await firstGate;
    });
    await vi.waitFor(() => expect(executed).toEqual(['first']));
    const abort = new AbortController();
    const cancelled = controller.run({
      tenantId: 'tenant-a', resourceKey: 'resource-a', signal: abort.signal,
    } as never, async () => { executed.push('cancelled'); });
    const after = controller.run({ tenantId: 'tenant-a', resourceKey: 'resource-a' }, async () => {
      executed.push('after');
    });
    abort.abort(new Error('queue cancelled'));
    releaseFirst();

    const cancelledState = await cancelled.then(() => 'executed', () => 'aborted');
    await Promise.all([first, after]);
    expect(cancelledState).toBe('aborted');
    expect(executed).toEqual(['first', 'after']);
  });

  it('audits every governed outcome exactly once with a redacted DTO', async () => {
    const record = vi.fn(async (_event: ToolAuditEvent) => undefined);
    const audit = { record };
    const definition = (execute = vi.fn(async () => ({ content: 'ok' }))) => ({
      name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write' as const, execute,
    });

    await new GovernedToolFactory({ ledger: new MemoryLedger(), audit }).create([]).execute({
      ...call(), name: 'missing', arguments: { secret: 'audit-secret' },
    }, context);
    await new GovernedToolFactory({
      ledger: new MemoryLedger(), audit,
      policy: { check: async () => ({ allowed: false, reason: 'denied' }) },
    }).create([definition()]).execute(call(), context);
    await new GovernedToolFactory({
      ledger: new MemoryLedger(), audit,
      policy: { check: async () => ({ allowed: true, needsApproval: true }) },
      approval: { request: async () => ({ approved: false, pending: true, interactionId: 'approval-wait' }) },
    }).create([definition()]).execute(call(), context);

    const invalidLedger = new MemoryLedger();
    await invalidLedger.putIfAbsent({
      tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'write',
      argsDigest: digestToolValue({ resource: 'deployment/a' }), capability: 'retryable_write',
      idempotencyKey: 'key', approvedInteractionId: 'approval-a', status: 'pending_approval',
      createdAt: new Date(), updatedAt: new Date(),
    });
    await new GovernedToolFactory({ ledger: invalidLedger, interactions: new MemoryInteractions([]), audit })
      .create([definition()]).execute(call(), {
        ...context,
        interactionResolution: {
          interactionId: 'approval-a', kind: 'approval', toolCallId: 'call-a', value: true,
        },
      });

    const successLedger = new MemoryLedger();
    const successRuntime = new GovernedToolFactory({ ledger: successLedger, audit }).create([definition()]);
    const success = await successRuntime.execute(call(), context);
    await successLedger.update(success.ledgerUpdates![0]!);
    await successRuntime.execute(call(), { ...context, attemptId: 'attempt-cached' });

    const mismatchLedger = new MemoryLedger();
    await mismatchLedger.putIfAbsent({
      tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'write', argsDigest: digestToolValue({ other: true }),
      capability: 'retryable_write', idempotencyKey: 'key', status: 'started',
      createdAt: new Date(), updatedAt: new Date(),
    });
    await new GovernedToolFactory({ ledger: mismatchLedger, audit }).create([definition()]).execute(call(), context);

    const recoveryLedger = new MemoryLedger();
    await recoveryLedger.putIfAbsent({
      tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'write',
      argsDigest: digestToolValue({ resource: 'deployment/a' }), capability: 'non_idempotent_write',
      idempotencyKey: 'key', status: 'started', createdAt: new Date(), updatedAt: new Date(),
    });
    await new GovernedToolFactory({ ledger: recoveryLedger, audit }).create([{
      ...definition(), capability: 'non_idempotent_write',
    }]).execute(call(), context);
    await new GovernedToolFactory({ ledger: new MemoryLedger(), audit }).create([
      definition(vi.fn(async () => { throw new Error('tool failed'); })),
    ]).execute(call(), context);

    expect(record).toHaveBeenCalledTimes(9);
    expect(record.mock.calls.map(([event]) => event.status)).toEqual([
      'unknown_tool', 'policy_denied', 'approval_waiting', 'invalid_resolution',
      'success', 'cached_completed', 'ledger_mismatch', 'recovery_required', 'failure',
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain('audit-secret');
    expect(record.mock.calls.every(([event]) => !('call' in event) && !('outcome' in event))).toBe(true);
  });

  it('keeps completed ledger facts reusable when the audit sink fails', async () => {
    const ledger = new MemoryLedger();
    const execute = vi.fn(async () => ({ content: 'completed' }));
    const audit = {
      record: vi.fn(async () => { throw new Error('audit unavailable'); }),
      failure: vi.fn(() => { throw new Error('audit failure handler unavailable'); }),
    };
    const runtime = new GovernedToolFactory({ ledger, audit }).create([{
      name: 'write', description: 'write', inputSchema: {}, capability: 'retryable_write', execute,
    }]);

    const first = await runtime.execute(call(), context);
    await ledger.update(first.ledgerUpdates![0]!);
    await expect(runtime.execute(call(), { ...context, attemptId: 'attempt-b' })).resolves.toMatchObject({
      kind: 'result', result: { content: 'completed' },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.failure).toHaveBeenCalledTimes(2);
  });
});

describe('digestToolValue', () => {
  it('preserves JSON primitive types while canonicalizing object key order', () => {
    expect(digestToolValue('null')).not.toBe(digestToolValue(null));
    expect(digestToolValue('1')).not.toBe(digestToolValue(1));
    expect(digestToolValue({ b: 2, a: 1 })).toBe(digestToolValue({ a: 1, b: 2 }));
    expect(digestToolValue([1, '1'])).not.toBe(digestToolValue(['1', 1]));
    expect(digestToolValue(-0)).toBe(digestToolValue(0));
  });
});
