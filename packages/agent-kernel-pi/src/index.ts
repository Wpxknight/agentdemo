import {
  agentLoop,
  agentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from '@earendil-works/pi-ai';
import {
  AgentPlatformError,
  type AgentContentBlock,
  type AgentRunUsage,
  type DurableInteractionUpdate,
  type DurableToolLedgerUpdate,
  type JsonValue,
  type ToolCall,
  type ToolDefinition,
  type ToolRuntime,
  type WaitingReason,
} from '@aiop/control-contracts';
import type {
  AgentKernel,
  KernelControl,
  KernelExit,
  KernelMessage,
  KernelRunInput,
  ModelConcurrencyController,
  ModelProvider,
} from '@aiop/agent-runtime-core';
import type { CompactionPolicy, ContextManager } from './context-manager.js';

export * from './context-manager.js';

const EMPTY_PI_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface PiAgentKernelOptions {
  modelProvider: ModelProvider;
  modelConcurrency?: ModelConcurrencyController;
  toolRuntime: ToolRuntime;
  systemPrompt?: string;
  protocolVersion?: string;
  getFollowUpMessages?: () => Promise<readonly KernelMessage[]>;
  transformContext?: (messages: readonly KernelMessage[], signal?: AbortSignal) => Promise<readonly KernelMessage[]>;
  context?: {
    manager: ContextManager;
    triggerTokens: number;
    keepRecentMessages: number;
    watermarkTokens?: number;
    summaryPrefix?: string;
  };
}

export class PiAgentKernel implements AgentKernel {
  readonly descriptor = { name: 'pi' as const, version: '0.82.1', protocolVersion: '1' };

  constructor(private readonly options: PiAgentKernelOptions) {
    if (options.protocolVersion) this.descriptor.protocolVersion = options.protocolVersion;
  }

  async run(input: KernelRunInput, control: KernelControl): Promise<KernelExit> {
    await control.guard();
    const logicalCalls = new Map<string, string>();
    let waitingReason: WaitingReason | undefined;
    let recoveryRequired: { correlationId?: string; message: string } | undefined;
    const ledgerUpdates: DurableToolLedgerUpdate[] = [];
    const interactionUpdates: DurableInteractionUpdate[] = [];
    let lastAssistant: AssistantMessage | undefined;
    const usage: AgentRunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let runMessages = input.messages;
    if (input.interactionResolution) {
      const resolved = await this.resolveInteraction(
        input, runMessages, control, ledgerUpdates, interactionUpdates,
      );
      runMessages = resolved.messages;
      recoveryRequired = resolved.recoveryRequired;
      if (recoveryRequired) {
        return {
          outcome: 'recovery_required', turnNo: input.turnNo, usage, messages: runMessages,
          error: {
            code: 'TOOL_RESULT_UNKNOWN', message: recoveryRequired.message, retryable: false,
          },
          ledgerUpdates: ledgerUpdates.length ? ledgerUpdates : undefined,
          interactionUpdates: interactionUpdates.length ? interactionUpdates : undefined,
        };
      }
    }
    if (!input.interactionResolution) {
      runMessages = await this.compactContext({ ...input, messages: runMessages }, control, usage);
    }
    const tools = this.createTools(
      input,
      logicalCalls,
      () => waitingReason,
      (reason) => { waitingReason = reason; },
      (recovery) => { recoveryRequired = recovery; },
      ledgerUpdates,
      interactionUpdates,
    );
    const initialPiMessages = toPiMessages(runMessages, logicalCalls);
    const context: AgentContext = {
      systemPrompt: this.options.systemPrompt ?? '',
      messages: input.continuation ? initialPiMessages : [],
      tools,
    };
    const config: AgentLoopConfig = {
      model: toPiModel(input),
      convertToLlm: (messages) => messages as Message[],
      toolExecution: 'sequential',
      transformContext: this.options.transformContext
        ? async (messages, signal) => toPiMessages(
            await this.options.transformContext!(fromPiMessages(messages, logicalCalls), signal),
            logicalCalls,
          )
        : undefined,
      getFollowUpMessages: this.options.getFollowUpMessages
        ? async () => toPiMessages(await this.options.getFollowUpMessages!(), logicalCalls)
        : undefined,
      beforeToolCall: async ({ assistantMessage }) => {
        await control.guard();
        if (assistantMessage.stopReason === 'length') {
          return { block: true, reason: 'tool call blocked because model output was length-truncated' };
        }
        if (waitingReason) return { block: true, reason: 'turn is waiting for durable interaction' };
        return undefined;
      },
      shouldStopAfterTurn: async ({ message, toolResults, newMessages }) => {
        lastAssistant = message;
        addUsage(usage, message.usage);
        const turn = {
          turnNo: input.turnNo,
          stopReason: message.stopReason,
          usage: { ...usage },
          messages: fromPiMessages(input.continuation ? [...initialPiMessages, ...newMessages] : newMessages, logicalCalls),
          waitingReason,
        };
        return message.stopReason === 'length' || Boolean(waitingReason) || await control.shouldStopAfterTurn(turn);
      },
    };
    const streamFn = this.createStreamFn(input, logicalCalls);
    const stream = input.continuation
      ? agentLoopContinue(context, config, input.signal, streamFn)
      : agentLoop(initialPiMessages, context, config, input.signal, streamFn);
    let returned: AgentMessage[] = [];
    for await (const event of stream) await this.forwardEvent(event, input, logicalCalls, control);
    returned = await stream.result();
    const allMessages = input.continuation ? [...initialPiMessages, ...returned] : returned;
    const messages = fromPiMessages(allMessages, logicalCalls);
    lastAssistant ??= [...allMessages].reverse().find((message): message is AssistantMessage => message.role === 'assistant');
    const stopReason = lastAssistant?.stopReason;
    const outcome = recoveryRequired ? 'recovery_required'
      : waitingReason ? 'waiting'
      : stopReason === 'error' || stopReason === 'aborted' ? 'failed'
        : stopReason === 'toolUse' ? 'continue'
          : 'completed';
    const error = outcome === 'recovery_required' ? {
      code: 'TOOL_RESULT_UNKNOWN' as const,
      message: recoveryRequired?.message ?? 'Tool result requires recovery',
      retryable: false,
    } : outcome === 'failed' ? {
      code: 'MODEL_PROVIDER_ERROR' as const,
      message: lastAssistant?.errorMessage ?? 'Pi model turn failed',
      retryable: false,
    } : undefined;
    return {
      outcome, turnNo: input.turnNo, stopReason, usage, messages, waitingReason, error,
      ledgerUpdates: ledgerUpdates.length ? ledgerUpdates : undefined,
      interactionUpdates: interactionUpdates.length ? interactionUpdates : undefined,
    };
  }

  private async compactContext(
    input: KernelRunInput,
    control: KernelControl,
    usage: AgentRunUsage,
  ): Promise<readonly KernelMessage[]> {
    const context = this.options.context;
    if (!context || input.messages.length === 0) return input.messages;
    const summaryPrefix = context.summaryPrefix ?? 'Context summary:\n';
    const executionMessages = executionContextMessages(input.messages, summaryPrefix);
    const inspected = await context.manager.inspect(executionMessages);
    if (inspected.tokens <= (context.watermarkTokens ?? 0)) return input.messages;
    const recent = executionMessages.slice(-Math.max(1, context.keepRecentMessages));
    const recentUsage = await context.manager.inspect(recent);
    const reserveTokens = Math.max(256, Math.ceil(context.triggerTokens * 0.15));
    const policy: CompactionPolicy = {
      contextWindowTokens: context.triggerTokens + reserveTokens,
      reserveTokens,
      keepRecentTokens: Math.max(1, recentUsage.tokens),
    };
    if (!context.manager.shouldCompact(inspected, policy)) return input.messages;
    const prepared = context.manager.prepare(executionMessages, policy);
    if (!prepared || prepared.summarizedMessages === 0) return input.messages;
    try {
      const compacted = await context.manager.compact({ prepared, signal: input.signal });
      if (!compacted.summary.trim()) return input.messages;
      if (compacted.usage) addUsage(usage, toPiUsage(compacted.usage));
      const compactedMessages: KernelMessage[] = [{
        role: 'user',
        content: [{ type: 'text', text: `${summaryPrefix}${compacted.summary.trim()}` }],
      }, ...compacted.retainedMessages];
      const messages = preserveUserInputs(input.messages, compactedMessages, summaryPrefix);
      const after = await context.manager.inspect(compactedMessages);
      await control.emit({
        type: 'context_compacted',
        tokensBefore: compacted.tokensBefore,
        tokensAfter: after.tokens,
        summarizedMessages: prepared.summarizedMessages,
        version: 1,
      });
      return messages;
    } catch {
      await control.guard();
      return input.messages;
    }
  }

  private createTools(
    input: KernelRunInput,
    logicalCalls: Map<string, string>,
    waiting: () => WaitingReason | undefined,
    setWaiting: (reason: WaitingReason) => void,
    setRecovery: (recovery: { correlationId?: string; message: string }) => void,
    ledgerUpdates: DurableToolLedgerUpdate[],
    interactionUpdates: DurableInteractionUpdate[],
  ): AgentTool[] {
    return input.tools.map((definition) => ({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: Type.Unsafe(definition.inputSchema),
      executionMode: definition.capability === 'read' ? 'parallel' : 'sequential',
      execute: async (toolCallId, params, signal) => {
        if (waiting()) throw new Error('turn is already waiting');
        const outcome = await this.options.toolRuntime.execute({
          id: toolCallId,
          logicalCallId: logicalCalls.get(toolCallId) ?? toolCallId,
          name: definition.name,
          arguments: toJsonValue(params),
        }, {
          identity: input.identity,
          runId: input.runId,
          attemptId: input.attemptId,
          turnNo: input.turnNo,
          sessionId: input.sessionId,
          signal,
        });
        if (outcome.ledgerUpdates) ledgerUpdates.push(...outcome.ledgerUpdates);
        if (outcome.interactionUpdates) interactionUpdates.push(...outcome.interactionUpdates);
        if (outcome.kind === 'recovery_required') {
          setRecovery({ correlationId: outcome.correlationId, message: outcome.message });
          return {
            content: [{ type: 'text', text: 'recovery_required' }],
            details: outcome,
            terminate: true,
          };
        }
        if (outcome.kind === 'waiting') {
          setWaiting(outcome.reason);
          return {
            content: [{ type: 'text', text: `waiting:${outcome.interactionId}` }],
            details: outcome,
            terminate: true,
          };
        }
        return {
          content: [{ type: 'text', text: outcome.result.content }],
          details: outcome.result,
        };
      },
    }));
  }

  private async resolveInteraction(
    input: KernelRunInput,
    messages: readonly KernelMessage[],
    control: KernelControl,
    ledgerUpdates: DurableToolLedgerUpdate[],
    interactionUpdates: DurableInteractionUpdate[],
  ): Promise<{
    messages: readonly KernelMessage[];
    recoveryRequired?: { correlationId?: string; message: string };
  }> {
    const resolution = input.interactionResolution!;
    const calls = messages.flatMap((message) => message.role === 'assistant'
      ? (message.toolCalls ?? []).filter((call) => call.id === resolution.toolCallId)
      : []);
    if (calls.length !== 1) throw runStateConflict('Resolved interaction original tool call is missing or ambiguous');
    const call = calls[0]!;
    if (!input.tools.some((definition) => definition.name === call.name)) {
      throw runStateConflict('Resolved interaction tool definition is missing');
    }
    const waitingContent = `waiting:${resolution.interactionId}`;
    const waitingResults = messages.flatMap((message) => message.role === 'tool'
      ? message.results.filter((toolResult) => toolResult.callId === call.id)
      : []);
    if (waitingResults.length !== 1 || waitingResults[0]!.content !== waitingContent) {
      throw runStateConflict('Resolved interaction does not match the committed waiting result');
    }

    await control.emit({ type: 'tool_call', call });
    const outcome = await this.options.toolRuntime.execute(call, {
      identity: input.identity, runId: input.runId, attemptId: input.attemptId, turnNo: input.turnNo,
      sessionId: input.sessionId, interactionResolution: resolution, signal: input.signal,
    });
    if (outcome.ledgerUpdates) ledgerUpdates.push(...outcome.ledgerUpdates);
    if (outcome.interactionUpdates) interactionUpdates.push(...outcome.interactionUpdates);
    if (outcome.kind === 'waiting') {
      throw runStateConflict('Resolved interaction returned to waiting');
    }
    if (outcome.kind === 'recovery_required') {
      const replacement = { callId: call.id, content: 'recovery_required', isError: true };
      await control.emit({ type: 'tool_result', result: replacement });
      await control.guard();
      return {
        messages: replaceWaitingResult(messages, call.id, waitingContent, replacement),
        recoveryRequired: { correlationId: outcome.correlationId, message: outcome.message },
      };
    }
    if (outcome.result.callId !== call.id) {
      throw runStateConflict('Resolved interaction returned a result for a different tool call');
    }
    await control.emit({ type: 'tool_result', result: outcome.result });
    await control.guard();
    return { messages: replaceWaitingResult(messages, call.id, waitingContent, outcome.result) };
  }

  private createStreamFn(input: KernelRunInput, logicalCalls: Map<string, string>): StreamFn {
    return async (model, context) => {
      const stream = createAssistantMessageEventStream();
      void this.pumpModel(stream, model, context, input, logicalCalls);
      return stream;
    };
  }

  private async pumpModel(
    stream: AssistantMessageEventStream,
    model: Model<any>,
    context: Context,
    input: KernelRunInput,
    logicalCalls: Map<string, string>,
  ): Promise<void> {
    let content: AssistantMessage['content'] = [];
    let usage = { ...EMPTY_PI_USAGE, cost: { ...EMPTY_PI_USAGE.cost } };
    const partial = (): AssistantMessage => ({
      role: 'assistant', content: [...content], api: model.api, provider: model.provider, model: model.id,
      usage, stopReason: 'stop', timestamp: Date.now(),
    });
    stream.push({ type: 'start', partial: partial() });
    let releaseModel: () => void = () => undefined;
    try {
      releaseModel = await this.options.modelConcurrency?.acquire({
        identity: input.identity,
        model: input.model,
        signal: input.signal,
      }) ?? releaseModel;
      let reason = 'stop';
      for await (const event of this.options.modelProvider.stream({
        model: input.model,
        system: context.systemPrompt ?? '',
        messages: fromPiMessages(context.messages),
        tools: input.tools,
        signal: input.signal,
      })) {
        if (event.type === 'text_delta') {
          if (content.at(-1)?.type !== 'text') {
            content.push({ type: 'text', text: '' });
            stream.push({ type: 'text_start', contentIndex: content.length - 1, partial: partial() });
          }
          const block = content.at(-1);
          if (!block || block.type !== 'text') throw new Error('Pi text stream state is invalid');
          block.text += event.text;
          stream.push({ type: 'text_delta', contentIndex: content.length - 1, delta: event.text, partial: partial() });
        } else if (event.type === 'thinking_delta') {
          if (content.at(-1)?.type !== 'thinking') {
            content.push({ type: 'thinking', thinking: '' });
            stream.push({ type: 'thinking_start', contentIndex: content.length - 1, partial: partial() });
          }
          const block = content.at(-1);
          if (!block || block.type !== 'thinking') throw new Error('Pi thinking stream state is invalid');
          block.thinking += event.text;
          stream.push({ type: 'thinking_delta', contentIndex: content.length - 1, delta: event.text, partial: partial() });
        } else if (event.type === 'tool_call') {
          const call = event.call;
          logicalCalls.set(call.id, call.logicalCallId);
          const toolCall = { type: 'toolCall' as const, id: call.id, name: call.name, arguments: objectArguments(call.arguments) };
          content.push(toolCall);
          stream.push({ type: 'toolcall_start', contentIndex: content.length - 1, partial: partial() });
          stream.push({ type: 'toolcall_end', contentIndex: content.length - 1, toolCall, partial: partial() });
        } else if (event.type === 'usage') {
          usage = toPiUsage(event.usage);
        } else if (event.type === 'stop') {
          reason = event.reason;
        }
      }
      if (input.signal?.aborted) {
        throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Agent run aborted');
      }
      const stopReason = reason === 'length' ? 'length' : content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop';
      const message: AssistantMessage = { ...partial(), stopReason };
      stream.push({ type: 'done', reason: stopReason, message });
    } catch (error) {
      const failed: AssistantMessage = {
        ...partial(), stopReason: input.signal?.aborted ? 'aborted' : 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      const reason = input.signal?.aborted ? 'aborted' as const : 'error' as const;
      stream.push({ type: 'error', reason, error: failed });
    } finally {
      releaseModel();
    }
  }

  private async forwardEvent(
    event: AgentEvent,
    input: KernelRunInput,
    logicalCalls: Map<string, string>,
    control: KernelControl,
  ): Promise<void> {
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update.type === 'text_delta') await control.emit({ type: 'text_delta', text: update.delta });
      if (update.type === 'thinking_delta') await control.emit({ type: 'thinking_delta', text: update.delta });
    } else if (event.type === 'tool_execution_start') {
      await control.emit({
        type: 'tool_call',
        call: {
          id: event.toolCallId,
          logicalCallId: logicalCalls.get(event.toolCallId) ?? event.toolCallId,
          name: event.toolName,
          arguments: toJsonValue(event.args),
        },
      });
    } else if (event.type === 'tool_execution_end') {
      await control.emit({
        type: 'tool_result',
        result: {
          callId: event.toolCallId,
          content: piResultText(event.result),
          isError: event.isError,
        },
      });
    } else if (event.type === 'turn_end' && event.message.role === 'assistant') {
      const turnUsage = fromPiUsage(event.message.usage);
      await control.emit({ type: 'usage', usage: turnUsage });
      await control.emit({
        type: 'turn_end',
        result: {
          turnNo: input.turnNo,
          stopReason: event.message.stopReason,
          usage: turnUsage,
          messages: fromPiMessages([event.message, ...event.toolResults], logicalCalls),
        },
      });
    }
    await control.guard();
  }
}

