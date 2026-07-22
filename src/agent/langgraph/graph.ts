import { END, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { Msg } from '../../model/types.js';
import type { RunAgentOptions } from '../core.js';
import { COMPACTION_RETRY_GROWTH_TOKENS } from '../core.js';
import { estimateTokens } from '../context.js';
import { compactAtBoundary } from '../services/context-service.js';
import { runModelTurn } from '../services/model-gateway.js';
import { buildSystemPrompt } from '../services/prompt.js';
import { executeToolCalls } from '../services/tool-broker.js';
import { AgentGraphState, type AgentGraphStateValue } from './state.js';

export function createAgentGraph(options: RunAgentOptions, checkpointer?: BaseCheckpointSaver) {
  const system = buildSystemPrompt(options.system, options.unattended);
  const maxSteps = options.maxSteps ?? Infinity;

  const prepare = async (state: AgentGraphStateValue): Promise<Partial<AgentGraphStateValue>> => {
    throwIfAborted(options.signal);
    return { messages: [...state.messages] };
  };

  const model = async (state: AgentGraphStateValue): Promise<Partial<AgentGraphStateValue>> => {
    throwIfAborted(options.signal);
    const messages = [...state.messages];
    if (state.steps > 0) {
      await drainPendingMessages(messages, options);
      throwIfAborted(options.signal);
    }
    let compacted = state.compacted;
    let compactionWatermark = state.compactionWatermark;
    if (await compactAtBoundary(messages, compactionWatermark, {
      summarize: options.summarize,
      triggerTokens: options.compactionTriggerTokens,
      keepRecent: options.compactionKeepRecent,
      keepImages: options.keepImages,
      signal: options.signal,
      onEvent: options.onEvent,
    })) {
      compacted = true;
      const afterTokens = estimateTokens(messages);
      compactionWatermark = afterTokens > (options.compactionTriggerTokens ?? 0)
        ? afterTokens + COMPACTION_RETRY_GROWTH_TOKENS
        : 0;
    }
    const turn = await runModelTurn({
      model: options.model,
      system,
      messages,
      toolDefs: options.tools.defs(),
      filterToolDefs: options.filterToolDefs,
      contextBudgetTokens: options.contextBudgetTokens,
      keepImages: options.keepImages,
      modelRetryDelayMs: options.modelRetryDelayMs,
      signal: options.signal,
      onEvent: options.onEvent,
      guard: options.runGuard,
    });
    const steps = state.steps + 1;
    messages.push({
      role: 'assistant',
      text: turn.text,
      thinking: turn.thinking || undefined,
      thinkingBlocks: turn.thinkingBlocks.length ? turn.thinkingBlocks : undefined,
      toolCalls: turn.calls.length ? turn.calls : undefined,
    });
    let continueModel = false;
    if (!turn.calls.length) continueModel = await drainPendingMessages(messages, options);
    return {
      messages,
      text: turn.text,
      steps,
      usage: addUsage(state.usage, turn.usage),
      compacted,
      compactionWatermark,
      calls: turn.calls,
      continueModel,
    };
  };

  const tools = async (state: AgentGraphStateValue): Promise<Partial<AgentGraphStateValue>> => {
    throwIfAborted(options.signal);
    const results = await executeToolCalls(state.calls, {
      tools: options.tools,
      policy: options.policy,
      ctx: options.ctx,
      approval: options.approval,
      approvalForCall: options.durableInteractions
        ? async (call, reason) => {
            const interaction = await options.durableInteractions!.create({
              kind: 'approval',
              toolCallId: call.id,
              payload: { call, reason },
            });
            return interrupt({ interactionId: interaction.id, kind: 'approval' });
          }
        : undefined,
      hooks: options.hooks,
      toolLedger: options.toolLedger,
      runId: options.runId,
      askUser: options.askUser,
      askUserForCall: options.durableInteractions
        ? async (call, questions) => {
            const interaction = await options.durableInteractions!.create({
              kind: 'question',
              toolCallId: call.id,
              payload: { questions },
            });
            return interrupt({ interactionId: interaction.id, kind: 'question' });
          }
        : undefined,
      requestPlanApproval: options.requestPlanApproval,
      requestPlanApprovalForCall: options.durableInteractions
        ? async (call, plan) => {
            const interaction = await options.durableInteractions!.create({
              kind: 'plan',
              toolCallId: call.id,
              payload: { plan },
            });
            return interrupt({ interactionId: interaction.id, kind: 'plan' });
          }
        : undefined,
      signal: options.signal,
      onEvent: options.onEvent,
      guard: options.runGuard,
    });
    throwIfAborted(options.signal);
    return {
      messages: [...state.messages, { role: 'tool', toolResults: results }],
      calls: [],
      continueModel: state.steps < maxSteps,
    };
  };

  return new StateGraph(AgentGraphState)
    .addNode('prepare', observedNode('prepare', prepare, options))
    .addNode('model', observedNode('model', model, options))
    .addNode('tools', observedNode('tools', tools, options))
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'model')
    .addConditionalEdges('model', (state) => {
      if (state.calls.length) return 'tools';
      return state.continueModel && state.steps < maxSteps ? 'model' : END;
    })
    .addConditionalEdges('tools', (state) => state.continueModel ? 'model' : END)
    .compile({ checkpointer });
}

function observedNode(
  name: string,
  node: (state: AgentGraphStateValue) => Promise<Partial<AgentGraphStateValue>>,
  options: RunAgentOptions,
): (state: AgentGraphStateValue) => Promise<Partial<AgentGraphStateValue>> {
  return async (state) => {
    await options.runLifecycle?.nodeStarted(name);
    try {
      await options.runGuard?.();
      const result = await node(state);
      await options.runLifecycle?.nodeCompleted(name, {
        ...(typeof result.steps === 'number' ? { steps: result.steps } : {}),
      });
      return result;
    } catch (error) {
      await options.runLifecycle?.nodeFailed(name, error);
      throw error;
    }
  };
}

function addUsage(left: AgentGraphStateValue['usage'], right: AgentGraphStateValue['usage']): AgentGraphStateValue['usage'] {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
  };
}

async function drainPendingMessages(messages: Msg[], options: RunAgentOptions): Promise<boolean> {
  const pending = await options.drainPendingMessages?.();
  if (!pending?.length) return false;
  messages.push(...pending);
  return true;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === 'string' && signal.reason ? signal.reason : '运行已终止');
}
