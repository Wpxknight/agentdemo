import type { ChatModel, Msg, StreamEvent, ToolCall, ToolContentBlock, ToolDef, ToolResult } from '../model/types.js';
import { compactMessages, estimateTokens, isUserInputMsg, planCompaction, summaryMessage } from './context.js';
import type { PolicyMiddleware } from './policy.js';
import type { ToolContext, ToolRegistry } from './tools.js';
import type { ApprovalGate } from './approval.js';
import type { HookRunner } from './hooks.js';
import type { QuestionAnswers, QuestionSpec } from './question.js';
import type { ChangePlan } from './plan.js';

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

/** 一次运行累计的 token 用量（跨多轮）。 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** 缓存读取的输入 token（含在 inputTokens 内，单列供成本折算）。 */
  cacheReadTokens: number;
  /** 缓存写入的输入 token（含在 inputTokens 内，单列供成本折算）。 */
  cacheCreationTokens: number;
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

/** 模型调用失败（网络异常 / 上游报错）的最大重试次数（不含首次尝试）。 */
export const MAX_MODEL_RETRIES = 10;

/** 指数退避：base × 2^attempt，上限 30s；base 缺省 1s，测试可设 0。 */
function retryDelayMs(attempt: number, baseMs?: number): number {
  const base = baseMs ?? 1000;
  return Math.min(base * 2 ** attempt, 30_000);
}

/**
 * 确定性客户端错误重试无意义（无效请求 / 鉴权失败 / 超窗等），快速失败；
 * 网络异常（无 status）、408/429、5xx 都重试。
 */
function isNonRetryableModelError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export const CHAT_SYSTEM_GUARDRAILS = [
  '聊天执行规则：',
  '1. 默认中文回复，结论清晰，过程可追溯，不编造结果。',
  '2. 只读检查、信息整理、生成草稿、编写计划或不影响现有系统状态的纯新增内容，可直接执行，尽量减少不必要的用户确认。',
  '3. 互不依赖的多个操作尽量在同一轮并行发起多个工具调用（如同时查询多个资源、并行执行多条只读命令）；有先后依赖的操作（如浏览器先点击再输入）才逐步执行。',
  '4. 多步骤任务（约 3 步以上）先用 todo_write 列出完整执行计划，再逐步执行；每一步开始前置为 in_progress、完成后置 completed，全程保持清单与实际进度一致。以这份待办清单作为任务规划与进度的唯一依据，不要只靠逐个工具调用来体现进度。',
  '5. 涉及修改现有系统状态、破坏、删除、重启、部署、修复、扩缩容、写配置、生产变更、凭据暴露、费用明显增加或其他不可逆/高风险操作时，必须先向用户确认。',
  '6. 变更确认格式：',
  '',
  '### 待确认变更',
  '- 操作内容：',
  '- 操作目的：',
  '- 影响范围：',
  '- 风险点：',
  '- 验证方式：',
  '',
  '请确认是否执行。',
  '',
  '7. 用户明确同意后才可执行高风险或不可逆变更；执行后必须验证结果。',
  '8. 任务结束必须用 Markdown 格式汇报；尽量简洁，不写长段铺垫。纯知识问答或一句话能说清的简单问题直接回答，不必套用模板。其余按任务类型选择一组模板，任务事项用表格形式展示；模板都不适用时自拟简洁表格：',
  '',
  '### 执行汇报：修复型任务',
  '| 事项 | 状态 | 说明 |',
  '|---|---|---|',
  '| 问题根因 | 一句话说明根因 | 不确定就写“未定位” |',
  '| 解决办法 | 说明已采取的修复动作 | 只列关键动作 |',
  '| 执行结果 | 说明验证结果 | 写清是否恢复/是否通过 |',
  '| 后续建议 | 无/建议 | 一句话建议 |',
  '',
  '### 执行汇报：巡检/网络检查类任务',
  '| 事项 | 说明 |',
  '|---|---|',
  '| 执行结果 | 列关键检查结果，正常/异常要明确 |',
  '| 后续建议 | 无则写“无”；有则一句话列出 |',
  '',
  '### 执行汇报：信息查询类任务',
  '| 事项 | 说明 |',
  '|---|---|',
  '| 查询结果 | 直接给出查到的信息，条目多时用表格或列表列出 |',
  '| 补充说明 | 数据口径、未覆盖项或异常；无则写“无” |',
  '',
  '9. 异常与状态标记（前端会按标记以警示色渲染）：',
  '- 表格中的状态/结果类单元格，用符号开头标注级别：✅ 正常/成功、⚠️ 警告/降级/待确认、❌ 错误/失败/异常。例如「❌ 失败：连接超时」。',
  '- 表格之外的错误、异常结论用引用块加符号突出：「> ❌ 错误：xxx」；风险、警告用「> ⚠️ 警告：xxx」。',
  '- 正常内容不要滥用上述符号，只在确有异常/警告/状态结论时使用。',
].join('\n');

