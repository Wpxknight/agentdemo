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
  capability?: 'read' | 'retryable_write' | 'non_idempotent_write';
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
  /** 一次 Agent 运行最终耗时（毫秒）；仅最后一条 assistant 消息持久化。 */
  durationMs?: number;
  /** Anthropic 思考块原文 + 签名，用于多轮工具调用时原样回填（保持推理连续性 / 防 400）。 */
  thinkingBlocks?: ThinkingBlock[]; // role === 'assistant'
  toolCalls?: ToolCall[]; // role === 'assistant'
  toolResults?: ToolResult[]; // role === 'tool'
  /** role === 'user'：多模态内容块（如上传的图片附件），与 text 并存。 */
  contentBlocks?: ToolContentBlock[];
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
  /**
   * 模型调用失败（网络异常 / 上游报错，含中途断流），agent 即将发起第 attempt/maxAttempts 次重试。
   * 重试会整轮重放：discard* 标记失败尝试已流式发出的部分输出量，供前端回滚展示。
   */
  | {
      type: 'model_retry';
      attempt: number;
      maxAttempts: number;
      error: string;
      discardTextChars: number;
      discardThinkingChars: number;
      discardToolIds: string[];
    }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      /** 缓存读取的输入 token（命中提示缓存，计费更低）。 */
      cacheReadTokens?: number;
      /** 缓存写入/创建的输入 token（首次建缓存，计费略高于普通输入）。 */
      cacheCreationTokens?: number;
    }
  /** 历史逼近上下文窗口，已把最旧的若干消息摘要压缩成一段（供前端提示 / 日志）。 */
  | { type: 'context_compacted'; summarizedMessages: number; beforeTokens: number; afterTokens: number }
  /** 模型通过 todo_write 更新了任务清单（供前端实时渲染进度）。 */
  | { type: 'todo_updated'; todos: TodoItem[] }
  /** 工具导出了一个可下载文件（供前端渲染下载按钮，不依赖模型转述链接）。 */
  | { type: 'file_exported'; name: string; url: string; size: number; mime: string; expiresAt: string }
  | { type: 'stop'; reason: string };

/** 任务清单项（todo_write 工具维护）。 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface StreamInput {
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  maxTokens?: number;
  /** 当前请求的取消信号；HTTP 终止会话或客户端断开时用于中止上游模型流。 */
  signal?: AbortSignal;
}

/** 所有模型 adapter 实现的统一接口。 */
export interface ChatModel {
  readonly id: string;
  stream(input: StreamInput): AsyncIterable<StreamEvent>;
}
