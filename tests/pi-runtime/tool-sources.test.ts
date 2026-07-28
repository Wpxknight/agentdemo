import { describe, expect, it } from 'vitest';
import { UnifiedToolRegistry } from '../../packages/pi-runtime/src/index.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';

const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  capability: 'read' as const,
  execute: async () => ({ content: name }),
});

describe('UnifiedToolRegistry', () => {
  it('registers Pi, AIoP, MCP, and Sandbox tools together', () => {
    const piRead = {
      name: 'read', label: 'read', description: 'read', parameters: { type: 'object' },
      execute: async () => ({ content: [{ type: 'text' as const, text: 'read' }], details: undefined }),
    } as AgentTool;
    const registry = new UnifiedToolRegistry()
      .registerPi(piRead, 'read')
      .register('aiop', tool('ask_user'))
      .register('mcp', tool('mcp_example'))
      .register('sandbox', tool('sandbox_exec'));

    expect(registry.names()).toEqual(expect.arrayContaining([
      'read', 'ask_user', 'mcp_example', 'sandbox_exec',
    ]));
    expect(registry.definitions()).toHaveLength(4);
  });

  it('rejects a same-name conflict even when sources differ', () => {
    const registry = new UnifiedToolRegistry().register('pi', tool('read'));
    expect(() => registry.register('mcp', tool('read'))).toThrow('duplicate tool: read');
  });
});
