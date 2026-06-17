import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent/core.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { ChatModel, StreamEvent, StreamInput } from '../src/model/types.js';

/** 一个脚本化的 mock 模型：第一轮发起一次 tool_call，第二轮纯文本结束。 */
function mockModel(): ChatModel {
  let turn = 0;
  return {
    id: 'mock',
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      turn++;
      if (turn === 1) {
        yield { type: 'text_delta', text: 'calling tool' };
        yield { type: 'tool_call', call: { id: 'c1', name: 'echo', args: { v: 'hello' } } };
        yield { type: 'stop', reason: 'tool_use' };
      } else {
        // 第二轮应能看到上一轮的 tool 结果
        const last = input.messages.at(-1);
        const got = last?.toolResults?.[0]?.content ?? '';
        yield { type: 'text_delta', text: `done: ${got}` };
        yield { type: 'stop', reason: 'end_turn' };
      }
    },
  };
}

describe('runAgent', () => {
  it('dispatches tool calls and loops until no tool call', async () => {
    const tools = new ToolRegistry();
    const run = vi.fn(async (args: unknown) => ({
      id: '',
      content: `echo:${JSON.stringify(args)}`,
    }));
    tools.register({
      def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      run,
    });

    const result = await runAgent({
      model: mockModel(),
      tools,
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result.steps).toBe(2);
    expect(result.text).toBe('done: echo:{"v":"hello"}');
    // messages: user, assistant(tool_call), tool(result), assistant(final)
    expect(result.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('blocks tool when policy denies', async () => {
    const tools = new ToolRegistry();
    const run = vi.fn(async () => ({ id: '', content: 'should not run' }));
    tools.register({
      def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      run,
    });

    const result = await runAgent({
      model: mockModel(),
      tools,
      policy: { check: async () => ({ blocked: true, reason: 'nope' }) },
      ctx: { sessionId: 't1' },
      task: 'go',
    });

    expect(run).not.toHaveBeenCalled();
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.toolResults?.[0]?.isError).toBe(true);
    expect(toolMsg?.toolResults?.[0]?.content).toContain('nope');
  });
});
