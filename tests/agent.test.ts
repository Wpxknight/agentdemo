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
        expect(input.system).toContain('只读检查、信息整理、生成草稿、编写计划或不影响现有系统状态的纯新增内容，可直接执行');
        expect(input.system).toContain('尽量减少不必要的用户确认');
        expect(input.system).toContain('涉及修改现有系统状态、破坏、删除、重启、部署、修复、扩缩容、写配置、生产变更、凭据暴露、费用明显增加或其他不可逆/高风险操作时，必须先向用户确认');
        expect(input.system).toContain('### 待确认变更');
        expect(input.system).toContain('- 操作内容：');
        expect(input.system).toContain('- 操作目的：');
        expect(input.system).toContain('- 影响范围：');
        expect(input.system).toContain('- 风险点：');
        expect(input.system).toContain('- 验证方式：');
        expect(input.system).toContain('用户明确同意后才可执行高风险或不可逆变更；执行后必须验证结果');
        expect(input.system).toContain('任务结束必须用 Markdown 格式汇报');
        expect(input.system).toContain('尽量简洁，不写长段铺垫');
        expect(input.system).toContain('按任务类型选择一组模板');
        expect(input.system).toContain('### 执行汇报：修复型任务');
        expect(input.system).toContain('| 问题根因 | 一句话说明根因');
        expect(input.system).toContain('| 解决办法 | 说明已采取的修复动作');
        expect(input.system).toContain('| 执行结果 | 说明验证结果');
        expect(input.system).toContain('### 执行汇报：巡检/网络检查类任务');
        expect(input.system).toContain('| 执行结果 | 列关键检查结果');
        expect(input.system).toContain('| 后续建议 |');
        expect(input.system).toContain('互不依赖的多个操作尽量在同一轮并行发起多个工具调用');
        expect(input.system).toContain('纯知识问答或一句话能说清的简单问题直接回答，不必套用模板');
        expect(input.system).toContain('### 执行汇报：信息查询类任务');
        expect(input.system).toContain('| 查询结果 | 直接给出查到的信息');
        // 交互场景不应带无人值守规则
        expect(input.system).not.toContain('无人值守运行说明');
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

  it('unattended runs swap confirmation rules for skip-and-report guidance', async () => {
    const model: ChatModel = {
      id: 'unattended-model',
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        expect(input.system).toContain('无人值守运行说明');
        expect(input.system).toContain('一律视为不可执行——直接跳过，不要输出“待确认变更”等待回复');
        expect(input.system).toContain('需人工处理');
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
      unattended: true,
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

  it('retries model connection failures before any stream event up to success', async () => {
    let attempts = 0;
    const seen: StreamEvent[] = [];
    const model: ChatModel = {
      id: 'flaky',
      async *stream(): AsyncIterable<StreamEvent> {
        attempts++;
        if (attempts < 3) throw new Error(`connect ${attempts}`);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };

    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
      modelRetryDelayMs: 0,
      onEvent: (event) => seen.push(event),
    });

    expect(attempts).toBe(3);
    expect(seen.filter((event) => event.type === 'model_retry')).toEqual([
      { type: 'model_retry', attempt: 1, maxAttempts: 10, error: 'connect 1', discardTextChars: 0, discardThinkingChars: 0, discardToolIds: [] },
      { type: 'model_retry', attempt: 2, maxAttempts: 10, error: 'connect 2', discardTextChars: 0, discardThinkingChars: 0, discardToolIds: [] },
    ]);
    expect(result.text).toBe('ok');
  });

  it('retries a mid-stream failure, discarding the partial turn (with rollback info)', async () => {
    let attempts = 0;
    const seen: StreamEvent[] = [];
    const model: ChatModel = {
      id: 'partial-fail',
      async *stream(): AsyncIterable<StreamEvent> {
        attempts++;
        if (attempts === 1) {
          yield { type: 'text_delta', text: 'partial' };
          yield { type: 'tool_call', call: { id: 'dead-1', name: 'echo', args: {} } };
          throw new Error('stream lost');
        }
        yield { type: 'text_delta', text: 'complete answer' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };

    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
      modelRetryDelayMs: 0,
      onEvent: (event) => seen.push(event),
    });

    expect(attempts).toBe(2);
    // 失败尝试的部分输出被整轮丢弃：最终答案不含 'partial'，也不会执行 dead-1 工具调用
    expect(result.text).toBe('complete answer');
    expect(result.messages.at(-1)!.toolCalls).toBeUndefined();
    expect(seen.filter((event) => event.type === 'model_retry')).toEqual([
      { type: 'model_retry', attempt: 1, maxAttempts: 10, error: 'stream lost', discardTextChars: 'partial'.length, discardThinkingChars: 0, discardToolIds: ['dead-1'] },
    ]);
  });

  it('fails fast on deterministic client errors (4xx) without retrying', async () => {
    let attempts = 0;
    const model: ChatModel = {
      id: 'bad-request',
      async *stream(): AsyncIterable<StreamEvent> {
        attempts++;
        const err = new Error('invalid request') as Error & { status: number };
        err.status = 400;
        throw err;
      },
    };

    await expect(runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
      modelRetryDelayMs: 0,
    })).rejects.toThrow('invalid request');
    expect(attempts).toBe(1);
  });

  it('drains pending user messages before finishing the current run', async () => {
    let turn = 0;
    const seenTurns: Array<Array<[string, string | undefined]>> = [];
    const model: ChatModel = {
      id: 'pending-aware',
      async *stream(input): AsyncIterable<StreamEvent> {
        turn++;
        seenTurns.push(input.messages.map((message) => [message.role, message.text]));
        if (turn === 1) {
          yield { type: 'text_delta', text: 'first' };
        } else {
          yield { type: 'text_delta', text: 'second' };
        }
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    let drained = false;

    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'original',
      drainPendingMessages: () => {
        if (drained) return [];
        drained = true;
        return [{ role: 'user', text: 'correction' }];
      },
    });

    expect(turn).toBe(2);
    expect(result.text).toBe('second');
    expect(result.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'original'],
      ['assistant', 'first'],
      ['user', 'correction'],
      ['assistant', 'second'],
    ]);
    expect(seenTurns[1]).toContainEqual(['user', 'correction']);
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