function preserveUserInputs(
  original: readonly KernelMessage[],
  compacted: readonly KernelMessage[],
  summaryPrefix: string,
): KernelMessage[] {
  const retainedCounts = new Map<string, number>();
  for (const message of compacted) {
    if (message.role !== 'user') continue;
    const key = JSON.stringify(message.content);
    retainedCounts.set(key, (retainedCounts.get(key) ?? 0) + 1);
  }
  const missing: KernelMessage[] = [];
  for (const message of original) {
    if (message.role !== 'user' || userMessageText(message).startsWith(summaryPrefix)) continue;
    const key = JSON.stringify(message.content);
    const retained = retainedCounts.get(key) ?? 0;
    if (retained > 0) retainedCounts.set(key, retained - 1);
    else missing.push(message);
  }
  return [...missing, ...compacted];
}

function executionContextMessages(messages: readonly KernelMessage[], summaryPrefix: string): readonly KernelMessage[] {
  const summaryIndex = messages.findLastIndex(
    (message) => message.role === 'user' && userMessageText(message).startsWith(summaryPrefix),
  );
  return summaryIndex < 0 ? messages : messages.slice(summaryIndex);
}

function userMessageText(message: Extract<KernelMessage, { role: 'user' }>): string {
  return message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
}

function toPiModel(input: KernelRunInput): Model<any> {
  return {
    id: input.model.model,
    name: input.model.model,
    api: 'openai-completions',
    provider: input.model.provider,
    baseUrl: '',
    reasoning: Boolean(input.model.thinking),
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.model.contextWindowTokens ?? 128_000,
    maxTokens: input.limits?.maxOutputTokens ?? 8_192,
  } as Model<any>;
}

