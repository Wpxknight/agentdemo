import { logger } from './logger.js';
import type { Config } from './config/schema.js';
import { createModel, type ModelConfig as FactoryModelConfig } from './model/factory.js';
import type { ChatModel } from './model/types.js';
import { ToolRegistry } from './agent/tools.js';
import { AllowAllPolicy, OpsPolicy } from './agent/policy.js';
import type { PolicyMiddleware } from './agent/policy.js';
import { SandboxManager } from './sandbox/lifecycle.js';
import { E2bProvider } from './sandbox/e2b.js';
import { OpenSandboxProvider } from './sandbox/opensandbox.js';
import { LocalSandboxProvider } from './sandbox/local.js';
import type { SandboxProvider } from './sandbox/types.js';
import { WarmPool } from './sandbox/warmpool.js';
import { E2bDesktopProvider } from './sandbox/e2b-desktop.js';
import { LocalDesktopProvider } from './sandbox/local-desktop.js';
import { OpenSandboxDesktopProvider } from './sandbox/opensandbox-desktop.js';
import type { DesktopHandle, DesktopProvider } from './sandbox/desktop.js';
import { buildSandboxTools } from './tools/builtin.js';
import { buildBrowserTools } from './tools/browser.js';
import { McpManager } from './mcp/manager.js';
import { connectMcp } from './mcp/client.js';
import { SkillRegistry } from './skill/registry.js';
import { ClusterRegistry } from './config/clusters.js';
import { buildKubectlTool } from './tools/kubectl.js';
import { LogAuditSink } from './audit/sink.js';
import type { AuditSink } from './audit/sink.js';
import { readMysqlConfig } from './config/mysql.js';
import { createStore } from './db/index.js';
import type { LlmSettings, Store } from './db/store.js';
import { buildScheduleTools } from './tools/schedule.js';
import { LocalAuthProvider } from './auth/local.js';
import { OidcAuthProvider } from './auth/oidc.js';
import type { AuthProvider } from './auth/provider.js';
import type { RequestContext } from './auth/types.js';

export interface Runtime {
  model: ChatModel;
  modelConfig?: RuntimeModelConfig;
  modelOptions?: RuntimeModelConfig[];
  updateModel?(config: RuntimeModelConfig): void;
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
  /** 会话 JWT 密钥（HTTP 层签发 OIDC 临时 state cookie 等用）。 */
  jwtSecret: string;
  /** 无认证（CLI）场景的默认身份。 */
  defaultContext: RequestContext;
  dispose(): Promise<void>;
}

export type RuntimeModelConfig = { id: string } & FactoryModelConfig;

const DEFAULT_TENANT = 'default';

function defaultRuntimeModelConfig(config: Config): RuntimeModelConfig {
  const modelCfg = config.models[config.defaultModel];
  if (!modelCfg) throw new Error(`defaultModel not found: ${config.defaultModel}`);
  return { id: config.defaultModel, ...modelCfg };
}

function toRuntimeModelConfig(settings: LlmSettings): RuntimeModelConfig {
  return { ...settings };
}

export async function resolveRuntimeModelConfig(
  config: Config,
  store?: Store,
  tenantId = DEFAULT_TENANT,
): Promise<RuntimeModelConfig> {
  const fallback = defaultRuntimeModelConfig(config);
  const persisted = await store?.getLlmSettings({ tenantId });
  return persisted ? toRuntimeModelConfig(persisted) : fallback;
}

