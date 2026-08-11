import { logger } from './logger.js';
import { SandboxConfigSchema, type Config, type SandboxConfig } from './config/schema.js';
import { createModel, type ModelConfig as FactoryModelConfig } from './llm/factory.js';
import { llmTlsHeaders } from './llm/insecure-tls.js';
import type { ChatModel } from './llm/types.js';
import { ToolRegistry } from './agent/tools.js';
import { AllowAllPolicy, OpsPolicy } from './agent/policy.js';
import type { PolicyMiddleware } from './agent/policy.js';
import { PermissionRules } from './agent/rules.js';
import { HookRunner } from './agent/hooks.js';
import { PlanApprovalState } from './agent/plan.js';
import type {
  DurableRunRuntime,
  IdentityContext,
  ResolvedInteraction,
  RunExecutionProfile,
  ToolRuntime,
} from '@aiop/control-contracts';
import type { DurableProductRunStore, ToolLedgerApprovalClaim, ToolLedgerRepository } from '@aiop/pi-runtime';
import {
  InMemoryCredentialStore, createModels, type Api, type Model as PiModel, type Provider as PiProvider,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  bridgeGovernedTools,
  attachGovernedToolFacts,
  createMemoryDurablePiRuntime,
  createMysqlDurablePiRuntime,
  GovernedToolOutcomeError,
  FifoModelConcurrencyController,
  ResourceConcurrencyController,
  type PiSessionStore,
  type GovernedToolDefinition,
  type EventCodecOptions,
} from '@aiop/pi-runtime';
import { SandboxManager, type SandboxManagerLike } from '@aiop/sandbox-runtime';
import {
  SandboxRuntimeController,
  type SandboxGenerationInput,
} from '@aiop/sandbox-runtime';
import { E2bProvider } from '@aiop/sandbox-runtime';
import { OpenSandboxProvider } from '@aiop/sandbox-runtime';
import { LocalSandboxProvider } from '@aiop/sandbox-runtime';
import type { SandboxProvider } from '@aiop/sandbox-runtime';
import { normalizeUserHomeDir } from '@aiop/sandbox-runtime';
import { WarmPool } from '@aiop/sandbox-runtime';
import { E2bDesktopProvider } from '@aiop/sandbox-runtime';
import { LocalDesktopProvider } from '@aiop/sandbox-runtime';
import { OpenSandboxDesktopProvider } from '@aiop/sandbox-runtime';
import { CommandDesktopProvider } from '@aiop/sandbox-runtime';
import type { DesktopProvider } from '@aiop/sandbox-runtime';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxTools } from './tools/builtin.js';
import type { SpecResolver } from '@aiop/sandbox-runtime';
import { buildExportTool } from './tools/export.js';
import { DownloadStore } from './server/downloads.js';
import { buildSkillTools } from './tools/skill/index.js';
import { buildSandboxProfileTools } from './tools/sandbox-profiles.js';
import { buildBrowserTools } from './tools/browser.js';
import {
  McpManager,
  connectMcp,
  type McpCredentialProvider,
  type McpCredentials,
  type McpServerConfig,
} from '@aiop/mcp-runtime';
import { SkillRegistry } from './skill/registry.js';
import { MysqlSkillMutationLock, skillImportPermitPoolSize } from './skill/lock.js';
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
  sandboxConfigToSettings,
  sandboxSettingsToConfig,
  type LoadedSandboxSettings,
  type SandboxApiKeyUpdate,
} from '@aiop/sandbox-runtime';
import { createSettingsSecretBox } from './security/secret-box.js';
import { buildScheduleTools } from './tools/schedule.js';
import { buildTodoTool } from './tools/todo.js';
import { buildWebFetchTool } from './tools/webfetch.js';
import { buildAskUserTool } from './tools/ask-user.js';
import { buildChangePlanTool } from './tools/change-plan.js';
import {
  findSandboxProfile,
  resolveSandboxProfiles,
  sandboxSpecForProfile,
  selectBrowserProfile,
  selectDefaultProfile,
} from '@aiop/sandbox-runtime';
import type { PublicSandboxProfile } from '@aiop/sandbox-runtime';
import { LocalAuthProvider } from './auth/local.js';
import { OidcAuthProvider } from './auth/oidc.js';
import { AiosAuthProvider } from './auth/aios.js';
import { createAIOPToolRuntime } from './tools/governance.js';
import { UserCredentials } from './auth/credentials.js';
import { buildSystemPrompt } from './prompt.js';
import type { AuthProvider } from './auth/provider.js';
import { DEFAULT_MEMORY_CLI_PRINCIPAL_ID, parsePrincipalId, type RequestContext } from './auth/types.js';
import {
  AiosTemplateCatalog,
  sandboxProfilesFromAiosCatalog,
} from '@aiop/sandbox-runtime';

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
  /** 部署拓扑决定认证和离线调度门禁。 */
  deploymentMode?: 'standalone' | 'aios-integrated';
  /** 唯一 Agent 执行入口；HTTP、CLI 与 Scheduler 共享同一个 durable Pi runtime。 */
  durableRunRuntime: DurableRunRuntime;
  /** Root-lifecycle controller shared by durable and direct governed tool calls. */
  toolConcurrency: ResourceConcurrencyController;
  /** Committed Pi session entries used to rebuild product message projections. */
  piSessionStore?: PiSessionStore;
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
  /** MCP server 管理器（按请求身份解析租户隔离的 governed tools）。 */
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
  /** 无认证（仅内存 CLI）场景的默认身份；durable CLI 在执行边界解析真实用户。 */
  defaultContext: RequestContext;
  /** 请求 Scheduler 尽快处理已持久化的 Fire；未启用嵌入式 Worker 时不存在。 */
  requestSchedulerTick?(): void;
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

