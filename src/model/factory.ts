import type { ChatModel } from './types.js';
import { AnthropicModel } from './anthropic.js';
import { OpenAIModel } from './openai.js';

export interface ModelConfig {
  protocol: 'anthropic' | 'openai';
  baseURL: string;
  apiKey: string;
  model: string;
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
