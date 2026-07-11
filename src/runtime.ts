import { logger } from './logger.js';
import type { Config } from './config/schema.js';
import { createModel, type ModelConfig as FactoryModelConfig } from './model/factory.js';
import type { ChatModel } from './model/types.js';
import { ToolRegistry } from './agent/tools.js';
import { AllowAllPolicy, OpsPolicy } from './agent/policy.js';
import type { PolicyMiddleware } from './agent/policy.js';
import { PermissionRules } from './agent/rules.js';
import { HookRunner } from './agent/hooks.js';
import { PlanApprovalState } from './agent/plan.js';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxTools } from './tools/builtin.js';
import type { SpecResolver } from './tools/builtin.js';
import { buildExportTool } from './tools/export.js';
import { DownloadStore } from './server/downloads.js';
import { buildSkillTools } from './tools/skill.js';
import { buildSandboxProfileTools } from './tools/sandbox-profiles.js';
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
import type { LlmSettings, SandboxSettings, Store } from './db/store.js';
import { buildScheduleTools } from './tools/schedule.js';
import { buildTodoTool } from './tools/todo.js';
import { buildWebFetchTool } from './tools/webfetch.js';
import { buildAskUserTool } from './tools/ask-user.js';
import { buildChangePlanTool } from './tools/change-plan.js';
import {
  findSandboxProfile,
  publicSandboxProfiles,
  resolveSandboxProfiles,
  sandboxSpecForProfile,
  selectBrowserProfile,
  selectDefaultProfile,
} from './sandbox/profiles.js';
import type { PublicSandboxProfile, SandboxProfile } from './sandbox/profiles.js';
import { LocalAuthProvider } from './auth/local.js';
import { OidcAuthProvider } from './auth/oidc.js';
import { AiosAuthProvider } from './auth/aios.js';
import { UserCredentials } from './auth/credentials.js';
import type { AuthProvider } from './auth/provider.js';
import type { RequestContext } from './auth/types.js';

/** 当前生效的沙箱服务端连接配置（设置页展示 / 保存）。 */
export interface SandboxConnectionInfo extends SandboxSettings {
  enabled: boolean;
  provider: 'local' | 'e2b' | 'opensandbox';
}

export interface Runtime {
  model: ChatModel;
  modelConfig?: RuntimeModelConfig;
  modelOptions?: RuntimeModelConfig[];
  updateModel?(config: RuntimeModelConfig): void;
  /** 当前生效的沙箱服务端连接配置。 */
  sandboxSettings?: SandboxConnectionInfo;
  /** 运行期应用新的沙箱连接配置（新建沙箱走新后端；已存在沙箱不受影响）。 */
  updateSandbox?(settings: SandboxSettings): void;
  tools: ToolRegistry;
  skillRegistry?: SkillRegistry;
  /** MCP server 管理器（运行期增删/重连，工具同步进 tools）。 */
  mcp?: McpManager;
  /** 会话沙箱管理器（按会话/集群复用、空闲 GC、会话关闭销毁）。 */
  sandboxes?: SandboxManager;
  /** 文件下载中转（sbx__export_file 落盘 + /v1/files 能力 URL 下载）。 */
  downloads?: DownloadStore;
  /** 可供模型选择的沙箱模板/profile 列表。 */
  sandboxProfiles?: PublicSandboxProfile[];
  clusters: ClusterRegistry;
  audit: AuditSink;
  store: Store;
  systemExtra: string;
  /** 基础策略（交互场景，生产变更需审批）。 */
  policy: PolicyMiddleware;
  /** 无人值守策略（定时任务 preApproved 时使用）。 */
  policyPreApproved: PolicyMiddleware;
  /** 工具权限规则引擎（用于注入模型前剥离被无条件 deny 的工具）。 */
  permissionRules: PermissionRules;
  /** PreToolUse 钩子运行器（外部系统联动 / 合规拦截）。 */
  hooks: HookRunner;
  /** 变更计划审批状态（会话内批准后生产变更批量放行）。 */
  planState: PlanApprovalState;
  /** 本地认证提供方（登录 / token 校验）。 */
  authProvider: AuthProvider;
  /** AIOS 嵌入登录（token exchange）；配置 auth.aios 后启用，与 authProvider 并存。 */
  aiosAuth?: AiosAuthProvider;
  /** 用户下游平台凭据缓存（加密存储；exchange 写入、技能同步时按用户注入）。 */
  credentials: UserCredentials;
  /** 允许嵌入 aiop 的宿主 origin（CSP frame-ancestors）；未配置时仅允许同源。 */
  frameAncestors?: string[];
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

