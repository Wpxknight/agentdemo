import type { ChatModel, ReasoningEffort } from './types.js';
import { AnthropicModel } from './anthropic.js';
import { OpenAIModel } from './openai.js';

export interface ModelConfig {
  protocol: 'anthropic' | 'openai';
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindowTokens?: number;
  /** 历史里保留图片的最近带图消息条数（更早的替换占位符），默认 1；0 表示一张不留。 */
  contextKeepImages?: number;
  /** 推理深度：none 关闭思考；low..max 对应 Anthropic effort。缺省=思考开启走模型默认深度。 */
  effort?: ReasoningEffort;
  /** 每百万 token 单价（美元），用于会话成本折算。 */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** 按配置创建模型实例（自定义 baseURL/apiKey + 协议）。 */
export function createModel(id: string, cfg: ModelConfig): ChatModel {
  switch (cfg.protocol) {
    case 'anthropic':
      return new AnthropicModel({ id, ...cfg });
    case 'openai':
      return new OpenAIModel({ id, ...cfg });
  }
}
