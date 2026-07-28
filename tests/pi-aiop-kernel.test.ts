import { describe, expect, it } from 'vitest';
import { PiAIOPAgentKernel, piToolDefinitions } from '../src/agent/pi/kernel.js';
import { ToolRegistry, defineTool } from '../src/agent/tools.js';
import { vi } from 'vitest';

describe('PiAIOPAgentKernel', () => {
  it('adapts the existing AIOP model, tools and events through Pi', async () => {
    let request = 0;
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => ({ id: 'ignored', content: 'value=7' }));
    tools.register(defineTool({
      name: 'lookup', description: 'lookup', inputSchema: { type: 'object' }, capability: 'read', execute,
    }));
    const preTool = vi.fn(async () => ({ denied: true, reason: 'legacy hook must not run' }));
    const events: string[] = [];
    const result = await new PiAIOPAgentKernel().run({
      runId: 'run-a',
      model: {
        id: 'fake',
        async *stream() {
          request++;
          if (request === 1) {
            yield { type: 'tool_call', call: { id: 'call-a', name: 'lookup', args: { id: 7 } } } as const;
            yield { type: 'stop', reason: 'tool_use' } as const;
          } else {
            yield { type: 'text_delta', text: 'answer' } as const;
            yield { type: 'stop', reason: 'end_turn' } as const;
          }
        },
      },
      tools,
      policy: { check: async () => ({ blocked: false, needApproval: false }) },
      hooks: { empty: false, preTool } as never,
      task: 'question',
      ctx: { sessionId: 'session-a', tenantId: 'tenant-a', userId: 'user-a' },
      onEvent: (event) => events.push(event.type),
    });
    expect(result.text).toBe('answer');
    expect(result.steps).toBe(2);
    expect(events).toContain('tool_result');
    expect(execute).toHaveBeenCalledOnce();
    expect(preTool).not.toHaveBeenCalled();
  });

  it('preserves declared capabilities without a name heuristic', () => {
    const tools = new ToolRegistry()
      .register(defineTool({
        name: 'get_dangerous', description: 'write', inputSchema: {}, capability: 'non_idempotent_write',
        execute: async () => ({ id: '', content: 'ok' }),
      }))
      .register(defineTool({
        name: 'mutate_cache', description: 'retry', inputSchema: {}, capability: 'retryable_write',
        execute: async () => ({ id: '', content: 'ok' }),
      }));
    const options = {
      tools,
      filterToolDefs: undefined,
    } as never;

    expect(piToolDefinitions(options)).toEqual([
      expect.objectContaining({ name: 'get_dangerous', capability: 'non_idempotent_write' }),
      expect.objectContaining({ name: 'mutate_cache', capability: 'retryable_write' }),
    ]);
  });
});
