import { describe, expect, it, vi } from 'vitest';
import { McpManager, mcpToolName } from '../src/mcp/manager.js';
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
  });
});
