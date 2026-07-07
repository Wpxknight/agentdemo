import type { Usage } from '../agent/core.js';

/** 每百万 token 单价（美元）。 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 估算总成本（美元）；无定价时为 undefined。 */
  costUsd?: number;
}

/**
 * 按模型定价折算一次运行的成本。
 * inputTokens 为总输入（含缓存），因此非缓存输入 = inputTokens - cacheRead - cacheCreation，
 * 分档计费：非缓存输入按 input 价，缓存读按 cacheRead 价（缺省回退 input），缓存写按 cacheWrite 价（缺省回退 input）。
 */
export function estimateCost(usage: Usage, pricing?: ModelPricing): CostEstimate {
  const base: CostEstimate = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
  };
  if (!pricing) return base;

  const nonCacheInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens);
  const readPrice = pricing.cacheRead ?? pricing.input;
  const writePrice = pricing.cacheWrite ?? pricing.input;
  const costUsd =
    (nonCacheInput * pricing.input +
      usage.cacheReadTokens * readPrice +
      usage.cacheCreationTokens * writePrice +
      usage.outputTokens * pricing.output) /
    1_000_000;
  // 保留 6 位小数（成本常在 $0.00x 量级）
  return { ...base, costUsd: Math.round(costUsd * 1_000_000) / 1_000_000 };
}