export function bridgeDurableGovernedTools(input: {
  definitions: readonly GovernedToolDefinition[];
  runtime: ToolRuntime;
  context: {
    identity: IdentityContext;
    runId: string;
    attemptId: string;
    turnNo: number;
    sessionId: string;
    interactionResolution?: ResolvedInteraction;
  };
}) {
  return bridgeGovernedTools(input.definitions.map((definition) => ({
    definition,
    execute: async (call, context) => {
      const outcome = await input.runtime.execute(call, {
        identity: input.context.identity,
        runId: input.context.runId,
        attemptId: input.context.attemptId,
        turnNo: input.context.turnNo,
        sessionId: input.context.sessionId,
        signal: context.signal,
        interactionResolution: input.context.interactionResolution,
      });
      if (outcome.kind === 'result') return attachGovernedToolFacts(outcome.result, outcome);
      throw new GovernedToolOutcomeError(outcome);
    },
  })));
}

export function createFencedToolLedger(
  store: DurableProductRunStore,
  current: { tenantId: string; runId: string; attemptId: string },
): ToolLedgerRepository {
  const mutate = <T>(work: (ledger: ToolLedgerRepository) => Promise<T>): Promise<T> => store.transaction(async (tx) => {
    const attempt = (await tx.attempts.list(current)).find((candidate) => candidate.attemptId === current.attemptId);
    if (!attempt || attempt.status !== 'running') throw new Error('Current durable attempt is not active');
    await tx.runs.assertLease(current, attempt.workerId, attempt.leaseToken, new Date());
    return work(tx.toolLedger);
  });
  return {
    get: (identity) => store.toolLedger.get(identity),
    list: (identity) => store.toolLedger.list(identity),
    putIfAbsent: (record) => mutate((ledger) => ledger.putIfAbsent(record)),
    update: (record) => mutate((ledger) => ledger.update(record)),
    claimPendingApproval: (input: ToolLedgerApprovalClaim) => mutate((ledger) => ledger.claimPendingApproval(input)),
  };
}

export async function createDefaultDurableRunRuntime(
  store: Store,
  modelConfig: RuntimeModelConfig,
  systemPrompt?: string,
  enabled = true,
  mcp?: McpManager,
  policy?: PolicyMiddleware,
  tools = new ToolRegistry(),
  policyPreApproved = policy,
): Promise<DurableRunRuntime> {
  return (await createDefaultDurableRunAssembly(
    store, modelConfig, systemPrompt, enabled, mcp, policy, tools, policyPreApproved,
  )).runtime;
}

export function resolveRuntimeSystemPrompt(
  systemPrompt?: string,
  execution?: RunExecutionProfile,
): string {
  return buildSystemPrompt(systemPrompt, execution?.unattended ?? false);
}