function toPiMessages(messages: readonly KernelMessage[], logicalCalls?: Map<string, string>): AgentMessage[] {
  const names = new Map<string, string>();
  const result: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: toPiContent(message.content), timestamp: Date.now() });
    } else if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = [
        ...(message.thinking ? [{ type: 'thinking' as const, thinking: message.thinking }] : []),
        ...message.content.flatMap((block): AssistantMessage['content'] => block.type === 'text'
          ? [{ type: 'text', text: block.text }]
          : []),
        ...(message.toolCalls ?? []).map((call) => {
          names.set(call.id, call.name);
          logicalCalls?.set(call.id, call.logicalCallId);
          return { type: 'toolCall' as const, id: call.id, name: call.name, arguments: objectArguments(call.arguments) };
        }),
      ];
      result.push({
        role: 'assistant', content, api: 'openai-completions', provider: 'aiop', model: 'persisted',
        usage: EMPTY_PI_USAGE, stopReason: message.toolCalls?.length ? 'toolUse' : 'stop', timestamp: Date.now(),
      });
    } else {
      for (const toolResult of message.results) {
        result.push({
          role: 'toolResult', toolCallId: toolResult.callId, toolName: names.get(toolResult.callId) ?? 'tool',
          content: [{ type: 'text', text: toolResult.content }], isError: Boolean(toolResult.isError), timestamp: Date.now(),
        });
      }
    }
  }
  return result;
}

