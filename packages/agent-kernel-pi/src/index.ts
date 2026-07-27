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
  type AgentKernel,
  type AgentRunUsage,
  type JsonValue,
  type KernelControl,
  type KernelExit,
  type KernelMessage,
  type KernelRunInput,
  type ModelProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolRuntime,
  type WaitingReason,
} from '@aiop/agent-contracts';

const EMPTY_PI_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface PiAgentKernelOptions {
  modelProvider: ModelProvider;
  toolRuntime: ToolRuntime;
  systemPrompt?: string;
  protocolVersion?: string;
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
    let lastAssistant: AssistantMessage | undefined;
    const usage: AgentRunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const tools = this.createTools(input, () => waitingReason, (reason) => { waitingReason = reason; });
    const context: AgentContext = {
      systemPrompt: this.options.systemPrompt ?? '',
      messages: input.continuation ? toPiMessages(input.messages) : [],
      tools,
    };
    const config: AgentLoopConfig = {
      model: toPiModel(input),
      convertToLlm: (messages) => messages as Message[],
      toolExecution: 'sequential',
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
          messages: fromPiMessages(input.continuation ? [...toPiMessages(input.messages), ...newMessages] : newMessages),
          waitingReason,
        };
        return message.stopReason === 'length' || Boolean(waitingReason) || await control.shouldStopAfterTurn(turn);
      },
    };
    const streamFn = this.createStreamFn(input, logicalCalls);
    const stream = input.continuation
      ? agentLoopContinue(context, config, input.signal, streamFn)
      : agentLoop(toPiMessages(input.messages), context, config, input.signal, streamFn);
    let returned: AgentMessage[] = [];
    for await (const event of stream) await this.forwardEvent(event, input, logicalCalls, control);
    returned = await stream.result();
    const allMessages = input.continuation ? [...toPiMessages(input.messages), ...returned] : returned;
    const messages = fromPiMessages(allMessages);
    lastAssistant ??= [...allMessages].reverse().find((message): message is AssistantMessage => message.role === 'assistant');
    const stopReason = lastAssistant?.stopReason;
    const outcome = waitingReason ? 'waiting'
      : stopReason === 'error' || stopReason === 'aborted' ? 'failed' : 'completed';
    return { outcome, turnNo: input.turnNo, stopReason, usage, messages, waitingReason };
  }

  private createTools(
    input: KernelRunInput,
    waiting: () => WaitingReason | undefined,
    setWaiting: (reason: WaitingReason) => void,
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
          logicalCallId: toolCallId,
          name: definition.name,
          arguments: toJsonValue(params),
        }, {
          identity: input.identity,
          runId: input.runId,
          attemptId: input.attemptId,
          turnNo: input.turnNo,
          signal,
        });
        if (outcome.kind === 'recovery_required') {
          throw new AgentPlatformError({ code: 'TOOL_RESULT_UNKNOWN', message: outcome.message, retryable: false });
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
    try {
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
          messages: fromPiMessages([event.message, ...event.toolResults]),
        },
      });
    }
    await control.guard();
  }
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

function toPiMessages(messages: readonly KernelMessage[]): AgentMessage[] {
  const names = new Map<string, string>();
  const result: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: toPiContent(message.content), timestamp: Date.now() });
    } else if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = [
        ...message.content.flatMap((block): AssistantMessage['content'] => block.type === 'text'
          ? [{ type: 'text', text: block.text }]
          : []),
        ...(message.toolCalls ?? []).map((call) => {
          names.set(call.id, call.name);
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

function fromPiMessages(messages: readonly AgentMessage[]): KernelMessage[] {
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
        toolCalls: message.content.flatMap((block): ToolCall[] => block.type === 'toolCall' ? [{
          id: block.id, logicalCallId: block.id, name: block.name, arguments: toJsonValue(block.arguments),
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
