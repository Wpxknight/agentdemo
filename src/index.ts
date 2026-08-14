import { logger } from './logger.js';
import { loadConfig } from './config/load.js';
import { buildRuntime } from './runtime.js';
import { randomUUID } from 'node:crypto';
import { createHttpServer } from './server/http.js';
import { LocalAuthProvider } from './auth/local.js';
import type { Config } from './config/schema.js';
import { shouldEmbedScheduler, startRuntimeScheduler } from './scheduler/runner.js';
import { MysqlStore } from './db/mysql.js';
import { resolveCliPrincipalId } from './runtime.js';
import { stdin } from 'node:process';

/**
 * 入口：
 *   tsx src/index.ts serve                 → HTTP + SSE 服务（前端 / API 接入）
 *   tsx src/index.ts seed-admin <t> <u> <p>→ 引导首个平台管理员
 *   tsx src/index.ts "任务文本"            → 本地单次跑一个 agent 任务（CLI）
 */
async function main() {
  const config = loadConfig();
  const argv = process.argv.slice(2);

  if (argv[0] === 'serve') return runServer(config);
  if (argv[0] === 'seed-admin') return seedAdmin(config, argv.slice(1));
  if (argv[0] === 'reset-local-password') return resetLocalPassword(config, argv.slice(1));

  await runOnce(config, argv.join(' ') || '你好，做个自我介绍。');
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
}

async function resetLocalPassword(config: Config, args: string[]) {
  const [tenantId, username] = args;
  if (!tenantId || !username) throw new Error('用法: reset-local-password <tenantId> <username>（密码从 stdin 读取）');
  const password = await readPasswordFromStdin();
  if (!password) throw new Error('stdin 中的密码不能为空');
  const rt = await buildRuntime(config);
  try {
    const localAuth = rt.debugLocalAuth ?? (rt.authProvider instanceof LocalAuthProvider ? rt.authProvider : undefined);
    if (!localAuth) throw new Error('当前运行模式未启用 local 登录');
    const user = await localAuth.resetPassword(tenantId, username, password);
    if (!user) throw new Error('目标用户不存在或 auth_provider 不是 local');
    logger.warn({ tenantId, username, userId: user.id }, 'local debug user password reset');
    await rt.audit.record({
      kind: 'auth', action: 'local-password-reset', tenantId, userId: user.id,
      provider: 'local', deploymentMode: rt.deploymentMode ?? 'standalone',
    });
  } finally {
    await rt.dispose();
  }
}

/** HTTP + SSE 服务模式。 */
async function runServer(config: Config) {
  const rt = await buildRuntime(config);
  const scheduler = shouldEmbedScheduler() ? startRuntimeScheduler(rt) : undefined;
  if (scheduler) {
    rt.requestSchedulerTick = () => {
      void scheduler.tick().catch((error) => logger.error({ err: String(error) }, 'scheduler wake tick error'));
    };
    logger.info('scheduler embedded in HTTP server');
  }

  const server = createHttpServer(rt);
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  server.listen(port, host, () => logger.info({ port, host }, 'HTTP 服务已启动'));

  const shutdown = async () => {
    logger.info('正在关闭 HTTP 服务…');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await scheduler?.stop();
    await rt.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** 本地单次任务（CLI 为可信系统主体，使用保留正整数身份并自动批准）。 */
async function runOnce(config: Config, task: string) {
  if (config.deploymentMode === 'aios-integrated') {
    throw new Error('aios-integrated mode does not support standalone CLI execution; use the authenticated Host API');
  }
  const rt = await buildRuntime(config);
  logger.info({ model: rt.model.id, task }, 'running agent');

  const durableMysql = rt.store instanceof MysqlStore;
  const userId = await resolveCliPrincipalId(
    process.env.AIOP_CLI_USER_ID,
    durableMysql,
    durableMysql ? (candidate) => rt.store.getUser('default', candidate) : undefined,
  );
  const tenantId = 'default';
  const role = 'platform_admin' as const;
  const sessionId = 'cli';
  const handle = await rt.durableRunRuntime.run({
    runId: randomUUID(),
    identity: { tenantId, actorId: userId, roles: [role] },
    sessionId,
    input: [{ role: 'user', text: task }],
    kernel: 'pi',
    execution: { preApproved: true },
  });
  for await (const _event of handle.events) {
    // The durable result is the canonical CLI output; draining events keeps execution supervised.
  }
  const result = await handle.result();
  process.stdout.write(`${result.text ?? ''}\n`);
  logger.info({ status: result.status, usage: result.usage }, 'done');
  await rt.audit.record({
    kind: 'usage', action: 'agent', tenantId: rt.defaultContext.tenantId, sessionId,
    detail: { ...result.usage },
  });
  await rt.dispose();
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
