import { logger } from './logger.js';
import { loadConfig } from './config/load.js';
import { createModel } from './model/factory.js';
import { runAgent } from './agent/core.js';
import { ToolRegistry } from './agent/tools.js';
import { AllowAllPolicy } from './agent/policy.js';
import { SandboxManager } from './sandbox/lifecycle.js';
import { E2bProvider } from './sandbox/e2b.js';
import { buildSandboxTools } from './tools/builtin.js';

/**
 * S1 临时入口：加载配置 + 跑一次 agent。
 * 后续阶段替换为 HTTP + SSE 服务（server/http.ts）。
 */
async function main() {
  const config = loadConfig();
  const modelCfg = config.models[config.defaultModel];
  if (!modelCfg) throw new Error(`defaultModel not found: ${config.defaultModel}`);

  const model = createModel(config.defaultModel, modelCfg);
  const tools = new ToolRegistry();
  const policy = new AllowAllPolicy();

  let sandboxes: SandboxManager | undefined;
  if (config.sandbox?.enabled) {
    sandboxes = new SandboxManager({
      provider: new E2bProvider({ apiKey: config.sandbox.apiKey, domain: config.sandbox.domain }),
      idleMs: config.sandbox.idleMs,
      timeoutMs: config.sandbox.timeoutMs,
    });
    for (const t of buildSandboxTools(sandboxes)) tools.register(t);
    logger.info('sandbox tools enabled');
  }

  const task = process.argv.slice(2).join(' ') || '你好，做个自我介绍。';
  logger.info({ model: model.id, task }, 'running agent');

  const result = await runAgent({
    model,
    tools,
    policy,
    ctx: { sessionId: 'cli' },
    task,
    onEvent: (e) => {
      if (e.type === 'text_delta') process.stdout.write(e.text);
    },
  });

  process.stdout.write('\n');
  logger.info({ steps: result.steps }, 'done');

  await sandboxes?.disposeAll();
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