/** 组装一次运行所需的全部组件（模型/工具/策略/持久化）。 */
export async function buildRuntime(config: Config): Promise<Runtime> {
  let modelConfig = defaultRuntimeModelConfig(config);
  const modelOptions: RuntimeModelConfig[] = Object.entries(config.models).map(([id, cfg]) => ({ id, ...cfg }));
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
  let warmPoolRef: WarmPool | undefined;
  const desktops = new Map<string, Promise<DesktopHandle>>();
  if (config.sandbox?.enabled) {
    const provider: SandboxProvider =
      config.sandbox.provider === 'local'
        ? new LocalSandboxProvider()
        : config.sandbox.provider === 'opensandbox'
        ? new OpenSandboxProvider({
            domain: config.sandbox.domain,
            protocol: config.sandbox.protocol,
            apiKey: config.sandbox.apiKey,
            defaultImage: config.sandbox.defaultImage,
          })
        : new E2bProvider({ apiKey: config.sandbox.apiKey, domain: config.sandbox.domain });
    logger.info({ provider: config.sandbox.provider }, 'sandbox provider selected');

    // 预热池：仅在未配置集群时启用（集群需专用模板，避免发错沙箱）
    let warmPool: WarmPool | undefined;
    if (config.sandbox.warmPoolSize && !hasClusters) {
      warmPool = new WarmPool({ provider, spec: {}, size: config.sandbox.warmPoolSize });
      await warmPool.start();
      warmPoolRef = warmPool;
      logger.info({ size: config.sandbox.warmPoolSize }, 'sandbox warm pool ready');
    } else if (config.sandbox.warmPoolSize && hasClusters) {
      logger.warn('配置了集群，warmPoolSize 被忽略（集群需专用模板）');
    }

    sandboxes = new SandboxManager({
      provider,
      idleMs: config.sandbox.idleMs,
      timeoutMs: config.sandbox.timeoutMs,
      warmPool,
    });
    for (const t of buildSandboxTools(sandboxes)) tools.register(t);
    logger.info('sandbox tools enabled');
    if (hasClusters) {
      tools.register(buildKubectlTool({ clusters, sandboxes, audit }));
      logger.info({ clusters: clusters.names() }, 'kubectl tool enabled');
    }

    // 桌面 / 浏览器工具：opensandbox 复用同一会话沙箱；local/e2b 保持各自后端。
    if (config.sandbox.desktop) {
      const dp: DesktopProvider = config.sandbox.provider === 'local'
        ? new LocalDesktopProvider()
        : config.sandbox.provider === 'opensandbox'
          ? new OpenSandboxDesktopProvider(sandboxes)
          : new E2bDesktopProvider({ apiKey: config.sandbox.apiKey, domain: config.sandbox.domain });
      const resolve = (ctx: { sessionId: string }): Promise<DesktopHandle> => {
        let d = desktops.get(ctx.sessionId);
        if (!d) {
          d = dp.create({ key: ctx.sessionId, timeoutMs: config.sandbox!.timeoutMs });
          desktops.set(ctx.sessionId, d);
        }
        return d;
      };
      for (const t of buildBrowserTools(resolve)) tools.register(t);
      logger.info('desktop/browser tools enabled');
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

  // 认证：本地或 OIDC（JWT 密钥取自 env，缺省用开发占位）
  const secret = process.env.AIOP_JWT_SECRET;
  if (!secret) logger.warn('AIOP_JWT_SECRET 未设置，使用开发占位密钥（勿用于生产）');
  const jwtSecret = secret ?? 'dev-insecure-secret';
  const ttl = config.auth?.jwtTtl;
  let authProvider: AuthProvider;
  if (config.auth?.provider === 'oidc' && config.auth.oidc) {
    authProvider = new OidcAuthProvider({ store, secret: jwtSecret, ttl, config: config.auth.oidc });
    logger.info({ issuer: config.auth.oidc.issuer }, 'OIDC SSO 已启用');
  } else {
    authProvider = new LocalAuthProvider({ store, secret: jwtSecret, ttl });
  }

  // CLI 默认身份：确保默认租户存在
  await store.createTenant({ id: DEFAULT_TENANT, name: 'Default' }).catch(() => {});
  if (config.auth?.bootstrapAdmin) {
    if (authProvider instanceof LocalAuthProvider) {
      const admin = config.auth.bootstrapAdmin;
      await store.createTenant({ id: admin.tenantId, name: admin.tenantId }).catch(() => {});
      const existing = await store.getUserByUsername(admin.tenantId, admin.username);
      if (existing) {
        logger.warn({ tenantId: admin.tenantId, username: admin.username }, 'bootstrap admin already exists');
      } else {
        await authProvider.createUser(admin.tenantId, admin.username, admin.password, admin.role);
        logger.info({ tenantId: admin.tenantId, username: admin.username, role: admin.role }, 'bootstrap admin created');
      }
    } else {
      logger.warn('auth.bootstrapAdmin 仅在 local 认证模式生效，当前已忽略');
    }
  }
  const defaultContext: RequestContext = {
    tenantId: DEFAULT_TENANT,
    userId: 'cli',
    role: 'platform_admin',
  };
  modelConfig = await resolveRuntimeModelConfig(config, store, DEFAULT_TENANT);
  const model = createModel(modelConfig.id, modelConfig);

  const runtime: Runtime = {
    model,
    modelConfig,
    modelOptions,
    updateModel(next: RuntimeModelConfig) {
      runtime.model = createModel(next.id, next);
      runtime.modelConfig = { ...next };
    },
    tools,
    clusters,
    audit,
    store,
    systemExtra,
    policy,
    policyPreApproved,
    authProvider,
    jwtSecret,
    defaultContext,
    async dispose() {
      await Promise.all(
        [...desktops.values()].map((d) => d.then((h) => h.kill()).catch(() => {})),
      );
      desktops.clear();
      await sandboxes?.disposeAll();
      await warmPoolRef?.drain();
      await mcp?.close();
      await store.close();
    },
  };
  return runtime;
}
