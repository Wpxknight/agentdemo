import { describe, expect, it, vi } from 'vitest';
import { McpManager, mcpToolName } from '../src/mcp/manager.js';
import { connectMcp } from '../src/mcp/client.js';
import type { McpClientLike, McpServerConfig } from '../src/mcp/types.js';

function fakeClient(tools: { name: string; description?: string }[]): McpClientLike {
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

describe('McpManager', () => {
  const ctx = { sessionId: 's1' };

  it('connects servers and namespaces tools as mcp__server__tool', async () => {
    const servers: Record<string, McpServerConfig> = {
      fs: { transport: 'stdio', command: 'fake' },
    };
    const client = fakeClient([{ name: 'read', description: 'read file' }]);
    const mgr = new McpManager(servers, async () => client);

    await mgr.start();
    const tools = mgr.tools();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.def.name).toBe('mcp__fs__read');
    expect(tools[0]!.def.name).toBe(mcpToolName('fs', 'read'));
  });

  it('dispatch forwards to callTool and extracts text', async () => {
    const client = fakeClient([{ name: 'read' }]);
    const mgr = new McpManager({ fs: { transport: 'stdio', command: 'x' } }, async () => client);
    await mgr.start();

    const res = await mgr.tools()[0]!.run({ path: '/etc/hosts' }, ctx);

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

    await mgr.start();

    expect(mgr.tools().map((t) => t.def.name)).toEqual(['mcp__good__ping']);
    // 失败的 server 保留 error 状态，供 UI 展示与重连
    const bad = mgr.list().find((s) => s.name === 'bad');
    expect(bad?.status).toBe('error');
    expect(bad?.error).toContain('boom');
  });

  it('add connects a new server and exposes its tools', async () => {
    const mgr = new McpManager({}, async () => fakeClient([{ name: 'echo' }]));
    await mgr.start();

    const info = await mgr.add('extra', { transport: 'stdio', command: 'x' });

    expect(info.status).toBe('connected');
    expect(info.tools).toEqual(['mcp__extra__echo']);
    expect(mgr.tools().map((t) => t.def.name)).toEqual(['mcp__extra__echo']);
    expect(mgr.configs()).toEqual({ extra: { transport: 'stdio', command: 'x' } });
  });

  it('add rejects duplicate names', async () => {
    const mgr = new McpManager({}, async () => fakeClient([{ name: 'echo' }]));
    await mgr.add('a', { transport: 'stdio', command: 'x' });

    await expect(mgr.add('a', { transport: 'stdio', command: 'y' })).rejects.toThrow('已存在');
  });

  it('add keeps error state on connect failure; reconnect recovers', async () => {
    let fail = true;
    const mgr = new McpManager({}, async () => {
      if (fail) throw new Error('down');
      return fakeClient([{ name: 'ping' }]);
    });

    const info = await mgr.add('flaky', { transport: 'http', url: 'http://x' });
    expect(info.status).toBe('error');
    expect(info.error).toContain('down');
    expect(mgr.tools()).toHaveLength(0);

    fail = false;
    const recovered = await mgr.reconnect('flaky');
    expect(recovered.status).toBe('connected');
    expect(mgr.tools().map((t) => t.def.name)).toEqual(['mcp__flaky__ping']);
  });

  it('remove closes the client and drops its tools', async () => {
    const client = fakeClient([{ name: 'echo' }]);
    const mgr = new McpManager({ a: { transport: 'stdio', command: 'x' } }, async () => client);
    await mgr.start();

    expect(await mgr.remove('a')).toBe(true);

    expect(client.close).toHaveBeenCalled();
    expect(mgr.tools()).toHaveLength(0);
    expect(mgr.list()).toHaveLength(0);
    expect(await mgr.remove('a')).toBe(false);
  });

  it('reconnect on unknown server throws', async () => {
    const mgr = new McpManager({}, async () => fakeClient([]));
    await expect(mgr.reconnect('nope')).rejects.toThrow('不存在');
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
