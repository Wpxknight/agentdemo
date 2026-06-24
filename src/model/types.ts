/**
 * 内部中立的消息 / 工具 / 流式事件格式。
 * 各 provider adapter 负责在此格式与各自 wire format 之间双向翻译，
 * 让 agent loop 与具体协议（Anthropic / OpenAI）解耦。
 */

export type Role = 'user' | 'assistant' | 'tool';

/** 推理深度（思考预算/努力程度）。none=关闭思考；其余对应 Anthropic output_config.effort。 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 暴露给模型的工具定义（JSON Schema 描述入参）。 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 模型发起的一次工具调用。 */
export interface ToolCall {
  id: string;
  name: string;
  args: JsonValue;
}

/** 工具结果的结构化内容块；文本回退始终保留在 ToolResult.content。 */
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

/** 工具执行结果，回填给模型。 */
export interface ToolResult {
  id: string;
  content: string;
  contentBlocks?: ToolContentBlock[];
  isError?: boolean;
}

/** Anthropic 扩展思考块（含签名）；跨工具轮次回填时必须原样带回，否则 400。 */
export interface ThinkingBlock {
  thinking: string;
  signature: string;
}

/** 一条对话消息。 */
export interface Msg {
  role: Role;
  text?: string;
  thinking?: string; // role === 'assistant'，模型 reasoning/thinking 内容（展示用）
  /** Anthropic 思考块原文 + 签名，用于多轮工具调用时原样回填（保持推理连续性 / 防 400）。 */
  thinkingBlocks?: ThinkingBlock[]; // role === 'assistant'
  toolCalls?: ToolCall[]; // role === 'assistant'
  toolResults?: ToolResult[]; // role === 'tool'
}

/** 流式过程中产生的中立事件。 */
export type StreamEvent =
  | { type: 'thinking_delta'; text: string }
  /** 一个完整思考块结束（含签名），供 agent loop 收集后原样回填给 Anthropic。 */
  | { type: 'thinking_block'; thinking: string; signature: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  /** 工具执行期的实时输出（如沙箱 stdout/stderr），按工具调用 id 归集，供前端终端预览。 */
  | { type: 'tool_output'; toolId: string; stream: 'stdout' | 'stderr'; text: string }
  /** 单个工具调用执行完成（成功/失败），供前端实时标记任务进度。 */
  | { type: 'tool_result'; toolId: string; name: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'stop'; reason: string };

export interface StreamInput {
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  maxTokens?: number;
}

/** 所有模型 adapter 实现的统一接口。 */
export interface ChatModel {
  readonly id: string;
  stream(input: StreamInput): AsyncIterable<StreamEvent>;
}