/** 无人值守（定时任务）附加规则：没有用户在线，确认类流程全部改为跳过 + 汇报。 */
export const UNATTENDED_SYSTEM_GUARDRAILS = [
  '无人值守运行说明（本次为定时任务自动执行，没有用户在线）：',
  '1. 无法向用户确认：凡上述规则中需要用户确认的操作，一律视为不可执行——直接跳过，不要输出“待确认变更”等待回复。',
  '2. 需要审批的工具调用会被自动拒绝；收到拒绝后不要反复重试同一操作，记录原因并继续其余步骤。',
  '3. 最终汇报中把被跳过或被拒绝的操作单独列为“需人工处理”。',
].join('\n');

function buildSystemPrompt(system?: string, unattended?: boolean): string {
  return [CHAT_SYSTEM_GUARDRAILS, unattended ? UNATTENDED_SYSTEM_GUARDRAILS : '', system?.trim()]
    .filter(Boolean)
    .join('\n\n');
}

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
    let text = '';
    let thinking = '';
    let calls: ToolCall[] = [];
    let thinkingBlocks: { thinking: string; signature: string }[] = [];

    // 模型调用：网络异常 / 上游报错（含中途断流）最多重试 MAX_MODEL_RETRIES 次，指数退避。
    // 中途断流的重试会整轮重放：重置累计值并通过 model_retry 事件告知前端回滚已展示的部分输出。
    for (let attempt = 0; ; attempt++) {
      text = '';
      thinking = '';
      calls = [];
      thinkingBlocks = [];
      try {
        const sendMessages = opts.contextBudgetTokens
          ? compactMessages(messages, opts.contextBudgetTokens, opts.keepImages ?? 1)
          : messages;
        const toolDefs = opts.filterToolDefs ? opts.filterToolDefs(opts.tools.defs()) : opts.tools.defs();
        for await (const ev of opts.model.stream({
          system,
          messages: sendMessages,
          tools: toolDefs,
          signal: opts.signal,
        })) {
          throwIfAborted(opts.signal);
          opts.onEvent?.(ev);
          if (ev.type === 'thinking_delta') thinking += ev.text;
          else if (ev.type === 'thinking_block') thinkingBlocks.push({ thinking: ev.thinking, signature: ev.signature });
          else if (ev.type === 'text_delta') text += ev.text;
          else if (ev.type === 'tool_call') calls.push(ev.call);
          else if (ev.type === 'usage') {
            // 失败尝试消耗的上游 token 是真实开销，保留累计不回滚。
            usage.inputTokens += ev.inputTokens;
            usage.outputTokens += ev.outputTokens;
            usage.cacheReadTokens += ev.cacheReadTokens ?? 0;
            usage.cacheCreationTokens += ev.cacheCreationTokens ?? 0;
          }
        }
        break;
      } catch (err) {
        throwIfAborted(opts.signal);
        if (attempt >= MAX_MODEL_RETRIES || isNonRetryableModelError(err)) throw err;
        opts.onEvent?.({
          type: 'model_retry',
          attempt: attempt + 1,
          maxAttempts: MAX_MODEL_RETRIES,
          error: errorMessage(err),
          discardTextChars: text.length,
          discardThinkingChars: thinking.length,
          discardToolIds: calls.map((c) => c.id),
        });
        await sleep(retryDelayMs(attempt, opts.modelRetryDelayMs), opts.signal);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('运行已终止'));
    }, { once: true });
  });
}
