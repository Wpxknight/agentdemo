import type { ChatModel, Msg, StreamEvent, ToolCall, ToolDef } from '../../model/types.js';
import { compactMessages } from '../context.js';

/** 一次运行累计的 token 用量（跨多轮、包含失败尝试）。 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelTurn {
  text: string;
  thinking: string;
  thinkingBlocks: Array<{ thinking: string; signature: string }>;
  calls: ToolCall[];
  usage: Usage;
}

export interface RunModelTurnOptions {
  model: ChatModel;
  system: string;
  messages: Msg[];
  toolDefs: ToolDef[];
  filterToolDefs?: (defs: ToolDef[]) => ToolDef[];
  contextBudgetTokens?: number;
  keepImages?: number;
  modelRetryDelayMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
}

/** 模型调用失败（网络异常 / 上游报错）的最大重试次数（不含首次尝试）。 */
export const MAX_MODEL_RETRIES = 10;

export async function runModelTurn(options: RunModelTurnOptions): Promise<ModelTurn> {
  const usage = emptyUsage();
  let text = '';
  let thinking = '';
  let calls: ToolCall[] = [];
  let thinkingBlocks: Array<{ thinking: string; signature: string }> = [];

  for (let attempt = 0; ; attempt++) {
    text = '';
    thinking = '';
    calls = [];
    thinkingBlocks = [];
    try {
      const sendMessages = options.contextBudgetTokens
        ? compactMessages(options.messages, options.contextBudgetTokens, options.keepImages ?? 1)
        : options.messages;
      const tools = options.filterToolDefs ? options.filterToolDefs(options.toolDefs) : options.toolDefs;
      for await (const event of options.model.stream({
        system: options.system,
        messages: sendMessages,
        tools,
        signal: options.signal,
      })) {
        throwIfAborted(options.signal);
        options.onEvent?.(event);
        if (event.type === 'thinking_delta') thinking += event.text;
        else if (event.type === 'thinking_block') {
          thinkingBlocks.push({ thinking: event.thinking, signature: event.signature });
        } else if (event.type === 'text_delta') text += event.text;
        else if (event.type === 'tool_call') calls.push(event.call);
        else if (event.type === 'usage') {
          usage.inputTokens += event.inputTokens;
          usage.outputTokens += event.outputTokens;
          usage.cacheReadTokens += event.cacheReadTokens ?? 0;
          usage.cacheCreationTokens += event.cacheCreationTokens ?? 0;
        }
      }
      return { text, thinking, thinkingBlocks, calls, usage };
    } catch (error) {
      throwIfAborted(options.signal);
      if (attempt >= MAX_MODEL_RETRIES || isNonRetryableModelError(error)) throw error;
      options.onEvent?.({
        type: 'model_retry',
        attempt: attempt + 1,
        maxAttempts: MAX_MODEL_RETRIES,
        error: errorMessage(error),
        discardTextChars: text.length,
        discardThinkingChars: thinking.length,
        discardToolIds: calls.map((call) => call.id),
      });
      await sleep(retryDelayMs(attempt, options.modelRetryDelayMs), options.signal);
    }
  }
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function retryDelayMs(attempt: number, baseMs?: number): number {
  const base = baseMs ?? 1000;
  return Math.min(base * 2 ** attempt, 30_000);
}

function isNonRetryableModelError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === 'string' && signal.reason ? signal.reason : '运行已终止');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
