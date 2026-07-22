import type { ChatModel, Msg, StreamEvent, ToolCall, ToolContentBlock, ToolDef, ToolResult } from '../model/types.js';
import { compactMessages, estimateTokens, isUserInputMsg, planCompaction, summaryMessage } from './context.js';
import type { PolicyMiddleware } from './policy.js';
import type { ToolContext, ToolRegistry } from './tools.js';
import type { ApprovalGate } from './approval.js';
import type { HookRunner } from './hooks.js';
import type { QuestionAnswers, QuestionSpec } from './question.js';
import type { ChangePlan } from './plan.js';
import { buildSystemPrompt } from './services/prompt.js';
import { runModelTurn, type Usage } from './services/model-gateway.js';

export { CHAT_SYSTEM_GUARDRAILS, UNATTENDED_SYSTEM_GUARDRAILS } from './services/prompt.js';
export { MAX_MODEL_RETRIES } from './services/model-gateway.js';
export type { Usage } from './services/model-gateway.js';

export interface RunAgentOptions {
  model: ChatModel;
  tools: ToolRegistry;
  policy: PolicyMiddleware;
  system?: string;
  /** 初始任务（追加为 user 消息），或直接传入完整 messages。 */
  task?: string;
  /** 初始任务附带的多模态内容块（如上传的图片附件），随 task 组成同一条 user 消息。 */
  taskContentBlocks?: ToolContentBlock[];
  messages?: Msg[];
  ctx: ToolContext;
  /** 流式事件回调（供 SSE 推前端 / 日志）。 */
  onEvent?: (e: StreamEvent) => void;
  /** 当前运行中插入的新消息；在模型轮次边界被合并到上下文。 */
  drainPendingMessages?: () => Msg[] | Promise<Msg[]>;
  /**
   * 步数上限；缺省**不限**——交互场景由终止接口 / 断连中止兜底，
   * 无人值守调用方（定时任务等）应显式设置，防止工具循环失控无人能停。
   */
  maxSteps?: number;
  /**
   * 发送给模型前把历史压缩到该 token 预算内（避免超出模型上下文窗口报 400）。
   * 未设或 <=0 则不压缩。仅影响发出的请求，完整历史仍用于持久化 / 返回。
   */
  contextBudgetTokens?: number;
  /** 硬裁剪 / 摘要压缩时保留图片的最近带图消息条数，默认 1。 */
  keepImages?: number;
  /**
   * 中途摘要压缩：历史超过 compactionTriggerTokens 时在轮次边界调用，把较早的消息摘要成一段文本。
   * 压缩会改写 result.messages（调用方应整体替换持久化，见 result.compacted）；摘要失败不阻断，硬裁剪仍兜底。
   */
  summarize?: (stale: Msg[]) => Promise<string>;
  /** 触发摘要压缩的 token 阈值（通常 = contextBudgetTokens × 0.85）；未设则不摘要。 */
  compactionTriggerTokens?: number;
  /** 摘要压缩时保留原样的最近消息条数，默认 8。 */
  compactionKeepRecent?: number;
  /**
   * 无效压缩水位：历史 token 不超过该值时跳过摘要（上次压缩后仍高于触发线，
   * 说明最近几条本身就很大，历史没涨够就重试只会白跑摘要模型调用）。
   */
  compactionWatermarkTokens?: number;
  /** 模型重试退避的基准间隔（指数退避 base × 2^n，上限 30s）；默认 1s，测试可设 0。 */
  modelRetryDelayMs?: number;
  /** needApproval 时的审批门；缺省则直接拒绝。 */
  approval?: ApprovalGate;
  /**
   * 注入模型前对工具定义做过滤（如权限规则剥离被无条件 deny 的工具）；缺省用全部已注册工具。
   * 只影响模型可见的工具集，dispatch 时仍以 tools 注册表为准。
   */
  filterToolDefs?: (defs: ToolDef[]) => ToolDef[];
  /** PreToolUse 钩子：策略放行后、dispatch 前执行，可拒绝调用。 */
  hooks?: HookRunner;
  /** ask_user 工具的提问回调：暂停运行、推问题、等回答（HTTP 层实现交互式；缺省则工具不可用）。 */
  askUser?: (questions: QuestionSpec[]) => Promise<QuestionAnswers | null>;
  /** submit_change_plan 工具的审批回调：推送变更方案、等用户批准。 */
  requestPlanApproval?: (plan: ChangePlan) => Promise<boolean>;
  /** 无人值守运行（定时任务）：系统提示改为“确认类操作跳过并汇报”，避免对着空气等确认。 */
  unattended?: boolean;
  /** 当前运行的取消信号；由 HTTP 终止会话或客户端断开触发。 */
  signal?: AbortSignal;
}

export interface RunAgentResult {
  messages: Msg[];
  text: string; // 最后一轮 assistant 文本
  steps: number;
  /** 跨所有轮次累计的 token 用量（adapter 提供 usage 事件时才非零）。 */
  usage: Usage;
  /** 运行期间发生过摘要压缩：messages 已被改写，调用方应整体替换持久化而非增量追加。 */
  compacted: boolean;
}

/** 无效压缩后需再涨多少 token 才重试摘要（吸收估算抖动，避免每轮白跑摘要调用）。 */
export const COMPACTION_RETRY_GROWTH_TOKENS = 4000;

