import { describe, expect, it, vi } from 'vitest';
import { McpRuntime, type McpAuditEvent } from '../../packages/mcp-runtime/src/index.js';
import { GovernedToolFactory, type ToolLedgerStore } from '../../packages/pi-runtime/src/index.js';

const tenant = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['operator'] };

describe('MCP governed tool adapter', () => {
  it('uses unique direct invoke identities unless the caller supplies an idempotency key', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'once' }] }));
    const records = new Map<string, Parameters<ToolLedgerStore['putIfAbsent']>[0]>();
    const ledger: ToolLedgerStore = {
      putIfAbsent: async (record) => {
        if (records.has(record.logicalCallId)) return false;
        records.set(record.logicalCallId, structuredClone(record));
        return true;
      },
      get: async ({ logicalCallId }) => structuredClone(records.get(logicalCallId)),
      update: async (record) => { records.set(record.logicalCallId, structuredClone(record)); },
      claimPendingApproval: async () => false,
    };
    const runtime = new McpRuntime({
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'read', inputSchema: {} }] }),
        callTool,
        close: async () => undefined,
      }),
      governance: (definitions) => {
        const governed = new GovernedToolFactory({ ledger }).create(definitions);
        return {
          execute: async (call, context) => {
            const outcome = await governed.execute(call, context);
            for (const update of outcome.ledgerUpdates ?? []) await ledger.update(update);
            return outcome;
          },
        };
      },
    });
    await runtime.configure(tenant, {
      ops: { transport: 'http', url: 'https://mcp.example', toolCapabilities: { read: 'read' } },
    });

    await expect(runtime.invoke('mcp__ops__read', { value: 1 }, tenant)).resolves.toEqual({ content: 'once' });
    await expect(runtime.invoke('mcp__ops__read', { value: 2 }, tenant)).resolves.toEqual({ content: 'once' });
    await expect(runtime.invoke('mcp__ops__read', { value: 3 }, tenant, { idempotencyKey: 'retry-a' }))
      .resolves.toEqual({ content: 'once' });
    await expect(runtime.invoke('mcp__ops__read', { value: 3 }, tenant, { idempotencyKey: 'retry-a' }))
      .resolves.toEqual({ content: 'once' });
    expect(callTool).toHaveBeenCalledTimes(3);
    const runIds = [...records.values()].map((record) => record.runId);
    expect(new Set(runIds).size).toBe(3);
    expect(runIds.filter((runId) => runId.endsWith(':retry-a'))).toHaveLength(1);
  });

  it('redacts transport details from failed-call audit events', async () => {
    const events: McpAuditEvent[] = [];
    const runtime = new McpRuntime({
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'read', inputSchema: {} }] }),
        callTool: async () => {
          throw new Error('request failed: https://mcp.example?token=secret');
        },
        close: async () => undefined,
      }),
      audit: { record: async (event) => { events.push(event); } },
    });
    runtime.configure(tenant, {
      ops: { transport: 'http', url: 'https://mcp.example?token=secret' },
    });
    const [tool] = await runtime.discover(tenant);

    await expect(tool!.execute({
      id: 'call', logicalCallId: 'logical', name: tool!.name, arguments: {},
    }, {
      identity: tenant, runId: 'run', attemptId: 'attempt', turnNo: 1,
      idempotencyKey: 'key',
    })).rejects.toThrow('request failed');
    expect(events).toEqual([expect.objectContaining({ ok: false, error: 'mcp_error' })]);
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('emits governed definitions, applies trusted capability overrides, and audits outcomes', async () => {
    const events: McpAuditEvent[] = [];
    const runtime = new McpRuntime({
      connect: async () => ({
        listTools: async () => ({ tools: [{
          name: 'deploy', description: 'deploy app', inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        }] }),
        callTool: async ({ arguments: args }) => ({
          content: [{ type: 'text', text: `deployed:${String(args?.app)}` }],
        }),
        close: async () => undefined,
      }),
      audit: { record: async (event) => { events.push(event); } },
    });
    runtime.configure(tenant, {
      ops: {
        transport: 'http', url: 'https://mcp.example',
        toolCapabilities: { deploy: 'retryable_write' },
      },
    });

    const [tool] = await runtime.discover(tenant);
    expect(tool).toMatchObject({
      name: 'mcp__ops__deploy', description: 'deploy app',
      inputSchema: { type: 'object' }, capability: 'retryable_write', execute: expect.any(Function),
    });
    await expect(tool!.execute({
      id: 'call-1', logicalCallId: 'logical-1', name: tool!.name,
      arguments: { app: 'api' },
    }, {
      identity: tenant, runId: 'run-1', attemptId: 'attempt-1', turnNo: 1,
      idempotencyKey: 'tenant-a:run-1:logical-1',
    })).resolves.toEqual({ content: 'deployed:api', isError: false });
    expect(events).toEqual([expect.objectContaining({
      tenantId: 'tenant-a', actorId: 'user-a', server: 'ops', tool: 'deploy', ok: true,
    })]);
    expect(JSON.stringify(events)).not.toContain('https://mcp.example');
  });
});
