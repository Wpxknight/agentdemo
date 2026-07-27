import { describe, expect, it } from 'vitest';
import { PiAIOPAgentKernel } from '../src/agent/pi/kernel.js';
import { ToolRegistry } from '../src/agent/tools.js';

describe('PiAIOPAgentKernel', () => {
  it('adapts the existing AIOP model, tools and events through Pi', async () => {
    let request = 0;
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } },
      run: async () => ({ id: 'ignored', content: 'value=7' }),
    });
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
      task: 'question',
      ctx: { sessionId: 'session-a', tenantId: 'tenant-a', userId: 'user-a' },
      onEvent: (event) => events.push(event.type),
    });
    expect(result.text).toBe('answer');
    expect(result.steps).toBe(2);
    expect(events).toContain('tool_result');
  });
});
