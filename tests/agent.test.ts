import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent/core.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import { SkillRegistry } from '../src/skill/registry.js';
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
  it('adds chat safety and final-report requirements to the system prompt', async () => {
    const model: ChatModel = {
      id: 'system-contract-model',
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        expect(input.system).toContain('默认中文回复，结论清晰，过程可追溯，不编造结果');
        expect(input.system).toContain('只读检查可直接执行');
        expect(input.system).toContain('涉及创建、修改、删除、重启、部署、修复、扩缩容、写配置或其他有副作用操作时，必须先向用户确认');
        expect(input.system).toContain('### 待确认变更');
        expect(input.system).toContain('- 操作内容：');
        expect(input.system).toContain('- 操作目的：');
        expect(input.system).toContain('- 影响范围：');
        expect(input.system).toContain('- 风险点：');
        expect(input.system).toContain('- 验证方式：');
        expect(input.system).toContain('用户明确同意后才可执行变更；执行后必须验证结果');
        expect(input.system).toContain('### 执行汇报');
        expect(input.system).toContain('问题根因');
        expect(input.system).toContain('已解决');
        expect(input.system).toContain('关键操作');
        expect(input.system).toContain('未完成');
        expect(input.system).toContain('风险与影响');
        expect(input.system).toContain('后续建议');
        expect(input.system).toContain('existing system instructions');
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };

    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      system: 'existing system instructions',
      ctx: { sessionId: 't1' },
      task: 'go',
    });

    expect(result.text).toBe('ok');
  });

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

  it('emits tool_result per tool call for live progress', async () => {
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });
    const seen: StreamEvent[] = [];

    await runAgent({
      model: mockModel(),
      tools,
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
      onEvent: (event) => seen.push(event),
    });

    expect(seen).toContainEqual({ type: 'tool_result', toolId: 'c1', name: 'echo', isError: false });
  });

  it('accumulates usage across turns', async () => {
    const model: ChatModel = {
      id: 'm',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
    });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('keeps model thinking separate from assistant answer text', async () => {
    const seen: StreamEvent[] = [];
    const model: ChatModel = {
      id: 'thinking-model',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'thinking_delta', text: '先判断需要读取上下文。' };
        yield { type: 'text_delta', text: '结论：需要巡检。' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };

    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
      onEvent: (event) => seen.push(event),
    });

    const assistant = result.messages.find((m) => m.role === 'assistant');
    expect(result.text).toBe('结论：需要巡检。');
    expect(assistant?.text).toBe('结论：需要巡检。');
    expect(assistant?.thinking).toBe('先判断需要读取上下文。');
    expect(seen).toContainEqual({ type: 'thinking_delta', text: '先判断需要读取上下文。' });
  });

  it('exposes skill summaries so the model can auto-load a relevant skill during chat', async () => {
    const skills = new SkillRegistry('skills');
    await skills.scan();

    const tools = new ToolRegistry();
    tools.register(skills.tool());

    let turn = 0;
    const model: ChatModel = {
      id: 'skill-aware-model',
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        turn++;
        expect(input.system).toContain('可用技能');
        expect(input.system).toContain('inspect: 集群健康巡检');
        expect(input.tools.map((tool) => tool.name)).toContain('load_skill');

        if (turn === 1) {
          expect(input.messages.at(-1)?.text).toContain('巡检');
          yield { type: 'tool_call', call: { id: 'skill-1', name: 'load_skill', args: { name: 'inspect' } } };
          yield { type: 'stop', reason: 'tool_use' };
          return;
        }

        const loaded = input.messages.at(-1)?.toolResults?.[0]?.content ?? '';
        expect(loaded).toContain('# 集群巡检');
        yield { type: 'text_delta', text: '已按 inspect 技能完成巡检准备。' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };

    const result = await runAgent({
      model,
      tools,
      policy: new AllowAllPolicy(),
      system: skills.summaries(),
      ctx: { sessionId: 't1' },
      task: '请巡检 prod 命名空间的 Pod 健康状态',
    });

    expect(turn).toBe(2);
    expect(result.text).toBe('已按 inspect 技能完成巡检准备。');
    expect(result.messages.find((message) => message.role === 'tool')?.toolResults?.[0]?.content).toContain('# 集群巡检');
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
