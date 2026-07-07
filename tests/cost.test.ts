import { describe, expect, it } from 'vitest';
import { estimateCost } from '../src/model/cost.js';
import type { Usage } from '../src/agent/core.js';

const usage: Usage = {
  inputTokens: 1_000_000, // 含缓存
  outputTokens: 500_000,
  cacheReadTokens: 400_000,
  cacheCreationTokens: 100_000,
};

describe('estimateCost', () => {
  it('returns token breakdown with no cost when unpriced', () => {
    const c = estimateCost(usage);
    expect(c.costUsd).toBeUndefined();
    expect(c.cacheReadTokens).toBe(400_000);
  });

  it('prices non-cache input, cache read/write and output separately', () => {
    // 非缓存输入 = 1,000,000 - 400,000 - 100,000 = 500,000
    const c = estimateCost(usage, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    // (500k*3 + 400k*0.3 + 100k*3.75 + 500k*15) / 1e6 = (1.5 + 0.12 + 0.375 + 7.5) = 9.495
    expect(c.costUsd).toBeCloseTo(9.495, 5);
  });

  it('falls back cache prices to input price when unset', () => {
    const c = estimateCost(usage, { input: 2, output: 10 });
    // 全部输入按 2：1,000,000*2 + 500,000*10 = 2 + 5 = 7 /1 (per million) → 2.0 + 5.0 = 7
    expect(c.costUsd).toBeCloseTo(7, 5);
  });
});
