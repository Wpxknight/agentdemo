import type { Msg } from '../llm/types.js';
import type { AuditEvent, AuditSink } from '../audit/sink.js';
import type { AuthProviderKind, Role, RequestContext, Tenant, User, UserStatus } from '../auth/types.js';
import type { McpServerConfig } from '@aiop/mcp-runtime';
import type { ToolResult } from '../llm/types.js';
import type { DurableProductRunStore } from '@aiop/pi-runtime';

export interface LlmSettings {
  id: string;
  protocol: 'anthropic' | 'openai';
  baseURL: string;
  apiKey: string;
  model: string;
  /** 仅该 LLM 请求跳过 HTTPS 服务端证书校验。 */
  allowInsecureTls?: boolean;
  contextWindowTokens?: number;
  /** 历史里保留图片的最近带图消息条数（更早的替换占位符），默认 1；0 表示一张不留。 */
  contextKeepImages?: number;
  /** 推理深度：none 关闭思考；low..max 对应 Anthropic effort；缺省=思考开启走模型默认深度。 */
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** 前端新建会话时的占位标题；视为“未显式命名”，首条用户消息会将其覆盖。 */
export const DEFAULT_SESSION_TITLE = '新会话';

/** 定时任务运行设置（租户级）。 */
/** 平台 Sandbox 设置：只含非敏感字段，API key 独立加密保存。 */
export interface SandboxSettings {
  enabled: boolean;
  mode: 'standard_e2b' | 'aios_lifecycle' | 'opensandbox' | 'local';
  /** E2B/OpenSandbox 域名 host[:port]。 */
  domain?: string;
  protocol?: 'http' | 'https';
  defaultImage?: string;
  /** AIOS Lifecycle API 完整 HTTP(S) URL。 */
  lifecycleUrl?: string;
  /** @deprecated 旧记录的 AIOS placement fallback。 */
  placement?: { clusterId?: string; clusterName?: string; namespace?: string };
}

/** Store 内部的 Sandbox 配置和不透明密文。 */
export interface SandboxSettingsRecord {
  settings: SandboxSettings;
  encryptedApiKey?: string;
}

export type SandboxSettingsSecretUpdate =
  | { action: 'retain' }
  | { action: 'replace'; encryptedApiKey: string }
  | { action: 'clear' };

export interface SchedulerSettings {
  /** 单次定时任务运行的最长时长（毫秒）；超时中止并记录失败。 */
  maxRunMs: number;
}

/** 定时任务单次运行的默认最长时长：4 小时。 */
export const DEFAULT_TASK_MAX_RUN_MS = 4 * 60 * 60 * 1000;

export interface SessionInput {
  sessionId: string;
  title?: string;
}

export interface SessionTouchInput {
  title?: string;
  updatedAt?: Date | string;
}

export interface SessionContextUsage {
  usedTokens: number;
  maxTokens: number;
  estimated: boolean;
}

export interface SessionTokenUsage {
  totalTokens: number;
}

export type InteractionKind = 'approval' | 'question' | 'plan';
export type InteractionStatus = 'pending' | 'resolved' | 'cancelled' | 'expired';

export interface InteractionRecord {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
  attemptId?: string;
  turnNo?: number;
  kind: InteractionKind;
  toolCallId?: string;
  payload: unknown;
  status: InteractionStatus;
  resolution?: unknown;
  resolvedBy?: string;
  expiresAt: Date;
  createdAt: Date;
  resolvedAt?: Date;
}

export type ToolExecutionStatus = 'started' | 'completed' | 'unknown' | 'recovery_required';

export interface ToolExecutionRecord {
  tenantId: string;
  runId: string;
  attemptId?: string;
  turnNo?: number;
  sessionId: string;
  toolCallId: string;
  logicalCallId?: string;
  idempotencyKey?: string;
  capability?: 'read' | 'retryable_write' | 'non_idempotent_write';
  externalCorrelationId?: string;
  resultDigest?: string;
  approvedInteractionId?: string;
  toolName: string;
  argsDigest: string;
  status: ToolExecutionStatus;
  result?: ToolResult;
  startedAt: Date;
  completedAt?: Date;
  updatedAt: Date;
}

export interface AgentRunBinding {
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
  kernel: 'pi';
  kernelVersion?: string;
  createdAt: Date;
}

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'recovery_required';

export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
}

export interface AgentRunRecord extends AgentRunBinding {
  status: AgentRunStatus;
  waitingReason?: 'approval' | 'question' | 'plan' | 'external';
  currentNode?: string;
  stepCount: number;
  usage: AgentRunUsage;
  errorMessage?: string;
  startedAt?: Date;
  updatedAt: Date;
  completedAt?: Date;
  cancelRequestedAt?: Date;
  leaseOwner?: string;
  leaseToken: number;
  leaseExpiresAt?: Date;
}

