import OpenAI from 'openai';
import type {
  ChatModel,
  JsonValue,
  Msg,
  StreamEvent,
  StreamInput,
  ToolDef,
} from './types.js';

export interface OpenAIModelConfig {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** 内部 Msg[] -> OpenAI ChatCompletionMessageParam[]（system 进 messages[0]）。导出以便单测。 */
export function toOpenAIMessages(system: string, messages: Msg[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'tool') {
      for (const r of m.toolResults ?? []) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.text ?? '',
      };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    out.push({ role: 'user', content: m.text ?? '' });
  }

  return out;
}

export function toOpenAITools(
  tools: ToolDef[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** OpenAI 协议 adapter（/v1/chat/completions），支持自定义 baseURL/apiKey。 */
export class OpenAIModel implements ChatModel {
  readonly id: string;
  private client: OpenAI;
  private model: string;

  constructor(cfg: OpenAIModelConfig) {
    this.id = cfg.id;
    this.model = cfg.model;
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      max_tokens: input.maxTokens ?? 8192,
      messages: toOpenAIMessages(input.system, input.messages),
      tools: input.tools.length ? toOpenAITools(input.tools) : undefined,
    });

    // 按 index 累积流式 tool_calls
    const pending = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (delta?.content) yield { type: 'text_delta', text: delta.content };

      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index;
        let p = pending.get(idx);
        if (!p) {
          p = { id: tc.id ?? '', name: '', args: '' };
          pending.set(idx, p);
        }
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name += tc.function.name;
        if (tc.function?.arguments) p.args += tc.function.arguments;
      }

      if (choice.finish_reason) {
        for (const p of pending.values()) {
          yield {
            type: 'tool_call',
            call: { id: p.id, name: p.name, args: safeJson(p.args) },
          };
        }
        pending.clear();
        yield { type: 'stop', reason: choice.finish_reason };
      }
    }
  }
}

function safeJson(s: string): JsonValue {
  if (!s.trim()) return {};
  try {
    return JSON.parse(s) as JsonValue;
  } catch {
    return {};
  }
}