  // JWT 密钥（认证 token、OIDC state、下载能力 URL 共用）；缺省用开发占位。
  const jwtSecretEnv = process.env.AIOP_JWT_SECRET;
  if (!jwtSecretEnv) logger.warn('AIOP_JWT_SECRET 未设置，使用开发占位密钥（勿用于生产）');
  const jwtSecret = jwtSecretEnv ?? 'dev-insecure-secret';

  const store = await createStore(readMysqlConfig());
  const logSink = new LogAuditSink();
  const audit: AuditSink = {
    async record(e) {
      await Promise.all([logSink.record(e), store.record(e)]);
    },
  };

  const clusters = new ClusterRegistry(config.clusters);
  const hasClusters = clusters.list().length > 0;
  const permissionRules = new PermissionRules(config.permissions);
  const hooks = new HookRunner(config.hooks, { allowPrivateWebhook: config.hooks?.allowPrivateWebhook });
  const planState = new PlanApprovalState();
  // 有集群，或配置了权限规则时启用 OpsPolicy（规则覆盖所有工具，不止 kubectl）。
  const useOpsPolicy = hasClusters || !permissionRules.empty;
  const policy: PolicyMiddleware = useOpsPolicy
    ? new OpsPolicy({ clusters, audit, rules: permissionRules, planState })
    : new AllowAllPolicy();
  const policyPreApproved: PolicyMiddleware = useOpsPolicy
    ? new OpsPolicy({ clusters, audit, preApproved: true, rules: permissionRules, planState })
    : new AllowAllPolicy();