export interface AgentRunPatch {
  status?: AgentRunStatus;
  waitingReason?: AgentRunRecord['waitingReason'] | null;
  currentNode?: string | null;
  stepCount?: number;
  usage?: AgentRunUsage;
  errorMessage?: string | null;
  startedAt?: Date | null;
  updatedAt?: Date;
  completedAt?: Date | null;
  cancelRequestedAt?: Date | null;
  clearLease?: boolean;
}

export interface AgentRunFilter {
  status?: AgentRunStatus;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface AgentRunEvent {
  id?: number;
  tenantId: string;
  runId: string;
  sequence?: number;
  type: string;
  attemptId?: string;
  turnNo?: number;
  kernel?: 'pi';
  kernelVersion?: string;
  correlationId?: string;
  node?: string;
  status?: string;
  detail?: unknown;
  createdAt: Date;
}

export interface AgentRunAttemptSummary {
  attemptId: string;
  kernel: string;
  kernelVersion: string;
  status: string;
  errorCode?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface AgentRunTurnSummary {
  attemptId: string;
  turnNo: number;
  commitId: string;
  transcriptVersion: number;
  stopReason?: string;
  usage: AgentRunUsage;
  eventSequenceEnd: number;
  committedAt: Date;
}

export interface AgentRunLease {
  ownerId: string;
  token: number;
  expiresAt: Date;
}

/** 审计查询过滤（租户由 ctx 强制限定）。 */
export interface AuditFilter {
  sessionId?: string;
  kind?: string;
  limit?: number;
}

/** 新建定时任务的输入。 */
export interface ScheduledTaskInput {
  sessionId: string;
  cron: string;
  /** IANA 时区；缺省为 UTC。 */
  timezone?: string;
  /** 列表展示用的简短标题（可空，展示层回退到 task）。 */
  title?: string;
  /** 触发时下发给 agent 的任务描述（自然语言）。 */
  task: string;
  /** 无人值守预批准：触发执行时把生产变更审批降级为放行。 */
  preApproved?: boolean;
  enabled?: boolean;
}

export interface ScheduledTask {
  id: number;
  tenantId: string;
  userId: string;
  sessionId: string;
  cron: string;
  timezone: string;
  title: string;
  task: string;
  preApproved: boolean;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt?: Date;
}

/** 更新定时任务的可改字段（cron 变更时实现方需重算 nextRunAt）。 */
export interface ScheduledTaskPatch {
  cron?: string;
  /** IANA 时区；与 cron 一同决定下次执行时间。 */
  timezone?: string;
  title?: string;
  task?: string;
  preApproved?: boolean;
  enabled?: boolean;
}

export type SchedulerTriggerKind = 'cron' | 'manual';

export interface ScheduledExecution {
  fireId: string;
  runId: string;
  triggerKind: SchedulerTriggerKind;
  fireTime: Date;
  fireState: 'pending' | 'claimed' | 'bound' | 'recovering' | 'completed';
  attempts: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  run?: Pick<AgentRunRecord, 'status' | 'startedAt' | 'completedAt' | 'errorMessage' | 'stepCount' | 'usage'> | null;
}

export interface ManualFire {
  fireId: string;
  runId: string;
  state: ScheduledExecution['fireState'];
  replayed: boolean;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  lastMessage?: string;
  messageCount: number;
  updatedAt?: string;
}

/** 创建用户（含密码哈希）。 */
export interface NewUser {
  tenantId: string;
  username: string;
  role: Role;
  passwordHash: string;
  /** 登录来源，默认 local。 */
  authProvider?: AuthProviderKind;
  displayName?: string;
}

/** 含密钥的用户记录（仅登录校验内部使用）。 */
export interface UserWithSecret extends User {
  passwordHash: string;
}

/** 用户局部更新（管理与生命周期用：禁用/启用、墓碑改名、角色/展示名刷新）。 */
export interface UserPatch {
  status?: UserStatus;
  username?: string;
  role?: Role;
  displayName?: string;
  /** 绑定的主机主目录；null 表示解绑。 */
  homeDir?: string | null;
}

/** 用户下游凭据缓存记录（payload 为加密后的不透明字符串，加解密在 auth/credentials.ts）。 */
export interface UserCredentialRecord {
  payload: string;
  expiresAt?: Date;
}

/** OIDC callback 生成的一次性交换码；code 本身绝不持久化，仅保存其摘要。 */
export interface OidcExchangeCode {
  codeHash: string;
  tenantId: string;
  provider: 'oidc';
  sessionToken: string;
  browserNonceHash?: string;
  expiresAt: Date;
}

export interface OidcExchangeCodeClaim {
  codeHash: string;
  provider: 'oidc';
  /** 已知租户时必须匹配；HTTP 兑换由随机 code 唯一定位后返回记录所属租户。 */
  tenantId?: string;
  browserNonceHash?: string;
  now: Date;
}

export interface ConsumedOidcExchangeCode {
  tenantId: string;
  provider: 'oidc';
  sessionToken: string;
}

/**
 * 持久化抽象。除系统级调度、租户和用户管理方法外，
 * 业务读写均需 RequestContext 并按 tenantId 强制过滤，实现租户隔离。
 */
export interface Store extends AuditSink {
  durableRunStore(): DurableProductRunStore;
  // —— 会话消息 ——
  createSession(ctx: RequestContext, input: SessionInput): Promise<SessionSummary>;
  touchSession(ctx: RequestContext, sessionId: string, input?: SessionTouchInput): Promise<void>;
  appendMessage(ctx: RequestContext, sessionId: string, msg: Msg): Promise<void>;
  /** 批量追加消息（一次事务落库，避免中途失败留下工具配对断裂的半截轮次）。 */
  appendMessages(ctx: RequestContext, sessionId: string, msgs: Msg[]): Promise<void>;
  listMessages(ctx: RequestContext, sessionId: string): Promise<Msg[]>;
  /** 用压缩后的消息整体替换会话历史（摘要压缩落库；原子替换该会话全部消息）。 */
  replaceMessages(ctx: RequestContext, sessionId: string, messages: Msg[]): Promise<void>;
  listSessions(ctx: RequestContext, limit?: number, offset?: number): Promise<SessionSummary[]>;
  countSessions(ctx: RequestContext): Promise<number>;
  deleteSession(ctx: RequestContext, sessionId: string): Promise<boolean>;
  getSessionContextUsage(ctx: RequestContext, sessionId: string, maxTokens: number): Promise<SessionContextUsage>;
  getSessionTokenUsage(ctx: RequestContext, sessionId: string): Promise<SessionTokenUsage>;