async function createDefaultDurableRunAssembly(
  store: Store,
  modelConfig: RuntimeModelConfig,
  systemPrompt?: string,
  enabled = true,
  mcp?: McpManager,
  policy?: PolicyMiddleware,
  tools = new ToolRegistry(),
  policyPreApproved = policy,
) {
  if (!enabled) throw new Error('DurableRunRuntime is mandatory and cannot be disabled');
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
    headers: { ...template.headers, ...llmTlsHeaders(modelConfig.allowInsecureTls) },
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
  const modelConcurrency = new FifoModelConcurrencyController({
    maxConcurrentPerTenantModel: positiveIntegerEnv(
      process.env.AIOP_PI_MAX_CONCURRENT_MODEL_CALLS,
      'AIOP_PI_MAX_CONCURRENT_MODEL_CALLS',
      4,
    ),
  });
  const toolConcurrency = new ResourceConcurrencyController(positiveIntegerEnv(
    process.env.AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE,
    'AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE',
    1,
  ));
  const runtimeStore = store.durableRunStore();
  const assemblyOptions = {
    models, model, modelConcurrency, systemPrompt,
    resolveSystemPrompt: ({ execution }: { execution?: RunExecutionProfile }) =>
      resolveRuntimeSystemPrompt(systemPrompt, execution),
    resolveTools: async ({ identity, sessionId, events, interactionResolution, execution }: {
      identity?: IdentityContext;
      sessionId?: string;
      events: EventCodecOptions;
      interactionResolution?: ResolvedInteraction;
      execution?: RunExecutionProfile;
    }) => {
      if (!identity) return [];
      const definitions = mcp ? await mcp.tools(identity) : [];
      const durableRun = sessionId?.startsWith('owner-')
        ? await runtimeStore.get({ tenantId: identity.tenantId, runId: events.runId })
        : undefined;
      const toolSessionId = durableRun?.sessionId ?? sessionId ?? events.runId;
      const toolContext = {
        tenantId: identity.tenantId,
        userId: identity.actorId,
        role: identity.roles.includes('platform_admin') ? 'platform_admin' as const
          : identity.roles.includes('tenant_admin') ? 'tenant_admin' as const
            : 'user' as const,
        sessionId: toolSessionId,
      };
      const productDefinitions = tools.unified(toolContext).definitions();
      const governed = createAIOPToolRuntime({
        tools,
        governedTools: definitions,
        policy: execution?.preApproved
          ? policyPreApproved ?? policy ?? new AllowAllPolicy()
          : policy ?? new AllowAllPolicy(),
        ctx: toolContext,
      }, createFencedToolLedger(runtimeStore, {
        tenantId: identity.tenantId, runId: events.runId, attemptId: events.attemptId,
      }), toolConcurrency, runtimeStore.interactions, false);
      const resolvedInteraction = interactionResolution
        ? await runtimeStore.interactions.get({
            tenantId: identity.tenantId, runId: events.runId,
            interactionId: interactionResolution.interactionId,
          })
        : undefined;
      return bridgeDurableGovernedTools({
        definitions: [...productDefinitions, ...definitions],
        runtime: governed,
        context: {
          identity,
          runId: events.runId,
          attemptId: events.attemptId,
          turnNo: events.turnNo,
          sessionId: toolSessionId,
          interactionResolution: resolvedInteraction?.status === 'resolved' && resolvedInteraction.toolCallId
            ? {
                interactionId: resolvedInteraction.id,
                kind: resolvedInteraction.kind,
                toolCallId: resolvedInteraction.toolCallId,
                value: resolvedInteraction.resolution ?? interactionResolution?.value ?? null,
              }
            : undefined,
        },
      });
    },
  };
  const assembly = store instanceof MysqlStore
    ? createMysqlDurablePiRuntime({ db: store.database(), store: runtimeStore as import('@aiop/pi-runtime').MysqlRunStore, ...assemblyOptions })
    : createMemoryDurablePiRuntime({ store: runtimeStore as import('@aiop/pi-runtime').MemoryRunStore, ...assemblyOptions });
  return { ...assembly, modelConcurrency, toolConcurrency };
}