describe('runAgent 摘要压缩', () => {
  function longHistory(pairs: number, charsPerMsg: number): import('../src/model/types.js').Msg[] {
    const msgs: import('../src/model/types.js').Msg[] = [];
    for (let i = 0; i < pairs; i++) {
      msgs.push({ role: 'user', text: `问题${i} ${'x'.repeat(charsPerMsg)}` });
      msgs.push({ role: 'assistant', text: `回答${i} ${'y'.repeat(charsPerMsg)}` });
    }
    return msgs;
  }

  it('轮次边界触发摘要压缩：改写历史、上报 context_compacted、result.compacted = true', async () => {
    const model: ChatModel = {
      id: 'm',
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        // 首轮边界已压缩：发给模型的历史应以摘要开头
        expect(input.messages[0]!.text).toContain('历史对话摘要');
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const summarize = vi.fn(async () => '这是历史摘要');
    const events: StreamEvent[] = [];

    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      messages: longHistory(10, 4000), // ≈20k tokens
      task: '继续',
      summarize,
      compactionTriggerTokens: 5000,
      compactionKeepRecent: 4,
      onEvent: (e) => events.push(e),
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.compacted).toBe(true);
    expect(result.messages[0]!.text).toContain('这是历史摘要');
    // 最近 4 条 + 本轮 task 原样保留
    expect(result.messages.some((m) => m.text?.includes('问题9'))).toBe(true);
    expect(result.messages.some((m) => m.text === '继续')).toBe(true);
    const ev = events.find((e) => e.type === 'context_compacted');
    expect(ev).toBeDefined();
    if (ev?.type === 'context_compacted') {
      expect(ev.beforeTokens).toBeGreaterThan(5000);
      expect(ev.afterTokens).toBeLessThan(ev.beforeTokens);
      expect(ev.summarizedMessages).toBeGreaterThan(0);
    }
  });

  it('摘要后仍超触发线时记水位：历史没涨够不重复摘要', async () => {
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });
    let turn = 0;
    const model: ChatModel = {
      id: 'm',
      async *stream(): AsyncIterable<StreamEvent> {
        turn++;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: 'c1', name: 'echo', args: {} } };
        } else {
          yield { type: 'text_delta', text: 'done' };
        }
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    // 最近 8 条每条 ≈2000 tokens：压缩后 ≈16k 仍高于触发线 10k
    const summarize = vi.fn(async () => '摘要');

    const result = await runAgent({
      model,
      tools,
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      messages: longHistory(10, 8000),
      task: '继续',
      summarize,
      compactionTriggerTokens: 10_000,
      compactionKeepRecent: 8,
    });

    // 第二轮边界历史仍超触发线但低于水位：不再白跑摘要
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.compacted).toBe(true);
    expect(result.text).toBe('done');
  });

  it('摘要失败不阻断本轮（继续对话，硬裁剪兜底）', async () => {
    const model: ChatModel = {
      id: 'm',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const events: StreamEvent[] = [];
    const result = await runAgent({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      messages: longHistory(10, 4000),
      task: '继续',
      summarize: async () => { throw new Error('summary model down'); },
      compactionTriggerTokens: 5000,
      contextBudgetTokens: 8000,
      onEvent: (e) => events.push(e),
    });

    expect(result.compacted).toBe(false);
    expect(result.text).toBe('ok');
    expect(events.some((e) => e.type === 'context_compacted')).toBe(false);
  });
});

describe('runAgent 步数限制', () => {
  it('默认不限步数：超过 20 轮的工具循环也能跑到完成', async () => {
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });
    let turn = 0;
    const model: ChatModel = {
      id: 'm',
      async *stream(): AsyncIterable<StreamEvent> {
        turn++;
        if (turn <= 30) {
          yield { type: 'tool_call', call: { id: `c${turn}`, name: 'echo', args: {} } };
        } else {
          yield { type: 'text_delta', text: 'finished' };
        }
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const result = await runAgent({
      model,
      tools,
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
    });
    expect(result.steps).toBe(31);
    expect(result.text).toBe('finished');
  });

  it('显式 maxSteps 仍然生效（无人值守场景的兜底）', async () => {
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });
    let turn = 0;
    const model: ChatModel = {
      id: 'm',
      async *stream(): AsyncIterable<StreamEvent> {
        turn++;
        yield { type: 'tool_call', call: { id: `c${turn}`, name: 'echo', args: {} } }; // 永远调工具
        yield { type: 'stop', reason: 'tool_use' };
      },
    };
    const result = await runAgent({
      model,
      tools,
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 't1' },
      task: 'go',
      maxSteps: 5,
    });
    expect(result.steps).toBe(5);
  });
});
