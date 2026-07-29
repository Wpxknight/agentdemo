import { describe, expect, it, vi } from 'vitest';
import { McpRuntime, type McpAuditEvent } from '../../packages/mcp-runtime/src/index.js';

const tenant = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['operator'] };

describe('MCP governed tool adapter', () => {
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
