import type { ChatModel, Msg, StreamEvent, ToolCall, ToolResult } from '../model/types.js';
import type { PolicyMiddleware } from './policy.js';
import type { ToolContext, ToolRegistry } from './tools.js';
import type { ApprovalGate } from './approval.js';

export interface RunAgentOptions {
  model: ChatModel;
  tools: ToolRegistry;
  policy: PolicyMiddleware;
  system?: string;
  /** 初始任务（追加为 user 消息），或直接传入完整 messages。 */
  task?: string;
  messages?: Msg[];
  ctx: ToolContext;
  /** 流式事件回调（供 SSE 推前端 / 日志）。 */
  onEvent?: (e: StreamEvent) => void;
  /** 安全上限，防止工具循环失控。 */
  maxSteps?: number;
  /** needApproval 时的审批门；缺省则直接拒绝。 */
  approval?: ApprovalGate;
  /** 当前运行的取消信号；由 HTTP 终止会话或客户端断开触发。 */
  signal?: AbortSignal;
}

/** 一次运行累计的 token 用量（跨多轮）。 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunAgentResult {
  messages: Msg[];
  text: string; // 最后一轮 assistant 文本
  steps: number;
  /** 跨所有轮次累计的 token 用量（adapter 提供 usage 事件时才非零）。 */
  usage: Usage;
}

/**
 * Agentic loop：模型 → 收集 text/tool_call → Policy 校验 → dispatch → 回填 → 直到无工具调用。
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const messages: Msg[] = opts.messages ? [...opts.messages] : [];
  if (opts.task) messages.push({ role: 'user', text: opts.task });

  const system = opts.system ?? '';
  const maxSteps = opts.maxSteps ?? 20;
  let lastText = '';
  let steps = 0;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  while (steps < maxSteps) {
    throwIfAborted(opts.signal);
    steps++;
    let text = '';
    let thinking = '';
    const calls: ToolCall[] = [];
    const thinkingBlocks: { thinking: string; signature: string }[] = [];

    for await (const ev of opts.model.stream({
      system,
      messages,
      tools: opts.tools.defs(),
      signal: opts.signal,
    })) {
      throwIfAborted(opts.signal);
      opts.onEvent?.(ev);
      if (ev.type === 'thinking_delta') thinking += ev.text;
      else if (ev.type === 'thinking_block') thinkingBlocks.push({ thinking: ev.thinking, signature: ev.signature });
      else if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'tool_call') calls.push(ev.call);
      else if (ev.type === 'usage') {
        usage.inputTokens += ev.inputTokens;
        usage.outputTokens += ev.outputTokens;
      }
    }
    throwIfAborted(opts.signal);

    lastText = text;
    messages.push({
      role: 'assistant',
      text,
      thinking: thinking || undefined,
      thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined,
      toolCalls: calls.length ? calls : undefined,
    });

    if (calls.length === 0) break;
    throwIfAborted(opts.signal);

    const results = await Promise.all(
      calls.map(async (call) => {
        const result = await runOneCall(call, opts);
        // 工具完成即发事件，供前端实时标记该步完成/失败（并行调用各自完成各自上报）。
        opts.onEvent?.({ type: 'tool_result', toolId: call.id, name: call.name, isError: Boolean(result.isError) });
        return result;
      }),
    );
    throwIfAborted(opts.signal);

    messages.push({ role: 'tool', toolResults: results });
  }

  return { messages, text: lastText, steps, usage };
}

/** 执行单个工具调用：Policy 校验 → 审批 → dispatch；返回回填给模型的 ToolResult。 */
async function runOneCall(call: ToolCall, opts: RunAgentOptions): Promise<ToolResult> {
  throwIfAborted(opts.signal);
  const decision = await opts.policy.check(call, opts.ctx);
  throwIfAborted(opts.signal);
  if (decision.blocked) {
    return { id: call.id, content: `blocked by policy: ${decision.reason ?? 'denied'}`, isError: true };
  }
  if (decision.needApproval) {
    const approved = opts.approval
      ? await opts.approval.request({ call, reason: decision.reason, ctx: opts.ctx })
      : false;
    if (!approved) {
      return {
        id: call.id,
        content: `needs approval (denied): ${decision.reason ?? '该操作需要审批后才能执行'}`,
        isError: true,
      };
    }
  }
  throwIfAborted(opts.signal);
  // 为每个工具调用派生独立 ctx，注入按 call.id 归集的实时输出回调，
  // 供沙箱 stdout/stderr 流式回传到前端（不污染共享 opts.ctx，避免并发串台）。
  const callCtx: ToolContext = opts.onEvent
    ? {
        ...opts.ctx,
        onOutput: ({ stream, text }) =>
          opts.onEvent?.({ type: 'tool_output', toolId: call.id, stream, text }),
      }
    : opts.ctx;
  const result = await opts.tools.dispatch(call, callCtx);
  throwIfAborted(opts.signal);
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(typeof reason === 'string' && reason ? reason : '运行已终止');
}