  // —— Agent durable interaction / tool ledger ——
  putInteraction(record: InteractionRecord): Promise<void>;
  getInteraction(tenantId: string, id: string): Promise<InteractionRecord | undefined>;
  listPendingInteractions(ctx: RequestContext): Promise<InteractionRecord[]>;
  resolveInteraction(record: InteractionRecord): Promise<boolean>;
  putToolExecutionIfAbsent(record: ToolExecutionRecord): Promise<boolean>;
  getToolExecution(tenantId: string, runId: string, toolCallId: string): Promise<ToolExecutionRecord | undefined>;
  updateToolExecution(record: ToolExecutionRecord): Promise<void>;
  getAgentRunBinding(tenantId: string, runId: string): Promise<AgentRunBinding | undefined>;
  putAgentRunBindingIfAbsent(binding: AgentRunBinding): Promise<boolean>;
  getAgentRun(ctx: RequestContext, runId: string): Promise<AgentRunRecord | undefined>;
  listAgentRuns(ctx: RequestContext, filter?: AgentRunFilter): Promise<AgentRunRecord[]>;
  countAgentRuns(ctx: RequestContext, filter?: AgentRunFilter): Promise<number>;
  updateAgentRun(tenantId: string, runId: string, patch: AgentRunPatch): Promise<boolean>;
  appendAgentRunEvent(event: AgentRunEvent): Promise<void>;
  listAgentRunEvents(ctx: RequestContext, runId: string): Promise<AgentRunEvent[]>;
  listAgentRunAttempts(ctx: RequestContext, runId: string): Promise<AgentRunAttemptSummary[]>;
  listAgentRunTurns(ctx: RequestContext, runId: string): Promise<AgentRunTurnSummary[]>;
  listAgentRunInteractions(ctx: RequestContext, runId: string): Promise<InteractionRecord[]>;
  listAgentRunToolExecutions(ctx: RequestContext, runId: string): Promise<ToolExecutionRecord[]>;
  acquireAgentRunLease(
    tenantId: string, runId: string, ownerId: string, now: Date, ttlMs: number,
  ): Promise<AgentRunLease | undefined>;
  renewAgentRunLease(
    tenantId: string, runId: string, ownerId: string, token: number, now: Date, ttlMs: number,
  ): Promise<boolean>;
  assertAgentRunLease(tenantId: string, runId: string, ownerId: string, token: number, now?: Date): Promise<void>;
  releaseAgentRunLease(tenantId: string, runId: string, ownerId: string, token: number): Promise<boolean>;
  requestAgentRunCancellation(ctx: RequestContext, runId: string, now?: Date): Promise<boolean>;
  isAgentRunCancellationRequested(tenantId: string, runId: string): Promise<boolean>;

