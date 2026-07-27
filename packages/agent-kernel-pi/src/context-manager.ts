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
import type { Model, Models, Usage } from '@earendil-works/pi-ai';
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
  retainedMessages: KernelMessage[];
  handle: unknown;
}

export interface CompactedContext {
  summary: string;
  tokensBefore: number;
  usage?: AgentRunUsage;
  retainedMessages: KernelMessage[];
}

export class PiContextManager {
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
      retainedMessages: fromPiMessages(prepared.value.retainedTail),
      handle: prepared.value,
    };
  }

  async compact(input: {
    prepared: PreparedCompaction;
    models: unknown;
    model: unknown;
    instructions?: string;
    signal?: AbortSignal;
  }): Promise<CompactedContext> {
    const result = await compact(
      input.prepared.handle as CompactionPreparation,
      input.models as Models,
      input.model as Model<any>,
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
