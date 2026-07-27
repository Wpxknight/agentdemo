import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type CompactionPreparation,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from '@earendil-works/pi-ai';
import type { AgentRunUsage, KernelMessage } from '@aiop/agent-contracts';

export interface ContextUsage {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
}

export interface CompactionPolicy {
  contextWindowTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
  enabled?: boolean;
}

export interface PreparedCompaction {
  tokensBefore: number;
  summarizedMessages: number;
  retainedMessages: KernelMessage[];
  handle: unknown;
}

export interface CompactedContext {
  summary: string;
  tokensBefore: number;
  usage?: AgentRunUsage;
  retainedMessages: KernelMessage[];
}

export interface ContextCompletionInput {
  system: string;
  messages: readonly KernelMessage[];
  sourceMessages: readonly KernelMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ContextCompletionResult {
  text: string;
  usage?: AgentRunUsage;
}

export interface PiContextManagerOptions {
  complete(input: ContextCompletionInput): Promise<ContextCompletionResult>;
}

export interface ContextManager {
  inspect(messages: readonly KernelMessage[]): Promise<ContextUsage>;
  shouldCompact(usage: ContextUsage, policy: CompactionPolicy): boolean;
  contextTokens(usage: AgentRunUsage): number;
  prepare(messages: readonly KernelMessage[], policy: CompactionPolicy): PreparedCompaction | undefined;
  compact(input: {
    prepared: PreparedCompaction;
    instructions?: string;
    signal?: AbortSignal;
  }): Promise<CompactedContext>;
}

export class PiContextManager implements ContextManager {
  constructor(private readonly options?: PiContextManagerOptions) {}

  async inspect(messages: readonly KernelMessage[]): Promise<ContextUsage> {
    const estimate = estimateContextTokens(toPiMessages(messages));
    return { tokens: estimate.tokens, usageTokens: estimate.usageTokens, trailingTokens: estimate.trailingTokens };
  }

  shouldCompact(usage: ContextUsage, policy: CompactionPolicy): boolean {
    return shouldCompact(usage.tokens, policy.contextWindowTokens, {
      enabled: policy.enabled ?? true,
      reserveTokens: policy.reserveTokens,
      keepRecentTokens: policy.keepRecentTokens,
    });
  }

  contextTokens(usage: AgentRunUsage): number {
    return calculateContextTokens(toPiUsage(usage));
  }

  prepare(messages: readonly KernelMessage[], policy: CompactionPolicy): PreparedCompaction | undefined {
    const entries: SessionTreeEntry[] = toPiMessages(messages).map((message, index) => ({
      type: 'message', id: `message-${index}`, parentId: index ? `message-${index - 1}` : null,
      timestamp: new Date(index).toISOString(), message,
    }));
    const prepared = prepareCompaction(entries, {
      enabled: policy.enabled ?? true,
      reserveTokens: policy.reserveTokens,
      keepRecentTokens: policy.keepRecentTokens,
    });
    if (!prepared.ok) throw prepared.error;
    if (!prepared.value) return undefined;
    return {
      tokensBefore: prepared.value.tokensBefore,
      summarizedMessages: prepared.value.messagesToSummarize.length + prepared.value.turnPrefixMessages.length,
      retainedMessages: fromPiMessages(prepared.value.retainedTail),
      handle: prepared.value,
    };
  }