  let sandboxes: SandboxManager | undefined;
  let sandboxProfiles: SandboxProfile[] = [];
  let sessionSandboxResolver: SpecResolver | undefined;
  let warmPoolRef: WarmPool | undefined;
  let sandboxSweepTimer: ReturnType<typeof setInterval> | undefined;
  let downloads: DownloadStore | undefined;
  let downloadSweepTimer: ReturnType<typeof setInterval> | undefined;
  const desktops = new Map<string, Promise<DesktopHandle>>();
  // 设置页保存的沙箱连接配置优先于 config.jsonc（仅覆盖连接字段；是否启用仍由文件配置决定）。
  const persistedSandbox = await store.getSandboxSettings({ tenantId: DEFAULT_TENANT }).catch(() => undefined);
  const sandboxCfg = config.sandbox ? { ...config.sandbox, ...persistedSandbox } : undefined;
  const makeSandboxProvider = (cfg: SandboxSettings & { provider: 'local' | 'e2b' | 'opensandbox' }): SandboxProvider =>
    cfg.provider === 'local'
      ? new LocalSandboxProvider()
      : cfg.provider === 'opensandbox'
      ? new OpenSandboxProvider({
          domain: cfg.domain,
          protocol: cfg.protocol,
          apiKey: cfg.apiKey,
          defaultImage: cfg.defaultImage,
        })
      : new E2bProvider({ apiKey: cfg.apiKey, domain: cfg.domain });
  if (sandboxCfg?.enabled) {
    sandboxProfiles = resolveSandboxProfiles(sandboxCfg);
    const provider = makeSandboxProvider(sandboxCfg);
    logger.info({ provider: sandboxCfg.provider, profiles: sandboxProfiles.map((profile) => profile.name) }, 'sandbox provider selected');

    // 预热池：仅在未配置集群时启用（集群需专用模板，避免发错沙箱）
    let warmPool: WarmPool | undefined;
    if (sandboxCfg.warmPoolSize && !hasClusters) {
      warmPool = new WarmPool({ provider, spec: {}, size: sandboxCfg.warmPoolSize });
      await warmPool.start();
      warmPoolRef = warmPool;
      logger.info({ size: sandboxCfg.warmPoolSize }, 'sandbox warm pool ready');
    } else if (sandboxCfg.warmPoolSize && hasClusters) {
      logger.warn('配置了集群，warmPoolSize 被忽略（集群需专用模板）');
    }

    sandboxes = new SandboxManager({
      provider,
      idleMs: sandboxCfg.idleMs,
      timeoutMs: sandboxCfg.timeoutMs,
      warmPool,
    });
    // 空闲 GC：周期性 sweep() 回收空闲超 idleMs 的沙箱（最长每分钟检一次）。
    const sweepMs = Math.max(30_000, Math.min(sandboxCfg.idleMs ?? 10 * 60_000, 60_000));
    const sweeper = sandboxes;
    sandboxSweepTimer = setInterval(() => {
      void sweeper.sweep().catch((err) => logger.warn({ err: String(err) }, 'sandbox sweep failed'));
    }, sweepMs);
    sandboxSweepTimer.unref?.();
    const defaultProfile = selectDefaultProfile(sandboxProfiles);
    // skills.sandboxEnv：管理员配置的稳定环境信息（如 AIOS_BASE_URL），注入会话沙箱环境变量。
    const skillSandboxEnv = config.skills?.sandboxEnv;
    const defaultResolver: SpecResolver = (ctx) => {
      const spec = defaultProfile ? sandboxSpecForProfile(defaultProfile, ctx) : { key: ctx.sessionId };
      return skillSandboxEnv ? { ...spec, envs: { ...skillSandboxEnv, ...spec.envs } } : spec;
    };
    sessionSandboxResolver = defaultResolver;
    for (const t of buildSandboxTools(sandboxes, defaultResolver)) tools.register(t);
    for (const t of buildSandboxProfileTools(sandboxes, sandboxProfiles)) tools.register(t);
    logger.info({ sweepMs }, 'sandbox tools enabled');

    // 文件导出 / 下载：把沙箱内生成的文件落到中转目录并签发能力 URL 供用户下载。
    if (config.downloads?.enabled ?? true) {
      downloads = new DownloadStore({
        dir: config.downloads?.dir ?? join(tmpdir(), 'aiop-downloads'),
        secret: jwtSecret,
        maxBytes: config.downloads?.maxBytes,
        ttlMs: config.downloads?.ttlMs,
      });
      tools.register(buildExportTool(sandboxes, defaultResolver, downloads));
      // 周期清理过期落盘文件（每小时一次）。
      const dl = downloads;
      downloadSweepTimer = setInterval(() => {
        void dl.sweep().catch((err) => logger.warn({ err: String(err) }, 'download sweep failed'));
      }, 60 * 60_000);
      downloadSweepTimer.unref?.();
      logger.info('file export/download enabled');
    }
    if (hasClusters) {
      tools.register(buildKubectlTool({ clusters, sandboxes, audit }));
      logger.info({ clusters: clusters.names() }, 'kubectl tool enabled');
    }

    // 桌面 / 浏览器工具：opensandbox 复用同一会话沙箱；local/e2b 保持各自后端。
    if (sandboxCfg.desktop) {
      const browserProfile = selectBrowserProfile(sandboxProfiles);
      const dp: DesktopProvider = sandboxCfg.provider === 'local'
        ? new LocalDesktopProvider()
        : sandboxCfg.provider === 'opensandbox'
          ? new OpenSandboxDesktopProvider(sandboxes)
          : new E2bDesktopProvider({ apiKey: sandboxCfg.apiKey, domain: sandboxCfg.domain });
      const resolve = (ctx: { sessionId: string }): Promise<DesktopHandle> => {
        const profile = browserProfile ?? findSandboxProfile(sandboxProfiles);
        const spec = sandboxSpecForProfile(profile, ctx);
        let d = desktops.get(spec.key);
        if (!d) {
          d = dp.create(spec);
          desktops.set(spec.key, d);
        }
        return d;
      };
      for (const t of buildBrowserTools(resolve)) tools.register(t);
      logger.info('desktop/browser tools enabled');
    }
  }

  // MCP：持久化配置（UI 增删的结果）优先于 config.jsonc；常驻 manager 以支持运行期管理。
  const persistedMcp = await store.getMcpServers({ tenantId: DEFAULT_TENANT }).catch(() => undefined);
  const mcp = new McpManager(persistedMcp ?? config.mcpServers ?? {}, connectMcp);
  await mcp.start();
  for (const t of mcp.tools()) tools.register(t);

