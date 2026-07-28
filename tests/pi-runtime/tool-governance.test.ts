import { describe, expect, it, vi } from 'vitest';
import type {
  DurableToolLedgerUpdate,
  ToolCall,
  ToolExecutionContext,
} from '@aiop/control-contracts';
import {
  GovernedToolFactory,
  ResourceConcurrencyController,
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

const call = (logicalCallId = 'logical-a'): ToolCall => ({
  id: 'call-a', logicalCallId, name: 'write', arguments: { resource: 'deployment/a' },
});

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

    const resumed = await new GovernedToolFactory({ ledger }).create([definition]).execute(call(), {
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
