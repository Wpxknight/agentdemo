import { describe, expect, it, vi } from 'vitest';
import { McpRuntime } from '../packages/mcp-runtime/src/index.js';

describe('McpRuntime', () => {
  it('discovers tenant-visible tools and invokes them through an injected client', async () => {
    const audit = vi.fn();
    const runtime = new McpRuntime({
      connect: async () => ({
        listTools: async () => ({
          tools: [{
            name: 'get_pods', description: 'pods', inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          }],
        }),
        callTool: async ({ arguments: args }) => ({
          content: [{ type: 'text', text: `pods:${String(args?.namespace)}` }],
        }),
        close: async () => undefined,
      }),
      visible: (identity) => identity.tenantId === 'tenant-a',
      audit: { record: audit },
    });
    const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] };
    runtime.configure(identity, {
      ops: {
        transport: 'http', url: 'https://mcp.example',
        toolCapabilities: { get_pods: 'read' },
      },
    });
    runtime.configure({ ...identity, tenantId: 'tenant-b' }, {
      ops: { transport: 'http', url: 'https://mcp.example' },
    });
    const tools = await runtime.discover(identity);
    expect(tools).toEqual([expect.objectContaining({ name: 'mcp__ops__get_pods', capability: 'read' })]);
    await expect(runtime.invoke('mcp__ops__get_pods', { namespace: 'default' }, identity))
      .resolves.toEqual({ content: 'pods:default' });
    expect(audit).toHaveBeenCalledOnce();
    expect(await runtime.discover({ ...identity, tenantId: 'tenant-b' })).toEqual([]);
    await runtime.close();
  });
});