function fromPiMessages(messages: readonly AgentMessage[], logicalCalls?: ReadonlyMap<string, string>): KernelMessage[] {
  const output: KernelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      output.push({ role: 'user', content: fromPiContent(message.content) });
    } else if (message.role === 'assistant') {
      output.push({
        role: 'assistant',
        content: message.content.flatMap((block): AgentContentBlock[] => block.type === 'text'
          ? [{ type: 'text', text: block.text }]
          : []),
        thinking: message.content.flatMap((block) => block.type === 'thinking' ? [block.thinking] : []).join('') || undefined,
        toolCalls: message.content.flatMap((block): ToolCall[] => block.type === 'toolCall' ? [{
          id: block.id, logicalCallId: logicalCalls?.get(block.id) ?? block.id,
          name: block.name, arguments: toJsonValue(block.arguments),
        }] : []),
      });
    } else if (message.role === 'toolResult') {
      const previous = output.at(-1);
      const result = { callId: message.toolCallId, content: piContentText(message.content), isError: message.isError };
      if (previous?.role === 'tool') previous.results = [...previous.results, result];
      else output.push({ role: 'tool', results: [result] });
    }
  }
  return output;
}

function toPiContent(content: readonly AgentContentBlock[]): UserMessage['content'] {
  return contentArray(content);
}

