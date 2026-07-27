import { describe, expect, it, vi } from 'vitest';
import { McpRuntime } from '../packages/mcp-runtime/src/index.js';

describe('McpRuntime', () => {
  it('discovers tenant-visible tools and invokes them through an injected client', async () => {
    const audit = vi.fn();
    const runtime = new McpRuntime({
      servers: [{
        name: 'ops',
        client: {
          listTools: async () => [{ name: 'get_pods', description: 'pods', inputSchema: { type: 'object' }, readOnly: true }],
          callTool: async (_name, args) => ({ content: `pods:${(args as { namespace: string }).namespace}` }),
          close: async () => undefined,
        },
        visible: (identity) => identity.tenantId === 'tenant-a',
      }],
      audit: { record: audit },
    });
    const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] };
    const tools = await runtime.discover(identity);
    expect(tools).toEqual([expect.objectContaining({ name: 'mcp__ops__get_pods', capability: 'read' })]);
    await expect(runtime.invoke('mcp__ops__get_pods', { namespace: 'default' }, identity))
      .resolves.toEqual({ content: 'pods:default' });
    expect(audit).toHaveBeenCalledOnce();
    expect(await runtime.discover({ ...identity, tenantId: 'tenant-b' })).toEqual([]);
    await runtime.close();
  });
});