function positiveIntegerEnv(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer: ${value}`);
  return parsed;
}

export function resolveMcpBootstrapConfigs(
  tenantId: string,
  startup: Record<string, McpServerConfig> | undefined,
  persisted: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> {
  if (persisted) return persisted;
  return tenantId === DEFAULT_TENANT ? startup ?? {} : {};
}

export function createMcpCredentialProvider(
  credentials: Pick<UserCredentials, 'get'>,
): McpCredentialProvider {
  return {
    async resolve(identity, server) {
      const stored = await credentials.get<McpCredentials>(
        identity.tenantId,
        identity.actorId,
        `mcp:${server}`,
      );
      return normalizeMcpCredentials(stored);
    },
  };
}

function normalizeMcpCredentials(value: McpCredentials | undefined): McpCredentials {
  const strings = (candidate: Record<string, string> | undefined) => candidate
    ? Object.fromEntries(Object.entries(candidate).filter((entry) => typeof entry[1] === 'string'))
    : undefined;
  const headers = strings(value?.headers);
  const env = strings(value?.env);
  return { ...(headers ? { headers } : {}), ...(env ? { env } : {}) };
}

/** 数据库页面设置优先；未保存页面设置时使用当前启动配置。 */
export function resolveRuntimeSandboxConfig(
  startup: SandboxConfig | undefined,
  persisted?: SandboxSettings,
  _env: NodeJS.ProcessEnv = process.env,
): SandboxConfig | undefined {
  return persisted ? sandboxSettingsToConfig(persisted) : startup;
}

export async function resolveCliPrincipalId(
  configured: string | undefined,
  durableMysql: boolean,
  lookup?: (userId: string) => Promise<{ status: string } | undefined>,
): Promise<string> {
  if (durableMysql && !configured) throw new Error('AIOP_CLI_USER_ID is required for durable MySQL runtime');
  const userId = parsePrincipalId(configured ?? DEFAULT_MEMORY_CLI_PRINCIPAL_ID);
  if (durableMysql) {
    const principal = await lookup?.(userId);
    if (!principal || principal.status !== 'active') {
      throw new Error('AIOP_CLI_USER_ID must identify an existing active user in the default tenant');
    }
  }
  return userId;
}

/** 组装一次运行所需的全部组件（模型/工具/策略/持久化）。 */
export async function buildRuntime(
  config: Config,
  options: {
    store?: Store;
    settingsSecretBox?: ReturnType<typeof createSettingsSecretBox>;
    durableRunRuntime?: DurableRunRuntime;
    piSessionStore?: PiSessionStore;
  } = {},
): Promise<Runtime> {
  let modelConfig = defaultRuntimeModelConfig(config);
  const modelOptions: RuntimeModelConfig[] = Object.entries(config.models).map(([id, cfg]) => ({ id, ...cfg }));
  const tools = new ToolRegistry();

  // JWT 密钥（认证 token、OIDC state、下载能力 URL 共用）；缺省用开发占位。
  const jwtSecretEnv = process.env.AIOP_JWT_SECRET;
  if (!jwtSecretEnv) logger.warn('AIOP_JWT_SECRET 未设置，使用开发占位密钥（勿用于生产）');
  const jwtSecret = jwtSecretEnv ?? 'dev-insecure-secret';

  const deploymentMode = config.deploymentMode ?? 'standalone';
  const providerKind = config.auth?.provider ?? 'local';
  const mysqlConfig = readMysqlConfig();
  const store = options.store ?? await createStore(mysqlConfig, {
    deploymentMode,
    authProvider: providerKind,
  });
  const skillMutationLock = mysqlConfig && store instanceof MysqlStore
    ? new MysqlSkillMutationLock(createMysqlPool(mysqlConfig))
    : undefined;
  const skillImportPermitLock = mysqlConfig && store instanceof MysqlStore
    ? new MysqlSkillMutationLock(createMysqlPool({
      ...mysqlConfig,
      poolSize: skillImportPermitPoolSize(mysqlConfig.poolSize),
    }))
    : undefined;
  if (config.skills?.requireDistributedLock && !skillMutationLock) {
    if (!options.store) await store.close();
    throw new Error('skills.requireDistributedLock requires a MySQL distributed mutation lock');
  }
  const initializationCleanups: Array<() => Promise<void>> = [];
  if (!options.store) initializationCleanups.push(() => store.close());
  if (skillMutationLock) initializationCleanups.push(() => skillMutationLock.close());
  if (skillImportPermitLock) initializationCleanups.push(() => skillImportPermitLock.close());
  try {
  const logSink = new LogAuditSink();
  const audit: AuditSink = {
    async record(e) {
      const enriched = { deploymentMode, ...e };
      await Promise.all([logSink.record(enriched), store.record(enriched)]);
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
  initializationCleanups.push(() => sandboxController.disposeAll());
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
      sandboxState = {
        settings: sandboxConfigToSettings(sandboxCfg),
        apiKey: sandboxCfg.apiKey,
        apiKeySet: Boolean(sandboxCfg.apiKey),
      };
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
        apiKeySet: Boolean(persistedRecord.encryptedApiKey),
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
      : profileTools.filter((tool) => tool.name === 'sandbox_list_profiles')) {
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
    const initializedDownloadSweepTimer = downloadSweepTimer;
    initializationCleanups.push(async () => clearInterval(initializedDownloadSweepTimer));
  }
  syncSandboxTools();

  const credentials = new UserCredentials(store, jwtSecret);

  // MCP：每个租户按身份加载持久化配置；未持久化时回退 config.jsonc。
  const mcp = new McpManager({}, connectMcp, {
    loadConfigs: async (identity) => resolveMcpBootstrapConfigs(
      identity.tenantId,
      config.mcpServers,
      await store.getMcpServers({ tenantId: identity.tenantId }).catch(() => undefined),
    ),
    credentials: createMcpCredentialProvider(credentials),
    audit: {
      record: (event) => audit.record({
        kind: 'mcp', action: 'tool-execute', tenantId: event.tenantId,
        tool: `mcp__${event.server}__${event.tool}`,
        detail: {
          actorId: event.actorId, server: event.server, ok: event.ok,
          durationMs: event.durationMs, ...(event.error ? { error: event.error } : {}),
        },
      }),
    },
  });
  initializationCleanups.push(() => mcp.close());

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

  let systemExtra = '';
  let skillRegistry: SkillRegistry | undefined;
  if (config.skills?.dir) {
    const skills = new SkillRegistry(config.skills.dir, {
      builtinRoots: config.skills.builtinDir ? [config.skills.builtinDir] : [],
      mutationLock: skillMutationLock,
      importPermitLock: skillImportPermitLock,
      pendingQuota: config.skills.pendingQuota,
    });
    await skills.scan();
    const skillTools = buildSkillTools(skills, sandboxController, undefined, { credentials, audit });
    for (const tool of skillTools) tools.register(tool);
    skillSyncTool = skillTools.find((tool) => tool.name === 'skill__sync_to_sandbox');
    if (!sandboxController.codeEnabled()) tools.unregister('skill__sync_to_sandbox');
    skillRegistry = skills;
  }

  // 认证 Provider 由部署模式显式决定，非法组合由 ConfigSchema 失败关闭。
  const ttl = config.auth?.jwtTtl;
  let authProvider: AuthProvider;
  let aiosAuth: AiosAuthProvider | undefined;
  if (providerKind === 'oidc') {
    if (!config.auth?.oidc) throw new Error('auth.provider=oidc requires auth.oidc');
    authProvider = new OidcAuthProvider({ store, secret: jwtSecret, ttl, config: config.auth.oidc });
    logger.info({ issuer: config.auth.oidc.issuer }, 'OIDC SSO 已启用');
  } else if (providerKind === 'aios') {
    if (!config.auth?.aios) throw new Error('auth.provider=aios requires auth.aios');
    aiosAuth = new AiosAuthProvider({ store, secret: jwtSecret, ttl, config: config.auth.aios, credentials });
    authProvider = aiosAuth;
    logger.info({ verify: config.auth.aios.verify }, 'AIOS 主认证已启用');
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
  // Server、HTTP 与 Scheduler 不使用 CLI 主体。Durable CLI 必须在实际执行边界解析并校验真实用户。
  const defaultContext: RequestContext = {
    tenantId: DEFAULT_TENANT,
    userId: DEFAULT_MEMORY_CLI_PRINCIPAL_ID,
    role: 'platform_admin',
  };
  modelConfig = await resolveRuntimeModelConfig(config, store, DEFAULT_TENANT);
  const model = createModel(modelConfig.id, modelConfig);
  const defaultDurableAssembly = options.durableRunRuntime
    ? undefined
    : await createDefaultDurableRunAssembly(
      store,
      modelConfig,
      systemExtra,
      true,
      mcp,
      policy,
      tools,
      policyPreApproved,
    );
  const durableRunRuntime = options.durableRunRuntime ?? defaultDurableAssembly!.runtime;
  const piSessionStore = options.piSessionStore ?? defaultDurableAssembly?.store.sessions;
  const toolConcurrency = defaultDurableAssembly?.toolConcurrency ?? new ResourceConcurrencyController(positiveIntegerEnv(
    process.env.AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE,
    'AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE',
    1,
  ));
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
    durableRunRuntime,
    toolConcurrency,
    piSessionStore,
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
    deploymentMode: config.deploymentMode ?? 'standalone',
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
        const persistenceUpdate = update.keyAction.action === 'retain' && effectiveApiKey
          ? { action: 'replace' as const, apiKey: effectiveApiKey }
          : update.keyAction;
        let saved: LoadedSandboxSettings;
        try {
          saved = await sandboxPersistence.save(settings, persistenceUpdate);
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
      await Promise.all([
        skillMutationLock?.close?.(),
        skillImportPermitLock?.close?.(),
      ]);
      if (!options.store) await store.close();
    },
  };

  syncSandboxCatalogRefreshTimer();
  return runtime;
  } catch (error) {
    for (const cleanup of initializationCleanups.reverse()) {
      await cleanup().catch((cleanupError) => {
        logger.warn({ err: String(cleanupError) }, 'runtime initialization cleanup failed');
      });
    }
    throw error;
  }
}
