import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'scripts/benchmark-session-concurrency.mjs');

async function loadBenchmark() {
  expect(existsSync(scriptPath), '并发测试脚本应存在').toBe(true);
  return import(`${scriptPath}?test=${Date.now()}`) as Promise<{
    parseLevels: (value: string) => number[];
    parseSseEvents: (text: string) => Array<{ event: string; data: unknown }>;
    percentile: (values: number[], p: number) => number;
    summarizeLevel: (concurrency: number, results: Array<{
      ok: boolean;
      status: number;
      ttfbMs: number;
      totalMs: number;
      error?: string;
    }>) => {
      concurrency: number;
      attempted: number;
      succeeded: number;
      successRate: number;
      ttfbP95Ms: number;
      totalP50Ms: number;
      totalP95Ms: number;
      errors: Record<string, number>;
    };
  }>;
}

describe('session concurrency benchmark helpers', () => {
  it('parses, deduplicates, and sorts positive concurrency levels', async () => {
    const { parseLevels } = await loadBenchmark();
    expect(parseLevels('8, 1,4,8,2')).toEqual([1, 2, 4, 8]);
    expect(() => parseLevels('0,nope')).toThrow(/并发级别/);
  });

  it('parses SSE event and JSON data blocks', async () => {
    const { parseSseEvents } = await loadBenchmark();
    expect(parseSseEvents([
      'event: session',
      'data: {"sessionId":"s1"}',
      '',
      'event: done',
      'data: {"text":"OK"}',
      '',
    ].join('\n'))).toEqual([
      { event: 'session', data: { sessionId: 's1' } },
      { event: 'done', data: { text: 'OK' } },
    ]);
  });

  it('summarizes success rate, latency percentiles, and errors', async () => {
    const { percentile, summarizeLevel } = await loadBenchmark();
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    expect(summarizeLevel(4, [
      { ok: true, status: 200, ttfbMs: 10, totalMs: 100 },
      { ok: true, status: 200, ttfbMs: 20, totalMs: 200 },
      { ok: true, status: 200, ttfbMs: 30, totalMs: 300 },
      { ok: false, status: 503, ttfbMs: 40, totalMs: 400, error: 'HTTP 503' },
    ])).toEqual({
      concurrency: 4,
      attempted: 4,
      succeeded: 3,
      successRate: 0.75,
      ttfbP95Ms: 40,
      totalP50Ms: 200,
      totalP95Ms: 400,
      errors: { 'HTTP 503': 1 },
    });
  });
});
