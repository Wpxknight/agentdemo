import { logger } from './logger.js';
import { loadConfig } from './config/load.js';
import { buildRuntime } from './runtime.js';
import { AutoApproveGate } from './agent/approval.js';
import { randomUUID } from 'node:crypto';
import { DurableToolLedger } from './agent/tool-ledger/store.js';
import { SessionCommitter } from './agent/services/session-committer.js';
import { createHttpServer } from './server/http.js';
import { LocalAuthProvider } from './auth/local.js';
import type { Config } from './config/schema.js';
import { shouldEmbedScheduler, startRuntimeScheduler } from './scheduler/runner.js';

/**
 * 入口：
 *   tsx src/index.ts serve                 → HTTP + SSE 服务（前端 / API 接入）
 *   tsx src/index.ts scheduler             → 常驻调度器，到点执行定时任务
 *   tsx src/index.ts seed-admin <t> <u> <p>→ 引导首个平台管理员
 *   tsx src/index.ts "任务文本"            → 本地单次跑一个 agent 任务（CLI）
 */
async function main() {
  const config = loadConfig();
  const argv = process.argv.slice(2);

  if (argv[0] === 'serve') return runServer(config);
  if (argv[0] === 'scheduler') return runScheduler(config);
  if (argv[0] === 'seed-admin') return seedAdmin(config, argv.slice(1));

  await runOnce(config, argv.join(' ') || '你好，做个自我介绍。');
}

/** HTTP + SSE 服务模式。 */
async function runServer(config: Config) {
  const rt = await buildRuntime(config);
  const scheduler = shouldEmbedScheduler() ? startRuntimeScheduler(rt) : undefined;
  if (scheduler) logger.info('scheduler embedded in HTTP server');

  const server = createHttpServer(rt);
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  server.listen(port, host, () => logger.info({ port, host }, 'HTTP 服务已启动'));

  const shutdown = async () => {
    logger.info('正在关闭 HTTP 服务…');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    scheduler?.stop();
    await rt.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** 本地单次任务（CLI 为可信操作者，自动批准；续接 'cli' 会话历史）。 */
async function runOnce(config: Config, task: string) {
  const rt = await buildRuntime(config);
  logger.info({ model: rt.model.id, task }, 'running agent');

  const { tenantId, userId, role } = rt.defaultContext;
  const sessionId = 'cli';
  const prior = await rt.store.listMessages(rt.defaultContext, sessionId);
  const startedAt = Date.now();
  const result = await rt.agentRuntime.run({
    runId: randomUUID(),
    model: rt.model,
    tools: rt.tools,
    policy: rt.policy,
    approval: new AutoApproveGate(),
    toolLedger: new DurableToolLedger(rt.store),
    system: rt.systemExtra,
    ctx: { sessionId, tenantId, userId, role },
    messages: prior,
    task,
    onEvent: (e) => {
      if (e.type === 'text_delta') process.stdout.write(e.text);
    },
  });

  process.stdout.write('\n');
  logger.info({ steps: result.steps, usage: result.usage }, 'done');
  await new SessionCommitter(rt.store).commitSuccess({
    ctx: rt.defaultContext,
    sessionId,
    priorMessageCount: prior.length,
    result,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  await rt.audit.record({
    kind: 'usage', action: 'agent', tenantId: rt.defaultContext.tenantId, sessionId,
    detail: { ...result.usage, steps: result.steps },
  });
  await rt.dispose();
}

/** 常驻调度器模式：周期 tick 领取并执行到点定时任务。 */
async function runScheduler(config: Config) {
  const rt = await buildRuntime(config);
  const scheduler = startRuntimeScheduler(rt);
  logger.info('scheduler running; Ctrl-C to stop');

  const shutdown = async () => {
    scheduler.stop();
    await rt.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** 引导首个平台管理员（绕过 RBAC，仅限本地认证 + 运维直接执行）。 */
async function seedAdmin(config: Config, args: string[]) {
  const [tenantId, username, password] = args;
  if (!tenantId || !username || !password) {
    logger.error('用法: seed-admin <tenantId> <username> <password>');
    process.exit(2);
  }
  const rt = await buildRuntime(config);
  if (!(rt.authProvider instanceof LocalAuthProvider)) {
    logger.error('seed-admin 仅适用于本地认证（local）模式');
    await rt.dispose();
    process.exit(2);
  }
  await rt.store.createTenant({ id: tenantId, name: tenantId }).catch(() => {});
  const existing = await rt.store.getUserByUsername(tenantId, username);
  if (existing) {
    logger.warn({ tenantId, username }, '用户已存在，跳过');
  } else {
    const user = await rt.authProvider.createUser(tenantId, username, password, 'platform_admin');
    logger.info({ tenantId, username, userId: user.id }, '已创建平台管理员');
  }
  await rt.dispose();
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