  // —— 审计 ——（record 来自 AuditSink；event.tenantId 标识归属）
  record(event: AuditEvent): Promise<void>;
  listAudit(ctx: RequestContext, filter?: AuditFilter): Promise<AuditEvent[]>;

  // —— 定时任务 ——
  createScheduledTask(ctx: RequestContext, input: ScheduledTaskInput): Promise<ScheduledTask>;
  listScheduledTasks(ctx: RequestContext): Promise<ScheduledTask[]>;
  getScheduledTask(ctx: RequestContext, id: number): Promise<ScheduledTask | undefined>;
  /** 局部更新；cron 变更时重算 nextRunAt。任务不存在（或跨租户）返回 undefined。 */
  updateScheduledTask(ctx: RequestContext, id: number, patch: ScheduledTaskPatch): Promise<ScheduledTask | undefined>;
  /** 软删除任务；保留既有执行记录。返回是否存在。 */
  deleteScheduledTask(ctx: RequestContext, id: number): Promise<boolean>;
  /** 变更任务启停状态；任务不存在（或无权限）返回 false。 */
  setTaskEnabled(ctx: RequestContext, id: number, enabled: boolean): Promise<boolean>;
  /** 为手动请求持久化 Fire；同一任务和幂等键始终返回同一 Fire。 */
  createManualFire(ctx: RequestContext, taskId: number, idempotencyKey: string, now?: Date): Promise<ManualFire | undefined>;
  /** 返回任务的 Fire 及其关联 Durable Run；软删除任务仍保留其可授权历史。 */
  listScheduledExecutions(ctx: RequestContext, taskId: number): Promise<ScheduledExecution[]>;

  // —— 租户 / 用户（平台 / 租户管理用；鉴权在 S8）——
  createTenant(tenant: Tenant): Promise<void>;
  listTenants(): Promise<Tenant[]>;
  createUser(user: NewUser): Promise<User>;
  getUserByUsername(tenantId: string, username: string): Promise<UserWithSecret | undefined>;
  getUser(tenantId: string, userId: string): Promise<User | undefined>;
  listUsers(tenantId: string): Promise<User[]>;
  /** 局部更新用户（状态/墓碑改名/角色/展示名）；不存在返回 undefined。 */
  updateUser(tenantId: string, userId: string, patch: UserPatch): Promise<User | undefined>;
  /** 禁用某用户名下全部定时任务（软删除流程用）；返回受影响任务数。 */
  disableTasksByUser(tenantId: string, userId: string): Promise<number>;

  // —— 用户下游凭据缓存（payload 已加密，Store 只存不解）——
  setUserCredential(tenantId: string, userId: string, provider: string, record: UserCredentialRecord): Promise<void>;
  getUserCredential(tenantId: string, userId: string, provider: string): Promise<UserCredentialRecord | undefined>;
  deleteUserCredentials(tenantId: string, userId: string): Promise<void>;

  // —— OIDC 一次性交换码 ——
  putOidcExchangeCode(record: OidcExchangeCode): Promise<void>;
  /** 仅一个并发调用可成功；实现必须原子设置 consumed_at 后返回会话。 */
  consumeOidcExchangeCode(claim: OidcExchangeCodeClaim): Promise<ConsumedOidcExchangeCode | undefined>;

  // —— 租户设置 ——
  getLlmSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<LlmSettings | undefined>;
  setLlmSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: LlmSettings): Promise<void>;
  getSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<SchedulerSettings | undefined>;
  setSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: SchedulerSettings): Promise<void>;
  /** 平台 Sandbox 配置与独立密文；实现需保证配置和 secret 更新原子提交。 */
  getSandboxSettingsRecord(ctx: Pick<RequestContext, 'tenantId'>): Promise<SandboxSettingsRecord | undefined>;
  setSandboxSettingsRecord(
    ctx: Pick<RequestContext, 'tenantId'>,
    settings: SandboxSettings,
    secret: SandboxSettingsSecretUpdate,
  ): Promise<void>;
  /** MCP server 配置（UI 动态增删后持久化；存在时覆盖 config.jsonc 的 mcpServers）。 */
  getMcpServers(ctx: Pick<RequestContext, 'tenantId'>): Promise<Record<string, McpServerConfig> | undefined>;
  setMcpServers(ctx: Pick<RequestContext, 'tenantId'>, servers: Record<string, McpServerConfig>): Promise<void>;

  close(): Promise<void>;
}