  // 定时任务工具（持久化已就绪）
  for (const t of buildScheduleTools(store)) tools.register(t);

  // TodoWrite：长任务进度清单（前端实时渲染）
  tools.register(buildTodoTool());

  // ask_user：运行中向用户提结构化选择题（需交互端；无交互端时工具自返回提示）
  tools.register(buildAskUserTool());

  // submit_change_plan：生产变更前提交结构化方案审批（需交互端）
  tools.register(buildChangePlanTool());

  // WebFetch：抓取网页内容（域名白名单 + SSRF 防护）；默认启用
  if (config.webFetch?.enabled ?? true) {
    tools.register(buildWebFetchTool({
      allowedDomains: config.webFetch?.allowedDomains,
      allowPrivate: config.webFetch?.allowPrivate,
      timeoutMs: config.webFetch?.timeoutMs,
    }));
  }

  // 用户下游凭据缓存（AES-GCM 加密后交给 Store；exchange 写入、技能同步按用户注入）
  const credentials = new UserCredentials(store, jwtSecret);

  let systemExtra = '';
  let skillRegistry: SkillRegistry | undefined;
  if (config.skills?.dir) {
    const skills = new SkillRegistry(config.skills.dir, { summaryBudget: config.skills.summaryBudget });
    await skills.scan();
    for (const t of buildSkillTools(skills, sandboxes, sessionSandboxResolver, { credentials, audit })) tools.register(t);
    skillRegistry = skills;
    systemExtra = skills.summaries();
  }

  // 认证：本地或 OIDC（复用上方派生的 jwtSecret）
  const ttl = config.auth?.jwtTtl;
  let authProvider: AuthProvider;
  if (config.auth?.provider === 'oidc' && config.auth.oidc) {
    authProvider = new OidcAuthProvider({ store, secret: jwtSecret, ttl, config: config.auth.oidc });
    logger.info({ issuer: config.auth.oidc.issuer }, 'OIDC SSO 已启用');
  } else {
    authProvider = new LocalAuthProvider({ store, secret: jwtSecret, ttl });
  }
  // AIOS 嵌入登录：与 local/oidc 并存的第三种登录方式（aiop 用户体系不依赖它，可独立部署）。
  let aiosAuth: AiosAuthProvider | undefined;
  if (config.auth?.aios) {
    aiosAuth = new AiosAuthProvider({ store, secret: jwtSecret, ttl, config: config.auth.aios, credentials });
    logger.info({ verify: config.auth.aios.verify }, 'AIOS 嵌入登录已启用');
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
    skillRegistry,
    mcp,
    sandboxes,
    sandboxSettings: sandboxCfg
      ? {
          enabled: sandboxCfg.enabled,
          provider: sandboxCfg.provider,
          domain: sandboxCfg.domain,
          protocol: sandboxCfg.protocol,
          apiKey: sandboxCfg.apiKey,
          defaultImage: sandboxCfg.defaultImage,
        }
      : { enabled: false, provider: 'e2b' },
    downloads,
    sandboxProfiles: publicSandboxProfiles(sandboxProfiles),
    clusters,
    audit,
    store,
    systemExtra,
    policy,
    policyPreApproved,
    permissionRules,
    hooks,
    planState,
    authProvider,
    aiosAuth,
    credentials,
    frameAncestors: config.auth?.aios?.allowedParentOrigins,
    jwtSecret,
    defaultContext,
    async dispose() {
      if (sandboxSweepTimer) clearInterval(sandboxSweepTimer);
      if (downloadSweepTimer) clearInterval(downloadSweepTimer);
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
  if (sandboxes) {
    const manager = sandboxes;
    runtime.updateSandbox = (next: SandboxSettings) => {
      const merged: SandboxConnectionInfo = {
        ...(runtime.sandboxSettings ?? { enabled: true, provider: 'e2b' }),
        ...next,
      };
      manager.setProvider(makeSandboxProvider(merged));
      runtime.sandboxSettings = merged;
      logger.info({ provider: merged.provider, domain: merged.domain }, 'sandbox provider updated');
    };
  }
  return runtime;
}
