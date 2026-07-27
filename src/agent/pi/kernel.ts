import type {
  KernelEvent,
  KernelMessage,
  ModelProvider,
  ToolRuntime,
} from '@aiop/agent-contracts';
import { PiAgentKernel } from '@aiop/agent-kernel-pi';
import type { Msg, StreamEvent, ToolDef } from '../../model/types.js';
import type { AgentKernel } from '../kernel.js';
import type { RunAgentOptions, RunAgentResult } from '../core.js';
import { executeToolCall } from '../services/tool-broker.js';

export class PiAIOPAgentKernel implements AgentKernel {
  readonly name = 'pi' as const;

  async run(options: RunAgentOptions): Promise<RunAgentResult> {
    const modelProvider: ModelProvider = {
      stream: (input) => adaptModel(options, input.system, input.messages, input.tools, input.signal),
    };
    const toolRuntime: ToolRuntime = {
      execute: async (call) => {
        const toolResult = await executeToolCall({ id: call.id, name: call.name, args: call.arguments }, {
          tools: options.tools,
          policy: options.policy,
          ctx: options.ctx,
          approval: options.approval,
          hooks: options.hooks,
          toolLedger: options.toolLedger,
          runId: options.runId,
          askUser: options.askUser,
          requestPlanApproval: options.requestPlanApproval,
          signal: options.signal,
          guard: options.runGuard,
          onEvent: (event) => {
            if (event.type !== 'tool_result') options.onEvent?.(event);
          },
        });
        return {
          kind: 'result',
          result: { callId: call.id, content: toolResult.content, isError: toolResult.isError },
        };
      },
    };
    const kernel = new PiAgentKernel({ modelProvider, toolRuntime, systemPrompt: options.system });
    const messages = toKernelMessages(options.messages ?? [], options.task, options.taskContentBlocks);
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
      tools: options.tools.defs().map((tool) => ({ ...tool, capability: capability(tool) })),
      limits: { maxTurns: options.maxSteps },
      signal: options.signal,
    }, {
      emit: async (event) => emitCompatEvent(event, options.onEvent),
      guard: options.runGuard ?? (async () => undefined),
      shouldStopAfterTurn: async () => false,
    });
    const resultMessages = fromKernelMessages(exit.messages);
    return {
      messages: resultMessages,
      text: lastAssistantText(exit.messages) ?? '',
      steps: exit.messages.filter((message) => message.role === 'assistant').length,
      usage: exit.usage,
      compacted: false,
    };
  }
}

async function* adaptModel(
  options: RunAgentOptions,
  system: string,
  messages: readonly KernelMessage[],
  tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[],
  signal?: AbortSignal,
): AsyncIterable<import('@aiop/agent-contracts').ModelStreamEvent> {
  for await (const event of options.model.stream({
    system,
    messages: fromKernelMessages(messages),
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

function toKernelMessages(
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

function fromKernelMessages(messages: readonly KernelMessage[]): Msg[] {
  return messages.map((message): Msg => {
    if (message.role === 'user') return {
      role: 'user',
      text: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      contentBlocks: [...message.content],
    };
    if (message.role === 'assistant') return {
      role: 'assistant',
      text: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
      toolCalls: message.toolCalls?.map((call) => ({ id: call.id, name: call.name, args: call.arguments })),
    };
    return {
      role: 'tool',
      toolResults: message.results.map((result) => ({ id: result.callId, content: result.content, isError: result.isError })),
    };
  });
}

function capability(tool: ToolDef): 'read' | 'non_idempotent_write' {
  return /^(get|list|read|search|fetch|describe|query)(_|$)/i.test(tool.name) ? 'read' : 'non_idempotent_write';
}

function emitCompatEvent(event: KernelEvent, sink?: (event: StreamEvent) => void): void {
  if (!sink) return;
  if (event.type === 'text_delta' || event.type === 'thinking_delta') sink(event);
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
