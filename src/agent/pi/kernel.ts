import type {
  KernelEvent,
  KernelMessage,
  ModelConcurrencyController,
  ModelProvider,
} from '@aiop/agent-runtime-core';
import type { ToolRuntime } from '@aiop/control-contracts';
import { PiAgentKernel, PiContextManager } from '@aiop/agent-kernel-pi';
import { FifoModelConcurrencyController } from '@aiop/agent-runtime-core';
import type { Msg, StreamEvent, ToolDef } from '../../model/types.js';
import type { AgentKernel } from '../kernel.js';
import type { RunAgentOptions, RunAgentResult } from '../run-types.js';
import { AgentPlatformError } from '@aiop/control-contracts';
import { compactMessages, SUMMARY_PREFIX } from '../context.js';
import { buildSystemPrompt } from '../services/prompt.js';
import { createCompatibilityAIOPToolRuntime } from './tool-runtime.js';

export class PiAIOPAgentKernel implements AgentKernel {
  readonly name = 'pi' as const;

  constructor(
    private readonly modelConcurrency: ModelConcurrencyController = new FifoModelConcurrencyController(),
  ) {}

  async run(options: RunAgentOptions): Promise<RunAgentResult> {
    const kernel = createPiPlatformKernel(options, this.modelConcurrency);
    let compacted = false;
    let thinking = '';
    const messages = toPiKernelMessages(options.messages ?? [], options.task, options.taskContentBlocks);
    const exit = await kernel.run({
      runId: options.runId ?? `compat:${options.ctx.sessionId}`,
      attemptId: `compat:${Date.now()}`,
      turnNo: 1,
      identity: {
        tenantId: options.ctx.tenantId ?? 'default',
        actorId: options.ctx.userId ?? '',
        roles: [options.ctx.role ?? 'user'],
      },
      messages,
      model: { provider: 'aiop', model: options.model.id, contextWindowTokens: options.contextBudgetTokens },
      tools: piToolDefinitions(options),
      limits: { maxTurns: options.maxSteps },
      signal: options.signal,
    }, {
      emit: async (event) => {
        if (event.type === 'context_compacted') compacted = true;
        if (event.type === 'thinking_delta') thinking += event.text;
        emitPiCompatEvent(event, options.onEvent);
      },
      guard: options.runGuard ?? (async () => undefined),
      shouldStopAfterTurn: async () => false,
    });
    const resultMessages = fromPiKernelMessages(exit.messages);
    const finalAssistant = resultMessages.findLast((message) => message.role === 'assistant');
    if (finalAssistant && thinking) finalAssistant.thinking = thinking;
    if (exit.outcome === 'failed' || exit.outcome === 'recovery_required') {
      if (options.signal?.aborted && options.signal.reason instanceof Error) throw options.signal.reason;
      throw new AgentPlatformError(exit.error ?? {
        code: exit.outcome === 'recovery_required' ? 'TOOL_RESULT_UNKNOWN' : 'MODEL_PROVIDER_ERROR',
        message: `Agent run ${exit.outcome}`,
        retryable: false,
      });
    }
    return {
      messages: resultMessages,
      text: lastAssistantText(exit.messages) ?? '',
      steps: exit.messages.filter((message) => message.role === 'assistant').length,
      usage: exit.usage,
      compacted,
    };
  }
}

export function createPiPlatformKernel(
  options: RunAgentOptions,
  modelConcurrency?: ModelConcurrencyController,
  durableToolRuntime?: ToolRuntime,
): PiAgentKernel {
  const modelProvider: ModelProvider = {
    stream: (input) => adaptModel(options, input.system, input.messages, input.tools, input.signal),
  };
  const toolRuntime: ToolRuntime = durableToolRuntime ?? createCompatibilityAIOPToolRuntime(options);
  const context = options.summarize && options.compactionTriggerTokens ? {
    manager: new PiContextManager({
      complete: async ({ sourceMessages }) => ({
        text: await options.summarize!(fromPiKernelMessages(sourceMessages)),
      }),
    }),
    triggerTokens: options.compactionTriggerTokens,
    keepRecentMessages: options.compactionKeepRecent ?? 8,
    watermarkTokens: options.compactionWatermarkTokens,
    summaryPrefix: SUMMARY_PREFIX,
  } : undefined;
  return new PiAgentKernel({
    modelProvider,
    modelConcurrency,
    toolRuntime,
    systemPrompt: buildSystemPrompt(options.system, options.unattended),
    context,
    getFollowUpMessages: options.drainPendingMessages
      ? async () => toPiKernelMessages(await options.drainPendingMessages!())
      : undefined,
    transformContext: options.contextBudgetTokens
      ? async (messages) => {
          const productMessages = fromPiKernelMessages(messages);
          const summaryIndex = productMessages.findLastIndex((message) => message.text?.startsWith(SUMMARY_PREFIX));
          const executionMessages = summaryIndex < 0 ? productMessages : productMessages.slice(summaryIndex);
          return toPiKernelMessages(compactMessages(
            executionMessages, options.contextBudgetTokens!, options.keepImages,
          ));
        }
      : undefined,
  });
}

