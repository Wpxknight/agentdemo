import { describe, expect, it, vi } from 'vitest';
import {
  McpDisconnectedError,
  McpRuntime,
  type McpClientLike,
  type McpConnectFn,
} from '../../packages/mcp-runtime/src/index.js';

const tenant = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] };

function readyClient(text = 'ok'): McpClientLike {
  return {
    listTools: vi.fn(async () => ({ tools: [{ name: 'read', inputSchema: {} }] })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text }] })),
    close: vi.fn(async () => undefined),
  };
}

describe('MCP reconnect policy', () => {
  it('closes a late client after a connection timeout when retries are disabled', async () => {
    let resolveConnection!: (client: McpClientLike) => void;
    const connection = new Promise<McpClientLike>((resolve) => { resolveConnection = resolve; });
    const late = readyClient();
    const runtime = new McpRuntime({ connect: async () => connection });
    runtime.configure(tenant, {
      late: { transport: 'http', url: 'https://mcp.example', timeoutMs: 5 },
    });

    await expect(runtime.discover(tenant)).resolves.toEqual([]);
    resolveConnection(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
  });

  it('closes a client that finishes connecting after runtime shutdown', async () => {
    let resolveConnection!: (client: McpClientLike) => void;
    const connection = new Promise<McpClientLike>((resolve) => { resolveConnection = resolve; });
    const late = readyClient();
    const runtime = new McpRuntime({ connect: async () => connection });
    runtime.configure(tenant, {
      late: { transport: 'http', url: 'https://mcp.example' },
    });

    const discovering = runtime.discover(tenant);
    await runtime.close();
    resolveConnection(late);
    await discovering;

    expect(late.close).toHaveBeenCalledOnce();
  });

  it('times out connection establishment and reconnects when policy allows it', async () => {
    const recovered = readyClient();
    let calls = 0;
    const connect = vi.fn<McpConnectFn>(async () => {
      calls += 1;
      if (calls === 1) return new Promise<McpClientLike>(() => undefined);
      return recovered;
    });
    const runtime = new McpRuntime({ connect });
    runtime.configure(tenant, {
      flaky: {
        transport: 'http', url: 'https://mcp.example', timeoutMs: 5,
        reconnect: { maxAttempts: 1, retryOnTimeout: true, backoffMs: 0 },
      },
    });

    await expect(runtime.discover(tenant)).resolves.toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('closes a timed-out connection and reconnects for discovery when policy allows it', async () => {
    const timedOut: McpClientLike = {
      listTools: vi.fn(() => new Promise<{ tools: [] }>(() => undefined)),
      callTool: vi.fn(async () => ({ content: [] })),
      close: vi.fn(async () => undefined),
    };
    const recovered = readyClient();
    let calls = 0;
    const connect = vi.fn<McpConnectFn>(async () => (++calls === 1 ? timedOut : recovered));
    const runtime = new McpRuntime({ connect });
    runtime.configure(tenant, {
      flaky: {
        transport: 'http', url: 'https://mcp.example', timeoutMs: 5,
        reconnect: { maxAttempts: 1, retryOnTimeout: true, backoffMs: 0 },
      },
    });

    await expect(runtime.discover(tenant)).resolves.toHaveLength(1);
    expect(timedOut.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects and retries an idempotent tool after a disconnect', async () => {
    const disconnected = readyClient();
    vi.mocked(disconnected.callTool).mockRejectedValueOnce(new McpDisconnectedError('socket closed'));
    const recovered = readyClient('recovered');
    let calls = 0;
    const connect = vi.fn<McpConnectFn>(async () => (++calls === 1 ? disconnected : recovered));
    const runtime = new McpRuntime({ connect });
    runtime.configure(tenant, {
      flaky: {
        transport: 'http', url: 'https://mcp.example',
        toolCapabilities: { read: 'read' },
        reconnect: { maxAttempts: 1, retryOnDisconnect: true, backoffMs: 0 },
      },
    });
    const [tool] = await runtime.discover(tenant);

    await expect(tool!.execute({
      id: 'call', logicalCallId: 'logical', name: tool!.name, arguments: {},
    }, {
      identity: tenant, runId: 'run', attemptId: 'attempt', turnNo: 1,
      idempotencyKey: 'key',
    })).resolves.toMatchObject({ content: 'recovered' });
    expect(disconnected.close).toHaveBeenCalledOnce();
    expect(recovered.callTool).toHaveBeenCalledOnce();
  });
});
