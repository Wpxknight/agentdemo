import { describe, expect, it } from 'vitest';
import { LegacyAgentKernel } from '../src/agent/legacy-kernel.js';
import { LangGraphAgentKernel } from '../src/agent/langgraph/kernel.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { ChatModel, StreamEvent } from '../src/model/types.js';

function scriptedModel(): ChatModel {
  let turn = 0;
  return {
    id: 'parity',
    async *stream() {
      turn += 1;
      if (turn === 1) {
        yield { type: 'thinking_delta', text: 'think' };
        yield { type: 'tool_call', call: { id: 'echo-1', name: 'echo', args: { value: 'x' } } };
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 };
        yield { type: 'stop', reason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'usage', inputTokens: 3, outputTokens: 2 };
      yield { type: 'stop', reason: 'end_turn' };
    },
  };
}

function tools(): ToolRegistry {
  return new ToolRegistry().register({
    def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
    run: async () => ({ id: '', content: 'echoed' }),
  });
}

describe('agent kernel parity', () => {
  it('returns the same public result and event sequence for the same replay', async () => {
    const run = async (kernel: LegacyAgentKernel | LangGraphAgentKernel) => {
      const events: StreamEvent[] = [];
      const result = await kernel.run({
        model: scriptedModel(), tools: tools(), policy: new AllowAllPolicy(),
        ctx: { sessionId: 'parity' }, task: 'go', modelRetryDelayMs: 0,
        onEvent: (event) => events.push(event),
      });
      return { result, events };
    };

    const legacy = await run(new LegacyAgentKernel());
    const langgraph = await run(new LangGraphAgentKernel());
    expect(langgraph).toEqual(legacy);
  });
});
