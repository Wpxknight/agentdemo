import { describe, expect, it, vi } from 'vitest';
import {
  McpManager,
  connectMcp,
  mcpToolName,
  type McpClientLike,
  type McpServerConfig,
  type McpToolInfo,
} from '../packages/mcp-runtime/src/index.js';

function fakeClient(tools: Array<Pick<McpToolInfo, 'name' | 'description' | 'annotations'>>): McpClientLike {
  return {
    listTools: vi.fn(async () => ({
      tools: tools.map((t) => ({ ...t, inputSchema: { type: 'object' } })),
    })),
    callTool: vi.fn(async (p) => ({
      content: [{ type: 'text', text: `ran ${p.name}(${JSON.stringify(p.arguments)})` }],
    })),
    close: vi.fn(async () => {}),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('McpManager', () => {
  const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
  const executionContext = {
    identity, runId: 'run-a', attemptId: 'attempt-a', turnNo: 1, idempotencyKey: 'key-a',
  } as const;

  it('connects servers and namespaces tools as mcp__server__tool', async () => {
    const servers: Record<string, McpServerConfig> = {
      fs: { transport: 'stdio', command: 'fake' },
    };
    const client = fakeClient([{ name: 'read', description: 'read file' }]);
    const mgr = new McpManager(servers, async () => client);

    await mgr.start(identity);
    const tools = await mgr.tools(identity);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('mcp__fs__read');
    expect(tools[0]!.name).toBe(mcpToolName('fs', 'read'));
  });

  it('does not trust a server read-only annotation to downgrade the default capability', async () => {
    const client = fakeClient([{ name: 'compromised', annotations: { readOnlyHint: true } }]);
    const mgr = new McpManager(
      { remote: { transport: 'http', url: 'http://untrusted.example' } },
      async () => client,
    );

    await mgr.start(identity);

    expect((await mgr.tools(identity))[0]!.capability).toBe('non_idempotent_write');
  });

  it('allows trusted configuration to explicitly downgrade a tool capability', async () => {
    const client = fakeClient([{ name: 'reviewed', annotations: { destructiveHint: true } }]);
    const mgr = new McpManager(
      {
        remote: {
          transport: 'http',
          url: 'http://reviewed.example',
          toolCapabilities: { reviewed: 'read' },
        },
      },
      async () => client,
    );

    await mgr.start(identity);

    expect((await mgr.tools(identity))[0]!.capability).toBe('read');
  });

  it('dispatch forwards to callTool and extracts text', async () => {
    const client = fakeClient([{ name: 'read' }]);
    const mgr = new McpManager({ fs: { transport: 'stdio', command: 'x' } }, async () => client);
    await mgr.start(identity);

    const tool = (await mgr.tools(identity))[0]!;
    const res = await tool.execute({
      id: 'call-a', logicalCallId: 'logical-a', name: tool.name, arguments: { path: '/etc/hosts' },
    }, executionContext);

    expect(client.callTool).toHaveBeenCalledWith({
      name: 'read',
      arguments: { path: '/etc/hosts' },
    });
    expect(res.content).toContain('ran read');
  });

  it('one server failure does not abort others', async () => {
    const ok = fakeClient([{ name: 'ping' }]);
    const mgr = new McpManager(
      {
        bad: { transport: 'stdio', command: 'x' },
        good: { transport: 'stdio', command: 'y' },
      },
      async (name) => {
        if (name === 'bad') throw new Error('boom');
        return ok;
      },
    );

    await mgr.start(identity);

    expect((await mgr.tools(identity)).map((t) => t.name)).toEqual(['mcp__good__ping']);
    // 失败的 server 保留 error 状态，供 UI 展示与重连
    const bad = (await mgr.list(identity)).find((s) => s.name === 'bad');
    expect(bad?.status).toBe('error');
    expect(bad?.error).toContain('boom');
  });

  it('add connects a new server and exposes its tools', async () => {
    const mgr = new McpManager({}, async () => fakeClient([{ name: 'echo' }]));
    await mgr.start(identity);

    const info = await mgr.add(identity, 'extra', { transport: 'stdio', command: 'x' });

    expect(info.status).toBe('connected');
    expect(info.tools).toEqual(['mcp__extra__echo']);
    expect((await mgr.tools(identity)).map((t) => t.name)).toEqual(['mcp__extra__echo']);
    expect(await mgr.configs(identity)).toEqual({ extra: { transport: 'stdio', command: 'x' } });
  });

  it('add rejects duplicate names', async () => {
    const mgr = new McpManager({}, async () => fakeClient([{ name: 'echo' }]));
    await mgr.add(identity, 'a', { transport: 'stdio', command: 'x' });

    await expect(mgr.add(identity, 'a', { transport: 'stdio', command: 'y' })).rejects.toThrow('已存在');
  });

  it('add keeps error state on connect failure; reconnect recovers', async () => {
    let fail = true;
    const mgr = new McpManager({}, async () => {
      if (fail) throw new Error('down');
      return fakeClient([{ name: 'ping' }]);
    });

    const info = await mgr.add(identity, 'flaky', { transport: 'http', url: 'http://x' });
    expect(info.status).toBe('error');
    expect(info.error).toContain('down');
    expect(await mgr.tools(identity)).toHaveLength(0);

    fail = false;
    const recovered = await mgr.reconnect(identity, 'flaky');
    expect(recovered.status).toBe('connected');
    expect((await mgr.tools(identity)).map((t) => t.name)).toEqual(['mcp__flaky__ping']);
  });

  it('remove closes the client and drops its tools', async () => {
    const client = fakeClient([{ name: 'echo' }]);
    const mgr = new McpManager({ a: { transport: 'stdio', command: 'x' } }, async () => client);
    await mgr.start(identity);

    expect(await mgr.remove(identity, 'a')).toBe(true);

    expect(client.close).toHaveBeenCalled();
    expect(await mgr.tools(identity)).toHaveLength(0);
    expect(await mgr.list(identity)).toHaveLength(0);
    expect(await mgr.remove(identity, 'a')).toBe(false);
  });

  it('reconnect on unknown server throws', async () => {
    const mgr = new McpManager({}, async () => fakeClient([]));
    await expect(mgr.reconnect(identity, 'nope')).rejects.toThrow('不存在');
  });

  it('keeps the newer reconnect when an older initial connection finishes last', async () => {
    const firstConnection = deferred<McpClientLike>();
    const secondConnection = deferred<McpClientLike>();
    const oldClient = fakeClient([{ name: 'old' }]);
    const newClient = fakeClient([{ name: 'new' }]);
    let calls = 0;
    const mgr = new McpManager(
      { racing: { transport: 'stdio', command: 'x' } },
      async () => (++calls === 1 ? firstConnection.promise : secondConnection.promise),
    );

    const starting = mgr.start(identity);
    const reconnecting = mgr.reconnect(identity, 'racing');
    secondConnection.resolve(newClient);
    await reconnecting;
    firstConnection.resolve(oldClient);
    await starting;

    expect((await mgr.info(identity, 'racing'))?.tools).toEqual(['mcp__racing__new']);
    expect(oldClient.close).toHaveBeenCalledOnce();
    expect(newClient.close).not.toHaveBeenCalled();
  });

  it('closes a client whose connection finishes after the server is removed', async () => {
    const connection = deferred<McpClientLike>();
    const client = fakeClient([{ name: 'late' }]);
    const mgr = new McpManager(
      { removed: { transport: 'stdio', command: 'x' } },
      async () => connection.promise,
    );

    const starting = mgr.start(identity);
    await expect(mgr.remove(identity, 'removed')).resolves.toBe(true);
    connection.resolve(client);
    await starting;

    expect(client.close).toHaveBeenCalledOnce();
    expect(await mgr.info(identity, 'removed')).toBeUndefined();
    expect(await mgr.tools(identity)).toEqual([]);
  });
});

describe('local MCP smoke server', () => {
  it('connects over stdio and calls echo', async () => {
    const client = await connectMcp('local', {
      transport: 'stdio',
      command: 'node',
      args: ['--import', 'tsx', 'scripts/mcp-echo-server.ts'],
    });
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain('echo');

      const res = await client.callTool({ name: 'echo', arguments: { text: 'mcp-ok' } });
      expect(res.content).toEqual([{ type: 'text', text: 'mcp-ok' }]);
    } finally {
      await client.close();
    }
  });
});
