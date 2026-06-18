import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatModel,
  JsonValue,
  Msg,
  StreamEvent,
  StreamInput,
  ToolDef,
  ToolResult,
} from './types.js';

export interface AnthropicModelConfig {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

function toAnthropicToolResultContent(
  result: ToolResult,
): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  if (!result.contentBlocks?.length) return result.content;
  return result.contentBlocks.map((b): Anthropic.TextBlockParam | Anthropic.ImageBlockParam => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: b.mimeType as Anthropic.Base64ImageSource['media_type'],
        data: b.data,
      },
    };
  });
}

/** 内部 Msg[] -> Anthropic MessageParam[]（content blocks）。导出以便单测。 */
export function toAnthropicMessages(messages: Msg[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'tool') {
      // 工具结果在 Anthropic 里是 user 角色下的 tool_result 块
      return {
        role: 'user',
        content: (m.toolResults ?? []).map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: toAnthropicToolResultContent(r),
          is_error: r.isError,
        })),
      };
    }

    if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: c.args as unknown as Record<string, unknown>,
        });
      }
      return { role: 'assistant', content: blocks };
    }

    return { role: 'user', content: m.text ?? '' };
  });
}

export function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** Anthropic 协议 adapter（/v1/messages），支持自定义 baseURL/apiKey。 */
export class AnthropicModel implements ChatModel {
  readonly id: string;
  private client: Anthropic;
  private model: string;

  constructor(cfg: AnthropicModelConfig) {
    this.id = cfg.id;
    this.model = cfg.model;
    this.client = new Anthropic({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: input.maxTokens ?? 8192,
      system: input.system,
      tools: toAnthropicTools(input.tools),
      messages: toAnthropicMessages(input.messages),
    });

    // 累积进行中的 tool_use 块（index -> 部分状态）
    const pending = new Map<number, { id: string; name: string; json: string }>();

    for await (const ev of stream) {
      switch (ev.type) {
        case 'content_block_start':
          if (ev.content_block.type === 'tool_use') {
            pending.set(ev.index, {
              id: ev.content_block.id,
              name: ev.content_block.name,
              json: '',
            });
          }
          break;

        case 'content_block_delta':
          if (ev.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: ev.delta.text };
          } else if (ev.delta.type === 'input_json_delta') {
            const p = pending.get(ev.index);
            if (p) p.json += ev.delta.partial_json;
          }
          break;

        case 'content_block_stop': {
          const p = pending.get(ev.index);
          if (p) {
            pending.delete(ev.index);
            yield {
              type: 'tool_call',
              call: { id: p.id, name: p.name, args: safeJson(p.json) },
            };
          }
          break;
        }

        case 'message_delta':
          if (ev.usage) {
            yield {
              type: 'usage',
              inputTokens: 0,
              outputTokens: ev.usage.output_tokens ?? 0,
            };
          }
          if (ev.delta.stop_reason) {
            yield { type: 'stop', reason: ev.delta.stop_reason };
          }
          break;
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
