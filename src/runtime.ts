import { logger } from './logger.js';
import { SandboxConfigSchema, type Config, type SandboxConfig } from './config/schema.js';
import { createModel, type ModelConfig as FactoryModelConfig } from './model/factory.js';
import type { ChatModel } from './model/types.js';
import { ToolRegistry } from './agent/tools.js';
import { AllowAllPolicy, OpsPolicy } from './agent/policy.js';
import type { PolicyMiddleware } from './agent/policy.js';
import { PermissionRules } from './agent/rules.js';
import { HookRunner } from './agent/hooks.js';
import { PlanApprovalState } from './agent/plan.js';
import { AgentRuntime, createConfiguredAgentRuntime } from './agent/runtime.js';
import type { DurableRunRuntime } from '@aiop/control-contracts';
import {
  InMemoryCredentialStore, createModels, type Api, type Model as PiModel, type Provider as PiProvider,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { createMysqlDurablePiRuntime } from '@aiop/pi-runtime';
import { SandboxManager, type SandboxManagerLike } from './sandbox/lifecycle.js';
import {
  SandboxRuntimeController,
  type SandboxGenerationInput,
} from './sandbox/runtime-controller.js';
import { E2bProvider } from './sandbox/e2b.js';
import { OpenSandboxProvider } from './sandbox/opensandbox.js';
import { LocalSandboxProvider } from './sandbox/local.js';
import type { SandboxProvider } from './sandbox/types.js';
import { normalizeUserHomeDir } from './sandbox/userhome.js';
import { WarmPool } from './sandbox/warmpool.js';
import { E2bDesktopProvider } from './sandbox/e2b-desktop.js';
import { LocalDesktopProvider } from './sandbox/local-desktop.js';
import { OpenSandboxDesktopProvider } from './sandbox/opensandbox-desktop.js';
import { CommandDesktopProvider } from './sandbox/command-desktop.js';
import type { DesktopHandle, DesktopProvider } from './sandbox/desktop.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxTools } from './tools/builtin.js';
import type { SpecResolver } from './sandbox/acquisition.js';
import { buildExportTool } from './tools/export.js';
import { DownloadStore } from './server/downloads.js';
import { buildSkillTools } from './tools/skill/index.js';
import { buildSandboxProfileTools } from './tools/sandbox-profiles.js';
import { buildBrowserTools } from './tools/browser.js';
import { McpManager } from './mcp/manager.js';
import { connectMcp } from './mcp/client.js';
import { SkillRegistry } from './skill/registry.js';
import { MysqlSkillMutationLock } from './skill/lock.js';
import { ClusterRegistry } from './config/clusters.js';
import { buildKubectlTool } from './tools/kubectl.js';
import { LogAuditSink } from './audit/sink.js';
import type { AuditSink } from './audit/sink.js';
import { readMysqlConfig } from './config/mysql.js';
import { createMysqlPool, createStore } from './db/index.js';
import { MysqlStore } from './db/mysql.js';
import type { LlmSettings, SandboxSettings, Store } from './db/store.js';
import {
  SandboxSettingsPersistence,
  credentialTargetForSandboxSettings,
  parseSandboxSettings,
  parseStoredSandboxSettings,
  sandboxSettingsToConfig,
  type LoadedSandboxSettings,
  type SandboxApiKeyUpdate,
} from './sandbox/settings.js';
import { createSettingsSecretBox } from './security/secret-box.js';
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
import {
  AiosTemplateCatalog,
  sandboxProfilesFromAiosCatalog,
} from './sandbox/aios-template-catalog.js';

/** 当前生效的非敏感 Sandbox 设置（默认 Key 绝不进入该结构）。 */
export type SandboxConnectionInfo = SandboxSettings;

export interface SandboxSettingsState {
  settings: SandboxSettings;
  apiKeySet: boolean;
  runtime?: {
    enabled: boolean;
    mode?: SandboxSettings['mode'];
    status?: string;
    templateCount?: number;
    lastSuccessfulRefreshAt?: string;
  };
}

export interface SandboxTemplateRefreshResult {
  changed: boolean;
  templateCount: number;
  state: SandboxSettingsState;
}

interface PreparedSandboxGeneration {
  input: SandboxGenerationInput;
}

export interface SandboxSettingsUpdate {
  settings: SandboxSettings;
  keyAction: SandboxApiKeyUpdate;
}

export interface Runtime {
  /** Agent 执行 facade；支持 Legacy 与 Pi Kernel，历史 LangGraph Run 仅供查询。 */
  agentRuntime: AgentRuntime;
  /** Pi-first durable control plane; deployments enable it while legacy callers migrate. */
  durableRunRuntime?: DurableRunRuntime;
  model: ChatModel;
  modelConfig?: RuntimeModelConfig;
  modelOptions?: RuntimeModelConfig[];
  updateModel?(config: RuntimeModelConfig): void;
  /** 当前生效的非敏感 Sandbox 设置。 */
  sandboxSettings?: SandboxConnectionInfo;
  /** 页面读取的平台级设置状态，不返回完整 Key 或密文。 */
  getSandboxSettings?(): Promise<SandboxSettingsState>;
  /** 用户主目录挂载配置：root 为允许绑定的宿主机根前缀（安全边界），mountPath 为沙箱内挂载点。 */
  userHome?: { root?: string; mountPath: string };
  /** 持久化并热应用 Sandbox 设置；新建沙箱进入新 generation，旧 handle 继续回收。 */
  updateSandbox?(update: SandboxSettingsUpdate): Promise<SandboxSettingsState>;
  tools: ToolRegistry;
  skillRegistry?: SkillRegistry;
  /** MCP server 管理器（运行期增删/重连，工具同步进 tools）。 */
  mcp?: McpManager;
  /** 稳定的会话 Sandbox facade；禁用时保留 facade 以继续回收 draining generations。 */
  sandboxes?: SandboxManagerLike;
  /** 文件下载中转（sbx__export_file 落盘 + /v1/files 能力 URL 下载）。 */
  downloads?: DownloadStore;
  /** 可供模型选择的沙箱模板/profile 列表。 */
  sandboxProfiles?: PublicSandboxProfile[];
  /** 按调用方角色过滤的当前 generation profiles。 */
  sandboxProfilesFor?(ctx: RequestContext): PublicSandboxProfile[];
  /** 重新加载当前 AIOS 模板目录，并在指纹变化时原子切换 generation。 */
  refreshSandboxTemplates?(): Promise<SandboxTemplateRefreshResult>;
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

export async function createDefaultDurableRunRuntime(
  store: Store,
  modelConfig: RuntimeModelConfig,
  systemPrompt?: string,
  enabled = false,
): Promise<DurableRunRuntime | undefined> {
  if (!enabled || !(store instanceof MysqlStore)) return undefined;
  const targetApi = modelConfig.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
  const provider = builtinProviders().find((candidate) => candidate.getModels().some((model) => model.api === targetApi));
  const template = provider?.getModels().find((model) => model.api === targetApi);
  if (!provider || !template) throw new Error(`Pi provider unavailable for protocol: ${modelConfig.protocol}`);
  const providerId = `aiop-${modelConfig.protocol}`;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(providerId, async () => ({ type: 'api_key', key: modelConfig.apiKey }));
  const models = createModels({ credentials });
  const pricing = modelConfig.pricing;
  const model: PiModel<Api> = {
    ...template,
    id: modelConfig.model,
    name: modelConfig.id,
    provider: providerId,
    baseUrl: modelConfig.baseURL,
    contextWindow: modelConfig.contextWindowTokens ?? template.contextWindow,
    cost: pricing ? {
      input: pricing.input,
      output: pricing.output,
      cacheRead: pricing.cacheRead ?? pricing.input,
      cacheWrite: pricing.cacheWrite ?? pricing.input,
    } : template.cost,
  };
  const configuredProvider: PiProvider = {
    ...provider,
    id: providerId,
    name: `AIOP ${modelConfig.protocol}`,
    baseUrl: modelConfig.baseURL,
    getModels: () => [model],
  };
  models.setProvider(configuredProvider);
  return createMysqlDurablePiRuntime({
    db: store.database(), models, model, systemPrompt,
  }).runtime;
}

/** 数据库页面设置优先；config.sandbox 仅在数据库尚无记录时作为启动 bootstrap。 */
export function resolveRuntimeSandboxConfig(
  startup: SandboxConfig | undefined,
  persisted?: SandboxSettings,
  _env: NodeJS.ProcessEnv = process.env,
): SandboxConfig | undefined {
  return persisted ? sandboxSettingsToConfig(persisted) : startup;
}

/** 组装一次运行所需的全部组件（模型/工具/策略/持久化）。 */
export async function buildRuntime(
  config: Config,
  options: {
    store?: Store;
    settingsSecretBox?: ReturnType<typeof createSettingsSecretBox>;
    durableRunRuntime?: DurableRunRuntime;
    enableDefaultDurableRuntime?: boolean;
  } = {},
): Promise<Runtime> {
  let modelConfig = defaultRuntimeModelConfig(config);
  const modelOptions: RuntimeModelConfig[] = Object.entries(config.models).map(([id, cfg]) => ({ id, ...cfg }));
  const tools = new ToolRegistry();

  // JWT 密钥（认证 token、OIDC state、下载能力 URL 共用）；缺省用开发占位。
  const jwtSecretEnv = process.env.AIOP_JWT_SECRET;
  if (!jwtSecretEnv) logger.warn('AIOP_JWT_SECRET 未设置，使用开发占位密钥（勿用于生产）');
  const jwtSecret = jwtSecretEnv ?? 'dev-insecure-secret';

  const mysqlConfig = readMysqlConfig();
  const store = options.store ?? await createStore(mysqlConfig);
  const skillMutationLock = mysqlConfig && store instanceof MysqlStore
    ? new MysqlSkillMutationLock(createMysqlPool(mysqlConfig))
    : undefined;
  if (config.skills?.requireDistributedLock && !skillMutationLock) {
    if (!options.store) await store.close();
    throw new Error('skills.requireDistributedLock requires a MySQL distributed mutation lock');
  }
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

  const sandboxController = new SandboxRuntimeController();
  const sandboxPersistence = new SandboxSettingsPersistence(store, options.settingsSecretBox ?? createSettingsSecretBox());
  let sandboxState: LoadedSandboxSettings | undefined;
  let sandboxCfg: SandboxConfig | undefined;
  let downloads: DownloadStore | undefined;
  let downloadSweepTimer: ReturnType<typeof setInterval> | undefined;
  let sandboxCatalogRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let sandboxCatalogRefreshQueued = false;
  let sandboxCatalogUnavailable = false;
  let lastSuccessfulSandboxRefreshAt: string | undefined;
  let sandboxUpdateTail: Promise<void> = Promise.resolve();
  let sandboxUpdatesClosed = false;

  const serializeSandboxUpdate = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = sandboxUpdateTail;
    let release!: () => void;
    sandboxUpdateTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const makeSandboxProvider = (cfg: SandboxConfig): SandboxProvider =>
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

  const prepareGeneration = async (cfg: SandboxConfig): Promise<PreparedSandboxGeneration> => {
    const catalogSnapshot = cfg.aios
      ? await new AiosTemplateCatalog({
          lifecycleUrl: cfg.aios.lifecycleUrl,
          apiKey: cfg.apiKey,
        }).load()
      : undefined;
    const profiles = catalogSnapshot
      ? sandboxProfilesFromAiosCatalog(catalogSnapshot.templates)
      : resolveSandboxProfiles(cfg);
    const provider = cfg.aios
      ? new E2bProvider({
          apiKey: cfg.apiKey,
          aios: {
            lifecycleUrl: cfg.aios.lifecycleUrl,
            apiKey: cfg.apiKey,
            placement: { ...cfg.aios.placement },
            allowedTemplateIds: new Set(catalogSnapshot!.templates.map((template) => template.templateId)),
          },
        })
      : makeSandboxProvider(cfg);
    let warmPool: WarmPool | undefined;
    if (cfg.warmPoolSize && !hasClusters) {
      warmPool = new WarmPool({ provider, spec: {}, size: cfg.warmPoolSize });
      void warmPool.start().catch((err) => {
        logger.warn({ err: String(err) }, 'sandbox warm pool start failed');
      });
    } else if (cfg.warmPoolSize && hasClusters) {
      logger.warn('配置了集群，warmPoolSize 被忽略（集群需专用模板）');
    }
    const skillSandboxEnv = config.skills?.sandboxEnv;
    const userHomeMountPath = cfg.userHomeMountPath ?? '/home/user/host';
    const userHomeRoot = cfg.userHomeRoot;
    const resolver: SpecResolver = async (ctx, profileName) => {
      const role = ctx.role ?? 'user';
      const selectedProfile = profileName
        ? findSandboxProfile(profiles, profileName, role)
        : selectDefaultProfile(profiles, role);
      if (cfg.aios && !selectedProfile) throw new Error('当前身份没有可用的代码沙箱模板');
      const base = selectedProfile ? sandboxSpecForProfile(selectedProfile, ctx) : { key: ctx.sessionId };
      const spec = skillSandboxEnv ? { ...base, envs: { ...skillSandboxEnv, ...base.envs } } : base;
      if (cfg.aios || !ctx.tenantId || !ctx.userId) return spec;
      const user = await store.getUser(ctx.tenantId, ctx.userId).catch(() => undefined);
      if (!user?.homeDir) return spec;
      try {
        const homeDir = normalizeUserHomeDir(user.homeDir, userHomeRoot);
        return {
          ...spec,
          volumes: [{ name: 'user-home', hostPath: homeDir, mountPath: userHomeMountPath }],
          envs: { ...spec.envs, AIOP_USER_HOME: userHomeMountPath },
        };
      } catch (err) {
        logger.warn({ userId: ctx.userId, err: String(err) }, 'user home dir rejected, skip mount');
        return spec;
      }
    };

    const manager = new SandboxManager({
      provider,
      idleMs: cfg.idleMs,
      timeoutMs: cfg.timeoutMs,
      warmPool,
    });
    let resolveDesktop: SandboxGenerationInput['resolveDesktop'];
    if (cfg.aios && profiles.some((profile) => profile.envType === 'browser')) {
      const dp = new CommandDesktopProvider(manager);
      resolveDesktop = async (ctx) => {
        const profile = selectBrowserProfile(profiles, ctx.role ?? 'user');
        if (!profile) throw new Error('当前身份没有可用的浏览器沙箱模板');
        const spec = sandboxSpecForProfile(profile, ctx);
        return { key: spec.key, create: () => dp.create(spec) };
      };
    } else if (cfg.desktop) {
      const dp: DesktopProvider = cfg.provider === 'local'
        ? new LocalDesktopProvider()
        : cfg.provider === 'opensandbox'
          ? new OpenSandboxDesktopProvider(manager)
          : new E2bDesktopProvider({ apiKey: cfg.apiKey, domain: cfg.domain });
      resolveDesktop = async (ctx) => {
        const profile = selectBrowserProfile(
          profiles,
          ctx.role ?? 'user',
          { fallbackToCode: true },
        ) ?? findSandboxProfile(profiles, undefined, ctx.role ?? 'user');
        const spec = sandboxSpecForProfile(profile, ctx);
        return { key: spec.key, create: () => dp.create(spec) };
      };
    }
    return {
      input: {
        manager,
        profiles,
        ...(catalogSnapshot ? {
          catalog: {
            fingerprint: catalogSnapshot.fingerprint,
            templateCount: catalogSnapshot.templates.length,
            loadedAt: catalogSnapshot.loadedAt,
          },
        } : {}),
        resolveSpec: resolver,
        sweepMs: Math.max(30_000, Math.min(cfg.idleMs ?? 10 * 60_000, 60_000)),
        ...(warmPool ? { drainWarmPool: () => warmPool.drain() } : {}),
        disposePrepared: async () => {
          await warmPool?.drain();
          await manager.disposeAll();
        },
        ...(resolveDesktop ? { resolveDesktop } : {}),
      },
    };
  };

  const disposePreparedGeneration = async (
    prepared: PreparedSandboxGeneration | undefined,
    message: string,
  ): Promise<void> => {
    await Promise.resolve()
      .then(() => prepared?.input.disposePrepared?.())
      .catch((err) => logger.warn({ err: String(err) }, message));
  };

  let sandboxLoadError: Error | undefined;
  try {
    const persistedSandbox = await sandboxPersistence.load();
    if (persistedSandbox) {
      sandboxState = persistedSandbox;
      sandboxCfg = sandboxSettingsToConfig(persistedSandbox.settings, persistedSandbox.apiKey);
    } else if (config.sandbox) {
      sandboxCfg = SandboxConfigSchema.parse(config.sandbox);
      const bootstrap = parseStoredSandboxSettings(config.sandbox as unknown as Record<string, unknown>);
      sandboxState = await sandboxPersistence.save(
        bootstrap.settings,
        config.sandbox.apiKey ? { action: 'replace', apiKey: config.sandbox.apiKey } : { action: 'retain' },
      );
    } else {
      sandboxState = { settings: { enabled: false, mode: 'local' }, apiKeySet: false };
    }
  } catch (err) {
    sandboxLoadError = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: sandboxLoadError.message }, 'persisted sandbox settings unavailable');
    const persistedRecord = await store.getSandboxSettingsRecord({ tenantId: DEFAULT_TENANT }).catch(() => undefined);
    if (persistedRecord) {
      sandboxState = {
        settings: persistedRecord.settings,
        apiKeySet: Boolean(persistedRecord.encryptedApiKey || persistedRecord.legacyApiKey),
      };
    } else {
      sandboxState = { settings: { enabled: false, mode: 'local' }, apiKeySet: false };
    }
    sandboxCfg = undefined;
  }
  if (sandboxCfg?.enabled) {
    try {
      const prepared = await prepareGeneration(sandboxCfg);
      await sandboxController.commit(prepared.input);
      lastSuccessfulSandboxRefreshAt = prepared.input.catalog?.loadedAt;
    } catch (err) {
      if (!sandboxCfg.aios) throw err;
      sandboxCatalogUnavailable = true;
      logger.warn({ err: String(err) }, 'AIOS template catalog unavailable at startup');
    }
  }

  let skillSyncTool: ReturnType<typeof buildSkillTools>[number] | undefined;
  const SANDBOX_TOOL_NAMES = [
    'sbx__run_code', 'sbx__run_command', 'sandbox_list_profiles', 'sandbox_ensure',
    'sandbox_run_code', 'sandbox_run_command', 'sbx__export_file', 'kubectl',
    'desktop_stream_url', 'browser_navigate', 'browser_click', 'browser_type',
    'browser_current_url', 'browser_screenshot', 'skill__sync_to_sandbox',
  ] as const;
  const syncSandboxTools = () => {
    for (const name of SANDBOX_TOOL_NAMES) tools.unregister(name);
    if (!sandboxController.enabled()) return;
    const codeEnabled = sandboxController.codeEnabled();
    if (codeEnabled) {
      for (const tool of buildSandboxTools(sandboxController)) tools.register(tool, 'sandbox');
    }
    const profileTools = buildSandboxProfileTools(
      sandboxController,
      (ctx) => sandboxController.profileDefinitions({ role: ctx.role ?? 'user' }),
    );
    for (const tool of codeEnabled
      ? profileTools
      : profileTools.filter((tool) => tool.def.name === 'sandbox_list_profiles')) {
      tools.register(tool, 'sandbox');
    }
    if (codeEnabled && downloads) {
      tools.register(buildExportTool(sandboxController, async () => ({}), downloads), 'sandbox');
    }
    if (codeEnabled && hasClusters && !sandboxCfg?.aios) {
      tools.register(buildKubectlTool({ clusters, sandboxes: sandboxController, audit }), 'sandbox');
    }
    if (sandboxController.desktopEnabled()) {
      for (const tool of buildBrowserTools((ctx) => sandboxController.desktop(ctx))) tools.register(tool, 'sandbox');
    }
    if (codeEnabled && skillSyncTool) tools.register(skillSyncTool, 'sandbox');
  };

  if (config.downloads?.enabled ?? true) {
    downloads = new DownloadStore({
      dir: config.downloads?.dir ?? join(tmpdir(), 'aiop-downloads'),
      secret: jwtSecret,
      maxBytes: config.downloads?.maxBytes,
      ttlMs: config.downloads?.ttlMs,
    });
    downloadSweepTimer = setInterval(() => {
      void downloads?.sweep().catch((err) => logger.warn({ err: String(err) }, 'download sweep failed'));
    }, 60 * 60_000);
    downloadSweepTimer.unref?.();
  }
  syncSandboxTools();

  // MCP：持久化配置（UI 增删的结果）优先于 config.jsonc；常驻 manager 以支持运行期管理。
  const persistedMcp = await store.getMcpServers({ tenantId: DEFAULT_TENANT }).catch(() => undefined);
  const mcp = new McpManager(persistedMcp ?? config.mcpServers ?? {}, connectMcp);
  await mcp.start();
  for (const t of mcp.tools()) tools.register(t, 'mcp');

  for (const t of buildScheduleTools(store)) tools.register(t);
  tools.register(buildTodoTool());
  tools.register(buildAskUserTool());
  tools.register(buildChangePlanTool());
  if (config.webFetch?.enabled ?? true) {
    tools.register(buildWebFetchTool({
      allowedDomains: config.webFetch?.allowedDomains,
      allowPrivate: config.webFetch?.allowPrivate,
      timeoutMs: config.webFetch?.timeoutMs,
    }));
  }

  const credentials = new UserCredentials(store, jwtSecret);
  let systemExtra = '';
  let skillRegistry: SkillRegistry | undefined;
  if (config.skills?.dir) {
    const skills = new SkillRegistry(config.skills.dir, {
      summaryBudget: config.skills.summaryBudget,
      builtinRoots: config.skills.builtinDir ? [config.skills.builtinDir] : [],
      mutationLock: skillMutationLock,
    });
    await skills.scan();
    const skillTools = buildSkillTools(skills, sandboxController, undefined, { credentials, audit });
    for (const tool of skillTools) tools.register(tool);
    skillSyncTool = skillTools.find((tool) => tool.def.name === 'skill__sync_to_sandbox');
    if (!sandboxController.codeEnabled()) tools.unregister('skill__sync_to_sandbox');
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
  const durableRunRuntime = options.durableRunRuntime
    ?? await createDefaultDurableRunRuntime(store, modelConfig, systemExtra, options.enableDefaultDurableRuntime);
  const publicSandboxState = (): SandboxSettingsState => {
    const catalog = sandboxController.catalogInfo();
    return {
      settings: sandboxState?.settings ?? { enabled: false, mode: 'local' },
      apiKeySet: sandboxState?.apiKeySet ?? false,
      runtime: {
        enabled: sandboxController.enabled(),
        mode: sandboxState?.settings.mode,
        status: sandboxLoadError
          ? 'credentials_reconfiguration_required'
          : sandboxCatalogUnavailable
            ? 'catalog_unavailable'
            : sandboxController.enabled()
              ? 'active'
              : 'disabled',
        ...(sandboxState?.settings.mode === 'aios_lifecycle'
          ? { templateCount: catalog?.templateCount ?? 0 }
          : {}),
        ...(lastSuccessfulSandboxRefreshAt
          ? { lastSuccessfulRefreshAt: lastSuccessfulSandboxRefreshAt }
          : {}),
      },
    };
  };

  const clearSandboxCatalogRefreshTimer = () => {
    if (!sandboxCatalogRefreshTimer) return;
    clearInterval(sandboxCatalogRefreshTimer);
    sandboxCatalogRefreshTimer = undefined;
  };

  const refreshSandboxTemplatesInternal = () => serializeSandboxUpdate(async (): Promise<SandboxTemplateRefreshResult> => {
    if (sandboxUpdatesClosed) throw new Error('runtime is disposed');
    const currentState = sandboxState;
    if (!currentState?.settings.enabled || currentState.settings.mode !== 'aios_lifecycle') {
      throw new Error('AIOS Sandbox 模式未启用');
    }
    if (sandboxLoadError && currentState.apiKeySet) {
      throw new Error('设置凭据无法解密，请重新配置 API key');
    }
    const currentTarget = credentialTargetForSandboxSettings(currentState.settings);
    const currentCfg = sandboxSettingsToConfig(currentState.settings, currentState.apiKey);
    const prepared = await prepareGeneration(currentCfg);
    let committed = false;
    try {
      if (
        !sandboxState
        || credentialTargetForSandboxSettings(sandboxState.settings) !== currentTarget
        || sandboxState.apiKey !== currentState.apiKey
      ) {
        throw new Error('Sandbox 凭据目标已变化，请重试模板刷新');
      }
      const nextCatalog = prepared.input.catalog;
      if (!nextCatalog) throw new Error('AIOS template catalog metadata is missing');
      const currentCatalog = sandboxController.catalogInfo();
      if (currentCatalog?.fingerprint === nextCatalog.fingerprint) {
        await disposePreparedGeneration(prepared, 'unchanged sandbox generation cleanup failed');
        sandboxCatalogUnavailable = false;
        lastSuccessfulSandboxRefreshAt = nextCatalog.loadedAt;
        return {
          changed: false,
          templateCount: nextCatalog.templateCount,
          state: publicSandboxState(),
        };
      }
      await sandboxController.commit(prepared.input);
      committed = true;
      sandboxCatalogUnavailable = false;
      lastSuccessfulSandboxRefreshAt = nextCatalog.loadedAt;
      runtime.sandboxProfiles = sandboxController.profiles();
      syncSandboxTools();
      return {
        changed: true,
        templateCount: nextCatalog.templateCount,
        state: publicSandboxState(),
      };
    } catch (err) {
      if (!committed) {
        await disposePreparedGeneration(prepared, 'prepared sandbox generation cleanup failed after refresh');
      }
      throw err;
    }
  });

  const syncSandboxCatalogRefreshTimer = () => {
    clearSandboxCatalogRefreshTimer();
    sandboxCatalogRefreshQueued = false;
    if (!sandboxState?.settings.enabled || sandboxState.settings.mode !== 'aios_lifecycle') return;
    sandboxCatalogRefreshTimer = setInterval(() => {
      if (sandboxCatalogRefreshQueued) return;
      sandboxCatalogRefreshQueued = true;
      void refreshSandboxTemplatesInternal()
        .catch((err) => {
          logger.warn({ err: String(err) }, 'AIOS template catalog background refresh failed');
        })
        .finally(() => { sandboxCatalogRefreshQueued = false; });
    }, 60_000);
    sandboxCatalogRefreshTimer.unref?.();
  };

  const runtime: Runtime = {
    agentRuntime: createConfiguredAgentRuntime(process.env, {
      bindingStore: store,
      runStore: store,
      runtimeStore: store.agentRuntimeStore(),
    }),
    durableRunRuntime,
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
    sandboxes: sandboxController,
    sandboxSettings: sandboxState.settings,
    async getSandboxSettings() {
      return publicSandboxState();
    },
    userHome: sandboxCfg && !sandboxCfg.aios
      ? { root: sandboxCfg.userHomeRoot, mountPath: sandboxCfg.userHomeMountPath ?? '/home/user/host' }
      : undefined,
    downloads,
    sandboxProfiles: sandboxController.profiles(),
    sandboxProfilesFor(ctx: RequestContext) {
      return sandboxController.profiles(ctx);
    },
    refreshSandboxTemplates() {
      return refreshSandboxTemplatesInternal();
    },
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
    async updateSandbox(update: SandboxSettingsUpdate) {
      if (sandboxUpdatesClosed) throw new Error('runtime is disposed');
      return serializeSandboxUpdate(async () => {
        if (sandboxUpdatesClosed) throw new Error('runtime is disposed');
        const settings = parseSandboxSettings(update.settings);
        let effectiveApiKey: string | undefined;
        if (update.keyAction.action === 'replace') {
          effectiveApiKey = update.keyAction.apiKey.trim();
        } else if (update.keyAction.action === 'retain') {
          if (sandboxLoadError && sandboxState?.apiKeySet) {
            throw new Error('设置凭据无法解密，请重新配置 API key');
          }
          if (sandboxState?.apiKey) {
            if (credentialTargetForSandboxSettings(sandboxState.settings) !== credentialTargetForSandboxSettings(settings)) {
              throw new Error('Sandbox 凭据目标已变化，请重新输入或清除 API key');
            }
            effectiveApiKey = sandboxState.apiKey;
          }
        }
        const nextCfg = sandboxSettingsToConfig(settings, effectiveApiKey);
        const prepared = nextCfg.enabled ? await prepareGeneration(nextCfg) : undefined;
        let saved: LoadedSandboxSettings;
        try {
          saved = await sandboxPersistence.save(settings, update.keyAction);
        } catch (err) {
          await disposePreparedGeneration(
            prepared,
            'prepared sandbox generation cleanup failed',
          );
          throw err;
        }
        try {
          await sandboxController.commit(prepared?.input);
        } catch (err) {
          await disposePreparedGeneration(
            prepared,
            'prepared sandbox generation cleanup failed after commit error',
          );
          throw err;
        }
        sandboxState = saved;
        sandboxCfg = nextCfg;
        sandboxLoadError = undefined;
        sandboxCatalogUnavailable = false;
        lastSuccessfulSandboxRefreshAt = prepared?.input.catalog?.loadedAt;
        runtime.sandboxSettings = saved.settings;
        runtime.sandboxProfiles = sandboxController.profiles();
        runtime.userHome = nextCfg.enabled && !nextCfg.aios
          ? { root: nextCfg.userHomeRoot, mountPath: nextCfg.userHomeMountPath ?? '/home/user/host' }
          : undefined;
        syncSandboxTools();
        syncSandboxCatalogRefreshTimer();
        return publicSandboxState();
      });
    },
    async dispose() {
      sandboxUpdatesClosed = true;
      clearSandboxCatalogRefreshTimer();
      if (downloadSweepTimer) clearInterval(downloadSweepTimer);
      await sandboxUpdateTail;
      await sandboxController.disposeAll();
      await mcp?.close();
      await skillMutationLock?.close?.();
      if (!options.store) await store.close();
    },
  };

  syncSandboxCatalogRefreshTimer();
  return runtime;
}
