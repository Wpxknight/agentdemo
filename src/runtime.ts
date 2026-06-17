import { logger } from './logger.js';
import type { Config } from './config/schema.js';
import { createModel } from './model/factory.js';
import type { ChatModel } from './model/types.js';
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
import type { AuditSink } from './audit/sink.js';
import { readMysqlConfig } from './config/mysql.js';
import { createStore } from './db/index.js';
import type { Store } from './db/store.js';
import { buildScheduleTools } from './tools/schedule.js';
import { LocalAuthProvider } from './auth/local.js';
import type { AuthProvider } from './auth/provider.js';
import type { RequestContext } from './auth/types.js';

export interface Runtime {
  model: ChatModel;
  tools: ToolRegistry;
  clusters: ClusterRegistry;
  audit: AuditSink;
  store: Store;
  systemExtra: string;
  /** 基础策略（交互场景，生产变更需审批）。 */
  policy: PolicyMiddleware;
  /** 无人值守策略（定时任务 preApproved 时使用）。 */
  policyPreApproved: PolicyMiddleware;
  /** 本地认证提供方（登录 / token 校验）。 */
  authProvider: AuthProvider;
  /** 无认证（CLI）场景的默认身份。 */
  defaultContext: RequestContext;
  dispose(): Promise<void>;
}

const DEFAULT_TENANT = 'default';

/** 组装一次运行所需的全部组件（模型/工具/策略/持久化）。 */
export async function buildRuntime(config: Config): Promise<Runtime> {
  const modelCfg = config.models[config.defaultModel];
  if (!modelCfg) throw new Error(`defaultModel not found: ${config.defaultModel}`);
  const model = createModel(config.defaultModel, modelCfg);
  const tools = new ToolRegistry();

  const store = await createStore(readMysqlConfig());
  const logSink = new LogAuditSink();
  const audit: AuditSink = {
    async record(e) {
      await Promise.all([logSink.record(e), store.record(e)]);
    },
  };

  const clusters = new ClusterRegistry(config.clusters);
  const hasClusters = clusters.list().length > 0;
  const policy: PolicyMiddleware = hasClusters ? new OpsPolicy({ clusters, audit }) : new AllowAllPolicy();
  const policyPreApproved: PolicyMiddleware = hasClusters
    ? new OpsPolicy({ clusters, audit, preApproved: true })
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
    if (hasClusters) {
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

  // 定时任务工具（持久化已就绪）
  for (const t of buildScheduleTools(store)) tools.register(t);

  let systemExtra = '';
  if (config.skills?.dir) {
    const skills = new SkillRegistry(config.skills.dir);
    await skills.scan();
    if (skills.list().length) {
      tools.register(skills.tool());
      systemExtra = skills.summaries();
    }
  }

  // 认证：本地 provider（JWT 密钥取自 env，缺省用开发占位）
  const secret = process.env.AIOP_JWT_SECRET;
  if (!secret) logger.warn('AIOP_JWT_SECRET 未设置，使用开发占位密钥（勿用于生产）');
  const authProvider = new LocalAuthProvider({ store, secret: secret ?? 'dev-insecure-secret' });

  // CLI 默认身份：确保默认租户存在
  await store.createTenant({ id: DEFAULT_TENANT, name: 'Default' }).catch(() => {});
  const defaultContext: RequestContext = {
    tenantId: DEFAULT_TENANT,
    userId: 'cli',
    role: 'platform_admin',
  };

  return {
    model,
    tools,
    clusters,
    audit,
    store,
    systemExtra,
    policy,
    policyPreApproved,
    authProvider,
    defaultContext,
    async dispose() {
      await sandboxes?.disposeAll();
      await mcp?.close();
      await store.close();
    },
  };
}
