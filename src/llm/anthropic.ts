import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatModel,
  JsonValue,
  Msg,
  ReasoningEffort,
  StreamEvent,
  StreamInput,
  ToolContentBlock,
  ToolDef,
  ToolResult,
} from './types.js';

export interface AnthropicModelConfig {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** 推理深度：none 关闭思考；low..max 对应 output_config.effort；缺省=思考开启走模型默认深度。 */
  effort?: ReasoningEffort;
}

function toAnthropicContentBlock(b: ToolContentBlock): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  if (b.type === 'text') return { type: 'text', text: b.text };
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: b.mimeType as Anthropic.Base64ImageSource['media_type'],
      data: b.data,
    },
  };
}

function toAnthropicToolResultContent(
  result: ToolResult,
): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  if (!result.contentBlocks?.length) return result.content;
  return result.contentBlocks.map(toAnthropicContentBlock);
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
      // 思考块必须排在最前，且原样带回签名（多轮工具调用时缺失会 400 / 丢失推理连续性）
      for (const t of m.thinkingBlocks ?? []) {
        if (t.signature) blocks.push({ type: 'thinking', thinking: t.thinking, signature: t.signature });
      }
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

    // user 消息可携带多模态内容块（如上传的图片附件）
    if (m.contentBlocks?.length) {
      const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      blocks.push(...m.contentBlocks.map(toAnthropicContentBlock));
      return { role: 'user', content: blocks };
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
  private effort?: ReasoningEffort;

  constructor(cfg: AnthropicModelConfig) {
    this.id = cfg.id;
    this.model = cfg.model;
    this.effort = cfg.effort;
    this.client = new Anthropic({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const thinkingOn = this.effort !== 'none';
    // 仅 low..max 透传 effort；缺省/none 不带（none 直接关思考）。
    const effortLevel = this.effort && this.effort !== 'none' ? this.effort : undefined;
    const stream = this.client.messages.stream({
      model: this.model,
      // 思考会占用输出预算，给足空间避免截断（流式无超时顾虑）
      max_tokens: input.maxTokens ?? (thinkingOn ? 32000 : 8192),
      system: input.system,
      tools: toAnthropicTools(input.tools),
      messages: toAnthropicMessages(input.messages),
      // adaptive：由模型自行决定思考深度；display=summarized 才会返回可见思考摘要
      // （默认 omitted 会让思考文本为空——这正是“接口里没找到思考内容”的根因之一）。
      ...(thinkingOn ? { thinking: { type: 'adaptive', display: 'summarized' } as const } : {}),
      // effort 控制思考/输出努力程度（low|medium|high|xhigh|max），需配合 adaptive。
      ...(effortLevel ? { output_config: { effort: effortLevel } } : {}),
    }, input.signal ? { signal: input.signal } : undefined);

    // 累积进行中的 tool_use 块（index -> 部分状态）
    const pending = new Map<number, { id: string; name: string; json: string }>();
    // 累积进行中的思考块（index -> 文本 + 签名），结束时整块上报供回填
    const thinkingBlocks = new Map<number, { thinking: string; signature: string }>();
    // 已上报的输入用量：兼容只在 message_delta 末尾才报 input_tokens 的网关（如部分 anthropic 协议代理），
    // 两处都读、按增量去重，避免重复累计。
    let reportedInputTokens = 0;

    for await (const ev of stream) {
      switch (ev.type) {
        case 'message_start': {
          // 输入用量只在 message_start 报（含缓存读写）；输出用量走 message_delta，避免重复累计。
          const u = ev.message.usage;
          const cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
          const cacheReadTokens = u.cache_read_input_tokens ?? 0;
          const baseInput = u.input_tokens ?? 0;
          const inputTokens = baseInput + cacheCreationTokens + cacheReadTokens;
          if (inputTokens > 0) {
            reportedInputTokens += inputTokens;
            // inputTokens 为总输入（含缓存，保持既有语义与上下文估算一致）；
            // 缓存明细单列，供成本折算区分计费档位。
            yield { type: 'usage', inputTokens, outputTokens: 0, cacheCreationTokens, cacheReadTokens };
          }
          break;
        }

        case 'content_block_start':
          if (ev.content_block.type === 'tool_use') {
            pending.set(ev.index, {
              id: ev.content_block.id,
              name: ev.content_block.name,
              json: '',
            });
          } else if (ev.content_block.type === 'thinking') {
            thinkingBlocks.set(ev.index, { thinking: '', signature: '' });
          }
          break;

        case 'content_block_delta': {
          const delta = ev.delta as {
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
            partial_json?: string;
          };
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            yield { type: 'thinking_delta', text: delta.thinking };
            const t = thinkingBlocks.get(ev.index);
            if (t) t.thinking += delta.thinking;
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            const t = thinkingBlocks.get(ev.index);
            if (t) t.signature += delta.signature;
          } else if (delta.type === 'input_json_delta') {
            const p = pending.get(ev.index);
            if (p) p.json += delta.partial_json ?? '';
          }
          break;
        }

        case 'content_block_stop': {
          const p = pending.get(ev.index);
          if (p) {
            pending.delete(ev.index);
            yield {
              type: 'tool_call',
              call: { id: p.id, name: p.name, args: safeJson(p.json) },
            };
          }
          const t = thinkingBlocks.get(ev.index);
          if (t) {
            thinkingBlocks.delete(ev.index);
            // 仅在拿到签名时上报（无签名无法回填，回填会 400）
            if (t.signature) yield { type: 'thinking_block', thinking: t.thinking, signature: t.signature };
          }
          break;
        }

        case 'message_delta':
          if (ev.usage) {
            const du = ev.usage as {
              output_tokens?: number | null;
              input_tokens?: number | null;
              cache_creation_input_tokens?: number | null;
              cache_read_input_tokens?: number | null;
            };
            const cacheCreationTokens = du.cache_creation_input_tokens ?? 0;
            const cacheReadTokens = du.cache_read_input_tokens ?? 0;
            const totalInput = (du.input_tokens ?? 0) + cacheCreationTokens + cacheReadTokens;
            const inputDelta = Math.max(0, totalInput - reportedInputTokens);
            reportedInputTokens += inputDelta;
            yield {
              type: 'usage',
              inputTokens: inputDelta,
              outputTokens: du.output_tokens ?? 0,
              // 缓存明细仅在 message_start 未报输入时（inputDelta>0）随此补报，避免重复累计。
              cacheCreationTokens: inputDelta > 0 ? cacheCreationTokens : 0,
              cacheReadTokens: inputDelta > 0 ? cacheReadTokens : 0,
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