  async compact(input: {
    prepared: PreparedCompaction;
    instructions?: string;
    signal?: AbortSignal;
  }): Promise<CompactedContext> {
    if (!this.options) throw new Error('Pi context completion is not configured');
    const preparation = input.prepared.handle as CompactionPreparation;
    const { models, model } = createCompactionModels(this.options, preparation);
    const result = await compact(
      preparation,
      models,
      model,
      input.instructions,
      input.signal,
    );
    if (!result.ok) throw result.error;
    return {
      summary: result.value.summary,
      tokensBefore: result.value.tokensBefore,
      usage: result.value.usage ? fromPiUsage(result.value.usage) : undefined,
      retainedMessages: fromPiMessages(result.value.retainedTail ?? []),
    };
  }
}

function createCompactionModels(options: PiContextManagerOptions, preparation: CompactionPreparation) {
  const model: Model<'aiop-context'> = {
    id: 'aiop-context',
    name: 'AIOP Context Summarizer',
    api: 'aiop-context',
    provider: 'aiop',
    baseUrl: 'injected://aiop-context',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Math.max(preparation.tokensBefore, preparation.settings.reserveTokens),
    maxTokens: preparation.settings.reserveTokens,
  };
  const sourceMessages = fromPiMessages([
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ]);
  const stream = (_model: Model<'aiop-context'>, context: Context, streamOptions?: SimpleStreamOptions) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const empty = (): AssistantMessage => ({
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: 'stop',
        timestamp: Date.now(),
      });
      output.push({ type: 'start', partial: empty() });
      try {
        const result = await options.complete({
          system: context.systemPrompt ?? '',
          messages: fromPiMessages(context.messages),
          sourceMessages,
          maxTokens: streamOptions?.maxTokens,
          signal: streamOptions?.signal,
        });
        const message: AssistantMessage = {
          ...empty(),
          content: [{ type: 'text', text: result.text }],
          usage: toPiUsage(result.usage ?? zeroUsage()),
        };
        output.push({ type: 'done', reason: 'stop', message });
      } catch (error) {
        const message: AssistantMessage = {
          ...empty(),
          stopReason: streamOptions?.signal?.aborted ? 'aborted' : 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        output.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message });
      }
    })();
    return output;
  };
  const provider = createProvider({
    id: 'aiop',
    auth: { apiKey: { name: 'Injected AIOP model', resolve: async () => ({ auth: { apiKey: 'injected' } }) } },
    models: [model],
    api: { stream, streamSimple: stream },
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

function zeroUsage(): AgentRunUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function toPiMessages(messages: readonly KernelMessage[]): AgentMessage[] {
  const names = new Map<string, string>();
  return messages.flatMap((message): AgentMessage[] => {
    if (message.role === 'user') {
      return [{
        role: 'user',
        content: message.content.map((block) => block.type === 'text'
          ? { type: 'text' as const, text: block.text }
          : { type: 'image' as const, data: block.data, mimeType: block.mimeType }),
        timestamp: Date.now(),
      }];
    }
    if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      for (const call of calls) names.set(call.id, call.name);
      return [{
        role: 'assistant',
        content: [
          ...message.content.flatMap((block) => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []),
          ...calls.map((call) => ({ type: 'toolCall' as const, id: call.id, name: call.name,
            arguments: call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
              ? call.arguments : { value: call.arguments } })),
        ],
        api: 'openai-completions', provider: 'aiop', model: 'persisted', usage: emptyUsage(),
        stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now(),
      }];
    }
    return message.results.map((result) => ({
      role: 'toolResult', toolCallId: result.callId, toolName: names.get(result.callId) ?? 'tool',
      content: [{ type: 'text', text: result.content }], isError: Boolean(result.isError), timestamp: Date.now(),
    }));
  });
}

function fromPiMessages(messages: readonly AgentMessage[]): KernelMessage[] {
  return messages.flatMap((message): KernelMessage[] => {
    if (message.role === 'user') {
      const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }]
        : message.content.map((block) => block.type === 'text'
          ? { type: 'text' as const, text: block.text }
          : { type: 'image' as const, data: block.data, mimeType: block.mimeType });
      return [{ role: 'user', content }];
    }
    if (message.role === 'assistant') {
      return [{
        role: 'assistant',
        content: message.content.flatMap((block) => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []),
        toolCalls: message.content.flatMap((block) => block.type === 'toolCall' ? [{
          id: block.id, logicalCallId: block.id, name: block.name, arguments: JSON.parse(JSON.stringify(block.arguments)),
        }] : []),
      }];
    }
    if (message.role === 'toolResult') {
      return [{ role: 'tool', results: [{
        callId: message.toolCallId,
        content: message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n'),
        isError: message.isError,
      }] }];
    }
    return [];
  });
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function toPiUsage(usage: AgentRunUsage): Usage {
  return { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheCreationTokens,
    totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.costUsd ?? 0 } };
}

function fromPiUsage(usage: Usage): AgentRunUsage {
  return { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead,
    cacheCreationTokens: usage.cacheWrite, costUsd: usage.cost.total };
}