/**
 * Agentic loop：模型 → 收集 text/tool_call → Policy 校验 → dispatch → 回填 → 直到无工具调用。
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const messages: Msg[] = opts.messages ? [...opts.messages] : [];
  if (opts.task || opts.taskContentBlocks?.length) {
    messages.push({
      role: 'user',
      text: opts.task,
      contentBlocks: opts.taskContentBlocks?.length ? opts.taskContentBlocks : undefined,
    });
  }

  const system = buildSystemPrompt(opts.system, opts.unattended);
  const maxSteps = opts.maxSteps ?? Infinity;
  let lastText = '';
  let steps = 0;
  let compacted = false;
  let compactionWatermark = opts.compactionWatermarkTokens ?? 0;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  while (steps < maxSteps) {
    throwIfAborted(opts.signal);
    if (steps > 0) {
      await drainPendingMessages(messages, opts);
      throwIfAborted(opts.signal);
    }
    // 摘要压缩检查点：每个轮次边界都查（含首轮——新任务及附件体积一并计入触发判断），
    // 长 run 中途历史膨胀也能压缩，而不是只靠硬裁剪无摘要地丢弃。
    if (await maybeCompact(messages, compactionWatermark, opts)) {
      compacted = true;
      const afterTokens = estimateTokens(messages);
      // 摘要后仍高于触发线（最近几条本身就很大）：记水位，历史没涨够前不重复摘要。
      compactionWatermark = afterTokens > (opts.compactionTriggerTokens ?? 0)
        ? afterTokens + COMPACTION_RETRY_GROWTH_TOKENS
        : 0;
    }
    throwIfAborted(opts.signal);
    steps++;
    const turn = await runModelTurn({
      model: opts.model,
      system,
      messages,
      toolDefs: opts.tools.defs(),
      filterToolDefs: opts.filterToolDefs,
      contextBudgetTokens: opts.contextBudgetTokens,
      keepImages: opts.keepImages,
      modelRetryDelayMs: opts.modelRetryDelayMs,
      signal: opts.signal,
      onEvent: opts.onEvent,
    });
    const { text, thinking, calls, thinkingBlocks } = turn;
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.cacheReadTokens += turn.usage.cacheReadTokens;
    usage.cacheCreationTokens += turn.usage.cacheCreationTokens;
    throwIfAborted(opts.signal);

    lastText = text;
    messages.push({
      role: 'assistant',
      text,
      thinking: thinking || undefined,
      thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined,
      toolCalls: calls.length ? calls : undefined,
    });

    if (calls.length === 0) {
      const hadPending = await drainPendingMessages(messages, opts);
      if (hadPending) continue;
      break;
    }
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

  return { messages, text: lastText, steps, usage, compacted };
}

/**
 * 轮次边界的摘要压缩：历史超过触发线（且超过无效压缩水位）时，把较早的消息摘要成一段并原地改写 messages。
 * 成功返回 true 并发 context_compacted 事件；摘要失败/为空返回 false，硬裁剪仍兜底。
 */
async function maybeCompact(messages: Msg[], watermark: number, opts: RunAgentOptions): Promise<boolean> {
  if (!opts.summarize || !opts.compactionTriggerTokens) return false;
  const beforeTokens = estimateTokens(messages);
  if (beforeTokens <= opts.compactionTriggerTokens || beforeTokens <= watermark) return false;
  const { stale, recent } = planCompaction(messages, opts.compactionKeepRecent ?? 8);
  if (!stale.length) return false;
  try {
    const summary = (await opts.summarize(stale)).trim();
    throwIfAborted(opts.signal);
    if (!summary) return false;
    // 用户输入永不吞掉：摘要只替代 assistant/tool 轮次，用户消息按原顺序保留在摘要之前
    // （历史上一轮的摘要消息除外——其内容已并入新摘要）。发送时仍受硬预算截断兜底。
    const keptUserInputs = stale.filter(isUserInputMsg);
    // 同步剥离 recent 里较旧的图片：残留大图会让历史始终高于触发线，每轮白跑一次摘要。
    const next = compactMessages([...keptUserInputs, summaryMessage(summary), ...recent], 0, opts.keepImages ?? 1);
    messages.splice(0, messages.length, ...next);
    opts.onEvent?.({
      type: 'context_compacted',
      summarizedMessages: stale.length,
      beforeTokens,
      afterTokens: estimateTokens(messages),
    });
    return true;
  } catch {
    throwIfAborted(opts.signal);
    return false; // 摘要失败不阻断本轮
  }
}

async function drainPendingMessages(messages: Msg[], opts: RunAgentOptions): Promise<boolean> {
  const pending = await opts.drainPendingMessages?.();
  if (!pending?.length) return false;
  messages.push(...pending);
  return true;
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
  // PreToolUse 钩子：策略与审批都放行后、真正 dispatch 前执行；被拒绝则把原因回给模型。
  if (opts.hooks && !opts.hooks.empty) {
    const decision = await opts.hooks.preTool(call, opts.ctx);
    throwIfAborted(opts.signal);
    if (decision.denied) {
      return { id: call.id, content: `blocked by hook: ${decision.reason ?? 'denied'}`, isError: true };
    }
  }
  // 为每个工具调用派生独立 ctx，注入按 call.id 归集的实时输出回调，
  // 供沙箱 stdout/stderr 流式回传到前端（不污染共享 opts.ctx，避免并发串台）。
  const callCtx: ToolContext = opts.onEvent
    ? {
        ...opts.ctx,
        onOutput: ({ stream, text }) =>
          opts.onEvent?.({ type: 'tool_output', toolId: call.id, stream, text }),
        emitEvent: (e) => opts.onEvent?.(e),
        ...(opts.askUser ? { askUser: opts.askUser } : {}),
        ...(opts.requestPlanApproval ? { requestPlanApproval: opts.requestPlanApproval } : {}),
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
