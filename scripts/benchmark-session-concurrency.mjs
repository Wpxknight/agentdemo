#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseLevels(value) {
  const levels = [...new Set(String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0))]
    .sort((a, b) => a - b);
  if (!levels.length) throw new Error('并发级别必须是逗号分隔的正整数，例如 1,2,4,8');
  return levels;
}

export function parseSseEvents(text) {
  const events = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    const raw = data.join('\n');
    try {
      events.push({ event, data: JSON.parse(raw) });
    } catch {
      events.push({ event, data: raw });
    }
  }
  return events;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length));
  return sorted[rank - 1];
}

export function summarizeLevel(concurrency, results) {
  const succeeded = results.filter((result) => result.ok).length;
  const errors = {};
  for (const result of results) {
    if (result.ok) continue;
    const key = result.error || `HTTP ${result.status}`;
    errors[key] = (errors[key] || 0) + 1;
  }
  return {
    concurrency,
    attempted: results.length,
    succeeded,
    successRate: results.length ? succeeded / results.length : 0,
    ttfbP95Ms: percentile(results.map((result) => result.ttfbMs), 95),
    totalP50Ms: percentile(results.map((result) => result.totalMs), 50),
    totalP95Ms: percentile(results.map((result) => result.totalMs), 95),
    errors,
  };
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function flag(argv, name) {
  return argv.includes(name);
}

function errorText(events, status) {
  const failed = events.find((event) => event.event === 'error' || event.event === 'terminated');
  if (failed) {
    if (typeof failed.data === 'string') return failed.data;
    if (failed.data && typeof failed.data === 'object') {
      return String(failed.data.error || failed.data.reason || failed.event);
    }
  }
  return `HTTP ${status}`;
}

async function login(baseUrl, tenantId, username, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId, username, password }),
  });
  if (!response.ok) throw new Error(`登录失败：HTTP ${response.status} ${await response.text()}`);
  const body = await response.json();
  if (!body.token) throw new Error('登录响应缺少 token');
  return body.token;
}

async function runSession({ baseUrl, token, sessionId, prompt, timeoutMs }) {
  const startedAt = performance.now();
  let firstByteAt;
  try {
    const response = await fetch(`${baseUrl}/v1/agent`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId, task: prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteAt === undefined && value?.byteLength) firstByteAt = performance.now();
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      firstByteAt = performance.now();
    }
    const endedAt = performance.now();
    const events = parseSseEvents(text);
    const done = events.some((event) => event.event === 'done');
    const failed = events.some((event) => event.event === 'error' || event.event === 'terminated');
    return {
      sessionId,
      ok: response.ok && done && !failed,
      status: response.status,
      ttfbMs: Math.round((firstByteAt ?? endedAt) - startedAt),
      totalMs: Math.round(endedAt - startedAt),
      events: events.map((event) => event.event),
      ...(!response.ok || !done || failed ? { error: errorText(events, response.status) } : {}),
    };
  } catch (error) {
    const endedAt = performance.now();
    return {
      sessionId,
      ok: false,
      status: 0,
      ttfbMs: Math.round((firstByteAt ?? endedAt) - startedAt),
      totalMs: Math.round(endedAt - startedAt),
      events: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function cleanupSessions(baseUrl, token, sessionIds) {
  await Promise.all(sessionIds.map(async (sessionId) => {
    await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => {});
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  if (flag(argv, '--help')) {
    console.log(`用法：
  AIOP_BENCH_PASSWORD=... node scripts/benchmark-session-concurrency.mjs [选项]

选项：
  --base-url URL          默认 AIOP_BENCH_BASE_URL 或 http://192.168.10.108:30083
  --tenant ID            默认 default
  --username NAME        默认 admin
  --levels LIST          默认 1,2,4,8,16
  --timeout-ms N         单会话超时，默认 120000
  --max-error-rate N     超过该错误率停止，默认 0.05
  --prompt TEXT          默认要求模型只回复 OK
  --no-cleanup           保留测试会话
`);
    return;
  }

  const baseUrl = String(option(argv, '--base-url', process.env.AIOP_BENCH_BASE_URL || 'http://192.168.10.108:30083')).replace(/\/$/, '');
  const tenantId = option(argv, '--tenant', process.env.AIOP_BENCH_TENANT || 'default');
  const username = option(argv, '--username', process.env.AIOP_BENCH_USERNAME || 'admin');
  const password = process.env.AIOP_BENCH_PASSWORD;
  const suppliedToken = process.env.AIOP_BENCH_TOKEN;
  const levels = parseLevels(option(argv, '--levels', '1,2,4,8,16'));
  const timeoutMs = Number(option(argv, '--timeout-ms', '120000'));
  const maxErrorRate = Number(option(argv, '--max-error-rate', '0.05'));
  const prompt = option(argv, '--prompt', '这是并发性能测试。请不要调用任何工具，只回复：OK');
  if (!suppliedToken && !password) throw new Error('请设置 AIOP_BENCH_PASSWORD 或 AIOP_BENCH_TOKEN');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms 必须为正数');
  if (!Number.isFinite(maxErrorRate) || maxErrorRate < 0 || maxErrorRate >= 1) throw new Error('--max-error-rate 必须在 [0,1)');

  const token = suppliedToken || await login(baseUrl, tenantId, username, password);
  const runId = `bench-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const summaries = [];
  const details = [];

  console.log(`目标：${baseUrl}`);
  console.log(`并发级别：${levels.join(', ')}；单请求超时：${timeoutMs}ms`);

  for (const concurrency of levels) {
    const sessionIds = Array.from({ length: concurrency }, (_, index) => `${runId}-c${concurrency}-${index + 1}`);
    const levelStartedAt = performance.now();
    const results = await Promise.all(sessionIds.map((sessionId) => runSession({
      baseUrl,
      token,
      sessionId,
      prompt,
      timeoutMs,
    })));
    const wallMs = Math.round(performance.now() - levelStartedAt);
    const summary = {
      ...summarizeLevel(concurrency, results),
      wallMs,
      completedPerSecond: Number((results.length / Math.max(0.001, wallMs / 1000)).toFixed(2)),
    };
    summaries.push(summary);
    details.push(...results.map((result) => ({ concurrency, ...result })));
    console.table([{
      concurrency,
      success: `${summary.succeeded}/${summary.attempted}`,
      successRate: `${(summary.successRate * 100).toFixed(1)}%`,
      ttfbP95Ms: summary.ttfbP95Ms,
      totalP50Ms: summary.totalP50Ms,
      totalP95Ms: summary.totalP95Ms,
      wallMs,
      completedPerSecond: summary.completedPerSecond,
    }]);
    if (!flag(argv, '--no-cleanup')) await cleanupSessions(baseUrl, token, sessionIds);
    if (1 - summary.successRate > maxErrorRate) {
      console.warn(`错误率超过 ${(maxErrorRate * 100).toFixed(1)}%，停止继续加压。`);
      break;
    }
  }

  const healthy = summaries.filter((summary) => 1 - summary.successRate <= maxErrorRate);
  const report = {
    testedAt: new Date().toISOString(),
    baseUrl,
    levelsRequested: levels,
    highestHealthyConcurrency: healthy.at(-1)?.concurrency ?? 0,
    reachedSaturation: summaries.length < levels.length || summaries.some((summary) => 1 - summary.successRate > maxErrorRate),
    summaries,
    failures: details.filter((result) => !result.ok),
  };
  console.log('BENCHMARK_RESULT_JSON');
  console.log(JSON.stringify(report, null, 2));
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