export function piToolDefinitions(options: RunAgentOptions) {
  const defs = options.filterToolDefs?.(options.tools.defs()) ?? options.tools.defs();
  return defs.map((tool) => ({
    ...tool,
    capability: tool.capability ?? 'non_idempotent_write',
  }));
}

async function* adaptModel(
  options: RunAgentOptions,
  system: string,
  messages: readonly KernelMessage[],
  tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[],
  signal?: AbortSignal,
): AsyncIterable<import('@aiop/agent-runtime-core').ModelStreamEvent> {
  for await (const event of options.model.stream({
    system,
    messages: fromPiKernelMessages(messages),
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    signal,
  })) {
    if (event.type === 'text_delta' || event.type === 'thinking_delta') yield event;
    else if (event.type === 'tool_call') {
      yield { type: 'tool_call', call: {
        id: event.call.id, logicalCallId: event.call.id, name: event.call.name, arguments: event.call.args,
      } };
    } else if (event.type === 'usage') {
      yield { type: 'usage', usage: {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens ?? 0,
        cacheCreationTokens: event.cacheCreationTokens ?? 0,
      } };
    } else if (event.type === 'stop') yield { type: 'stop', reason: event.reason };
  }
}

export function toPiKernelMessages(
  messages: readonly Msg[], task?: string, taskBlocks?: RunAgentOptions['taskContentBlocks'],
): KernelMessage[] {
  const output: KernelMessage[] = messages.flatMap((message): KernelMessage[] => {
    if (message.role === 'user') return [{ role: 'user', content: [
      ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
      ...(message.contentBlocks ?? []).map((block) => block.type === 'text'
        ? { type: 'text' as const, text: block.text }
        : { type: 'image' as const, data: block.data, mimeType: block.mimeType }),
    ] }];
    if (message.role === 'assistant') return [{
      role: 'assistant',
      content: message.text ? [{ type: 'text', text: message.text }] : [],
      thinking: message.thinking,
      toolCalls: message.toolCalls?.map((call) => ({
        id: call.id, logicalCallId: call.id, name: call.name, arguments: call.args,
      })),
    }];
    return [{ role: 'tool', results: (message.toolResults ?? []).map((result) => ({
      callId: result.id, content: result.content, isError: result.isError,
    })) }];
  });
  if (task || taskBlocks?.length) output.push({ role: 'user', content: [
    ...(task ? [{ type: 'text' as const, text: task }] : []),
    ...(taskBlocks ?? []).map((block) => block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : { type: 'image' as const, data: block.data, mimeType: block.mimeType }),
  ] });
  return output;
}

export function fromPiKernelMessages(messages: readonly KernelMessage[]): Msg[] {
  return messages.map((message): Msg => {
    if (message.role === 'user') return {
      role: 'user',
      text: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      contentBlocks: message.content.flatMap((block) => block.type === 'image' ? [block] : []),
    };
    if (message.role === 'assistant') return {
      role: 'assistant',
      text: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      thinking: message.thinking,
      toolCalls: message.toolCalls?.map((call) => ({ id: call.id, name: call.name, args: call.arguments })),
    };
    return {
      role: 'tool',
      toolResults: message.results.map((result) => ({ id: result.callId, content: result.content, isError: result.isError })),
    };
  });
}

export function emitPiCompatEvent(event: KernelEvent, sink?: (event: StreamEvent) => void): void {
  if (!sink) return;
  if (event.type === 'text_delta' || event.type === 'thinking_delta') sink(event);
  else if (event.type === 'context_compacted') sink({
    type: 'context_compacted',
    summarizedMessages: event.summarizedMessages,
    beforeTokens: event.tokensBefore,
    afterTokens: event.tokensAfter,
  });
  else if (event.type === 'tool_call') sink({
    type: 'tool_call', call: { id: event.call.id, name: event.call.name, args: event.call.arguments },
  });
  else if (event.type === 'tool_result') sink({
    type: 'tool_result', toolId: event.result.callId, name: '', isError: Boolean(event.result.isError),
  });
  else if (event.type === 'usage') sink({ type: 'usage',
    inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens,
    cacheReadTokens: event.usage.cacheReadTokens, cacheCreationTokens: event.usage.cacheCreationTokens });
}

function lastAssistantText(messages: readonly KernelMessage[]): string | undefined {
  const message = [...messages].reverse().find((item) => item.role === 'assistant');
  if (!message || message.role !== 'assistant') return undefined;
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}
