import { logger } from './logger.js';
import { loadConfig } from './config/load.js';
import { runAgent } from './agent/core.js';
import { buildRuntime } from './runtime.js';
import { Scheduler } from './scheduler/ticker.js';
import type { ScheduledTask } from './db/store.js';

/**
 * 临时入口（HTTP+SSE 服务后续接入）：
 *   tsx src/index.ts "任务文本"   → 单次跑一个 agent 任务
 *   tsx src/index.ts scheduler    → 常驻调度器，到点执行定时任务
 */
async function main() {
  const config = loadConfig();
  const argv = process.argv.slice(2);

  if (argv[0] === 'scheduler') {
    await runScheduler(config);
    return;
  }

  const rt = await buildRuntime(config);
  const task = argv.join(' ') || '你好，做个自我介绍。';
  logger.info({ model: rt.model.id, task }, 'running agent');

  const result = await runAgent({
    model: rt.model,
    tools: rt.tools,
    policy: rt.policy,
    system: rt.systemExtra,
    ctx: { sessionId: 'cli' },
    task,
    onEvent: (e) => {
      if (e.type === 'text_delta') process.stdout.write(e.text);
    },
  });

  process.stdout.write('\n');
  logger.info({ steps: result.steps }, 'done');
  for (const m of result.messages) await rt.store.appendMessage('cli', m);
  await rt.dispose();
}

/** 常驻调度器模式：周期 tick 领取并执行到点定时任务。 */
async function runScheduler(config: Awaited<ReturnType<typeof loadConfig>>) {
  const rt = await buildRuntime(config);

  const runner = async (t: ScheduledTask) => {
    logger.info({ taskId: t.id, sessionId: t.sessionId }, 'running scheduled task');
    const result = await runAgent({
      model: rt.model,
      tools: rt.tools,
      policy: t.preApproved ? rt.policyPreApproved : rt.policy,
      system: rt.systemExtra,
      ctx: { sessionId: t.sessionId },
      task: t.task,
    });
    for (const m of result.messages) await rt.store.appendMessage(t.sessionId, m);
    return { status: 'success' as const, detail: result.text.slice(0, 4000), steps: result.steps };
  };

  const scheduler = new Scheduler({ store: rt.store, runner });
  scheduler.start();
  logger.info('scheduler running; Ctrl-C to stop');

  const shutdown = async () => {
    scheduler.stop();
    await rt.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
