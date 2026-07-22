import type { StreamEvent, ToolCall, ToolResult } from '../../model/types.js';
import type { ApprovalGate } from '../approval.js';
import type { HookRunner } from '../hooks.js';
import type { ChangePlan } from '../plan.js';
import type { PolicyMiddleware } from '../policy.js';
import type { QuestionAnswers, QuestionSpec } from '../question.js';
import type { ToolContext, ToolRegistry } from '../tools.js';
import type { DurableToolLedger } from '../tool-ledger/store.js';

export interface ToolBrokerOptions {
  tools: ToolRegistry;
  policy: PolicyMiddleware;
  ctx: ToolContext;
  approval?: ApprovalGate;
  approvalForCall?: (call: ToolCall, reason?: string) => Promise<boolean>;
  hooks?: HookRunner;
  toolLedger?: DurableToolLedger;
  runId?: string;
  askUser?: (questions: QuestionSpec[]) => Promise<QuestionAnswers | null>;
  askUserForCall?: (call: ToolCall, questions: QuestionSpec[]) => Promise<QuestionAnswers | null>;
  requestPlanApproval?: (plan: ChangePlan) => Promise<boolean>;
  requestPlanApprovalForCall?: (call: ToolCall, plan: ChangePlan) => Promise<boolean>;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
}

/** 并发执行同一模型轮次的工具调用，同时保持回填结果与模型 call 顺序一致。 */
export function executeToolCalls(calls: ToolCall[], options: ToolBrokerOptions): Promise<ToolResult[]> {
  return Promise.all(calls.map(async (call) => {
    const result = await executeToolCall(call, options);
    options.onEvent?.({
      type: 'tool_result',
      toolId: call.id,
      name: call.name,
      isError: Boolean(result.isError),
    });
    return result;
  }));
}

/** 执行单个工具调用，固定 Policy → Approval → Hook → dispatch 顺序。 */
export async function executeToolCall(call: ToolCall, options: ToolBrokerOptions): Promise<ToolResult> {
  throwIfAborted(options.signal);
  const policyDecision = await options.policy.check(call, options.ctx);
  throwIfAborted(options.signal);
  if (policyDecision.blocked) {
    return { id: call.id, content: `blocked by policy: ${policyDecision.reason ?? 'denied'}`, isError: true };
  }
  if (policyDecision.needApproval) {
    const approved = options.approvalForCall
      ? await options.approvalForCall(call, policyDecision.reason)
      : options.approval
        ? await options.approval.request({ call, reason: policyDecision.reason, ctx: options.ctx })
        : false;
    if (!approved) {
      return {
        id: call.id,
        content: `needs approval (denied): ${policyDecision.reason ?? '该操作需要审批后才能执行'}`,
        isError: true,
      };
    }
  }
  throwIfAborted(options.signal);
  if (options.hooks && !options.hooks.empty) {
    const hookDecision = await options.hooks.preTool(call, options.ctx);
    throwIfAborted(options.signal);
    if (hookDecision.denied) {
      return { id: call.id, content: `blocked by hook: ${hookDecision.reason ?? 'denied'}`, isError: true };
    }
  }
  const ledgerIdentity = options.toolLedger && options.runId
    && call.name !== 'ask_user' && call.name !== 'submit_change_plan'
    ? {
        tenantId: options.ctx.tenantId ?? 'default',
        runId: options.runId,
        sessionId: options.ctx.sessionId,
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
      }
    : undefined;
  if (ledgerIdentity) {
    const decision = await options.toolLedger!.begin(ledgerIdentity);
    if (decision.action === 'reuse') return decision.result;
  }
  const askUser = options.askUserForCall
    ? (questions: QuestionSpec[]) => options.askUserForCall!(call, questions)
    : options.askUser;
  const requestPlanApproval = options.requestPlanApprovalForCall
    ? (plan: ChangePlan) => options.requestPlanApprovalForCall!(call, plan)
    : options.requestPlanApproval;
  const callContext: ToolContext = {
    ...options.ctx,
    ...(options.onEvent ? {
      onOutput: ({ stream, text }) =>
        options.onEvent?.({ type: 'tool_output', toolId: call.id, stream, text }),
      emitEvent: (event) => options.onEvent?.(event),
    } : {}),
    ...(askUser ? { askUser } : {}),
    ...(requestPlanApproval ? { requestPlanApproval } : {}),
  };
  const result = await options.tools.dispatch(call, callContext);
  if (ledgerIdentity) await options.toolLedger!.complete(ledgerIdentity, result);
  throwIfAborted(options.signal);
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === 'string' && signal.reason ? signal.reason : '运行已终止');
}
