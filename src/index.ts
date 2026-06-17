import { logger } from './logger.js';
import { loadConfig } from './config/load.js';
import { createModel } from './model/factory.js';
import { runAgent } from './agent/core.js';
import { ToolRegistry } from './agent/tools.js';
import { AllowAllPolicy, OpsPolicy } from './agent/policy.js';
import type { PolicyMiddleware } from './agent/policy.js';
import { SandboxManager } from './sandbox/lifecycle.js';
import { E2bProvider } from './sandbox/e2b.js';
import { buildSandboxTools } from './tools/builtin.js';
import { McpManager } from './mcp/manager.js';
import { connectMcp } from './mcp/client.js';
import { SkillRegistry } from './skill/registry.js';
import { ClusterRegistry } from './config/clusters.js';
import { buildKubectlTool } from './tools/kubectl.js';
import { LogAuditSink } from './audit/sink.js';

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
  const audit = new LogAuditSink();
  const clusters = new ClusterRegistry(config.clusters);

  // 配置了集群即启用运维策略（读写分离/危险命令/生产审批），否则放行
  const policy: PolicyMiddleware = clusters.list().length
    ? new OpsPolicy({ clusters, audit })
    : new AllowAllPolicy();

  let sandboxes: SandboxManager | undefined;
  if (config.sandbox?.enabled) {
    sandboxes = new SandboxManager({
      provider: new E2bProvider({ apiKey: config.sandbox.apiKey, domain: config.sandbox.domain }),
      idleMs: config.sandbox.idleMs,
      timeoutMs: config.sandbox.timeoutMs,
    });
    for (const t of buildSandboxTools(sandboxes)) tools.register(t);
    logger.info('sandbox tools enabled');

    // kubectl 工具依赖 in-cluster 沙箱执行
    if (clusters.list().length) {
      tools.register(buildKubectlTool({ clusters, sandboxes, audit }));
      logger.info({ clusters: clusters.names() }, 'kubectl tool enabled');
    }
  }

  let mcp: McpManager | undefined;
  if (config.mcpServers && Object.keys(config.mcpServers).length) {
    mcp = new McpManager(config.mcpServers, connectMcp);
    await mcp.start();
    for (const t of mcp.tools()) tools.register(t);
  }

  let systemExtra = '';
  if (config.skills?.dir) {
    const skills = new SkillRegistry(config.skills.dir);
    await skills.scan();
    if (skills.list().length) {
      tools.register(skills.tool());
      systemExtra = skills.summaries();
    }
  }

  const task = process.argv.slice(2).join(' ') || '你好，做个自我介绍。';
  logger.info({ model: model.id, task }, 'running agent');

  const result = await runAgent({
    model,
    tools,
    policy,
    system: systemExtra,
    ctx: { sessionId: 'cli' },
    task,
    onEvent: (e) => {
      if (e.type === 'text_delta') process.stdout.write(e.text);
    },
  });

  process.stdout.write('\n');
  logger.info({ steps: result.steps }, 'done');

  await sandboxes?.disposeAll();
  await mcp?.close();
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
