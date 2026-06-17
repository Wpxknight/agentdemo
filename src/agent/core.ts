import type { ChatModel, Msg, StreamEvent, ToolCall } from '../model/types.js';
import type { PolicyMiddleware } from './policy.js';
import type { ToolContext, ToolRegistry } from './tools.js';

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
}

export interface RunAgentResult {
  messages: Msg[];
  text: string; // 最后一轮 assistant 文本
  steps: number;
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

  while (steps < maxSteps) {
    steps++;
    let text = '';
    const calls: ToolCall[] = [];

    for await (const ev of opts.model.stream({
      system,
      messages,
      tools: opts.tools.defs(),
    })) {
      opts.onEvent?.(ev);
      if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'tool_call') calls.push(ev.call);
    }

    lastText = text;
    messages.push({
      role: 'assistant',
      text,
      toolCalls: calls.length ? calls : undefined,
    });

    if (calls.length === 0) break;

    const results = await Promise.all(
      calls.map(async (call) => {
        const decision = await opts.policy.check(call);
        if (decision.blocked) {
          return {
            id: call.id,
            content: `blocked by policy: ${decision.reason ?? 'denied'}`,
            isError: true,
          };
        }
        // TODO(S4): needApproval -> 暂停 loop 等待审批
        return opts.tools.dispatch(call, opts.ctx);
      }),
    );

    messages.push({ role: 'tool', toolResults: results });
  }

  return { messages, text: lastText, steps };
}