function contentArray(content: readonly AgentContentBlock[]): (TextContent | ImageContent)[] {
  return content.map((block) => block.type === 'text'
    ? { type: 'text' as const, text: block.text }
    : { type: 'image' as const, data: block.data, mimeType: block.mimeType });
}

function fromPiContent(content: UserMessage['content']): AgentContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const output: AgentContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') output.push({ type: 'text', text: block.text });
    else output.push({ type: 'image', data: block.data, mimeType: block.mimeType });
  }
  return output;
}

function addUsage(target: AgentRunUsage, usage: Usage): void {
  target.inputTokens += usage.input;
  target.outputTokens += usage.output;
  target.cacheReadTokens += usage.cacheRead;
  target.cacheCreationTokens += usage.cacheWrite;
  if (target.costUsd !== undefined || usage.cost.total !== 0) {
    target.costUsd = (target.costUsd ?? 0) + usage.cost.total;
  }
}

function toPiUsage(usage: AgentRunUsage): Usage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheCreationTokens,
    totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.costUsd ?? 0 },
  };
}

function fromPiUsage(usage: Usage): AgentRunUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheCreationTokens: usage.cacheWrite,
    costUsd: usage.cost.total,
  };
}

function objectArguments(value: JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function piContentText(content: ToolResultMessage['content']): string {
  return content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
}

function piResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const content = (result as { content?: ToolResultMessage['content'] }).content;
  return content ? piContentText(content) : JSON.stringify(result);
}

function replaceWaitingResult(
  messages: readonly KernelMessage[],
  callId: string,
  waitingContent: string,
  replacement: { callId: string; content: string; isError?: boolean },
): KernelMessage[] {
  return messages.map((message): KernelMessage => {
    if (message.role !== 'tool') return message;
    return {
      role: 'tool',
      results: message.results.map((toolResult) => toolResult.callId === callId && toolResult.content === waitingContent
        ? replacement
        : toolResult),
    };
  });
}

function runStateConflict(message: string): AgentPlatformError {
  return new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message, retryable: false });
}
