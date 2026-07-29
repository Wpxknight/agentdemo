import OpenAI from 'openai';
import type {
  ChatModel,
  JsonValue,
  Msg,
  StreamEvent,
  StreamInput,
  ToolContentBlock,
  ToolDef,
  ToolResult,
} from './types.js';

export interface OpenAIModelConfig {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function normalizeOpenAIBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1';
      return url.toString().replace(/\/+$/, '');
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

function toOpenAIContentPart(
  b: ToolContentBlock,
): OpenAI.Chat.Completions.ChatCompletionContentPart {
  if (b.type === 'text') return { type: 'text', text: b.text };
  return {
    type: 'image_url',
    image_url: { url: `data:${b.mimeType};base64,${b.data}` },
  };
}

function openAIImageMessages(result: ToolResult): ChatMsg[] {
  const blocks = result.contentBlocks ?? [];
  if (!blocks.some((b) => b.type === 'image')) return [];
  return [{
    role: 'user',
    content: blocks.map(toOpenAIContentPart),
  }];
}

/** 内部 Msg[] -> OpenAI ChatCompletionMessageParam[]（system 进 messages[0]）。导出以便单测。 */
export function toOpenAIMessages(system: string, messages: Msg[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'tool') {
      for (const r of m.toolResults ?? []) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
        out.push(...openAIImageMessages(r));
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

    // user 消息可携带多模态内容块（如上传的图片附件）
    if (m.contentBlocks?.length) {
      const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      if (m.text) parts.push({ type: 'text', text: m.text });
      parts.push(...m.contentBlocks.map(toOpenAIContentPart));
      out.push({ role: 'user', content: parts });
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
    this.client = new OpenAI({ baseURL: normalizeOpenAIBaseURL(cfg.baseURL), apiKey: cfg.apiKey });
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      stream_options: { include_usage: true }, // 末尾 chunk 携带 token 用量
      max_tokens: input.maxTokens ?? 8192,
      messages: toOpenAIMessages(input.system, input.messages),
      tools: input.tools.length ? toOpenAITools(input.tools) : undefined,
    }, input.signal ? { signal: input.signal } : undefined);

    // 按 index 累积流式 tool_calls
    const pending = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      // 含 usage 的末尾 chunk 可能没有 choices
      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      const thinking = readReasoningDelta(delta);
      if (thinking) yield { type: 'thinking_delta', text: thinking };
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

function readReasoningDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return '';
  const record = delta as Record<string, unknown>;
  for (const key of ['reasoning_content', 'thinking_content', 'reasoning', 'thinking']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  const details = record.reasoning_details;
  if (!Array.isArray(details)) return '';
  return details
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const detail = item as Record<string, unknown>;
      return typeof detail.text === 'string'
        ? detail.text
        : typeof detail.delta === 'string'
          ? detail.delta
          : '';
    })
    .join('');
}
