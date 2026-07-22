import { END, START, StateGraph } from '@langchain/langgraph';
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
      hooks: options.hooks,
      askUser: options.askUser,
      requestPlanApproval: options.requestPlanApproval,
      signal: options.signal,
      onEvent: options.onEvent,
    });
    throwIfAborted(options.signal);
    return {
      messages: [...state.messages, { role: 'tool', toolResults: results }],
      calls: [],
      continueModel: state.steps < maxSteps,
    };
  };

  return new StateGraph(AgentGraphState)
    .addNode('prepare', prepare)
    .addNode('model', model)
    .addNode('tools', tools)
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'model')
    .addConditionalEdges('model', (state) => {
      if (state.calls.length) return 'tools';
      return state.continueModel && state.steps < maxSteps ? 'model' : END;
    })
    .addConditionalEdges('tools', (state) => state.continueModel ? 'model' : END)
    .compile({ checkpointer });
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
