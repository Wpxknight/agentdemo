import type { Msg } from '../model/types.js';
import type { AuditEvent, AuditSink } from '../audit/sink.js';
import type { AuthProviderKind, Role, RequestContext, Tenant, User, UserStatus } from '../auth/types.js';
import type { McpServerConfig } from '../mcp/types.js';

export interface LlmSettings {
  id: string;
  protocol: 'anthropic' | 'openai';
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindowTokens?: number;
  /** 历史里保留图片的最近带图消息条数（更早的替换占位符），默认 1；0 表示一张不留。 */
  contextKeepImages?: number;
  /** 推理深度：none 关闭思考；low..max 对应 Anthropic effort；缺省=思考开启走模型默认深度。 */
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** 前端新建会话时的占位标题；视为“未显式命名”，首条用户消息会将其覆盖。 */
export const DEFAULT_SESSION_TITLE = '新会话';

/** 定时任务运行设置（租户级）。 */
/** 沙箱服务端连接配置（设置页保存；启动时合并覆盖 config.jsonc 的 sandbox 连接字段）。 */
export interface SandboxSettings {
  provider?: 'local' | 'e2b' | 'opensandbox';
  /** 网关域名 host[:port]，无 scheme。 */
  domain?: string;
  protocol?: 'http' | 'https';
  apiKey?: string;
  /** OpenSandbox 未指定模板时的默认镜像。 */
  defaultImage?: string;
}

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
  title?: string;
  task?: string;
  preApproved?: boolean;
  enabled?: boolean;
}

export interface TaskRun {
  id?: number;
  taskId: number;
  status: 'success' | 'error';
  detail?: string;
  steps?: number;
  createdAt?: Date;
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

/**
 * 持久化抽象。除系统级方法（claimDueTasks/recordTaskRun/租户用户管理）外，
 * 业务读写均需 RequestContext 并按 tenantId 强制过滤，实现租户隔离。
 */
export interface Store extends AuditSink {
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

  // —— 审计 ——（record 来自 AuditSink；event.tenantId 标识归属）
  record(event: AuditEvent): Promise<void>;
  listAudit(ctx: RequestContext, filter?: AuditFilter): Promise<AuditEvent[]>;

  // —— 定时任务 ——
  createScheduledTask(ctx: RequestContext, input: ScheduledTaskInput): Promise<ScheduledTask>;
  listScheduledTasks(ctx: RequestContext): Promise<ScheduledTask[]>;
  getScheduledTask(ctx: RequestContext, id: number): Promise<ScheduledTask | undefined>;
  /** 局部更新；cron 变更时重算 nextRunAt。任务不存在（或跨租户）返回 undefined。 */
  updateScheduledTask(ctx: RequestContext, id: number, patch: ScheduledTaskPatch): Promise<ScheduledTask | undefined>;
  /** 删除任务及其全部执行记录。返回是否存在。 */
  deleteScheduledTask(ctx: RequestContext, id: number): Promise<boolean>;
  setTaskEnabled(ctx: RequestContext, id: number, enabled: boolean): Promise<void>;
  /** 系统级：原子领取到点任务（跨租户），返回任务含 tenantId/userId 供执行构造 ctx。 */
  claimDueTasks(now: Date, limit: number): Promise<ScheduledTask[]>;
  recordTaskRun(run: TaskRun): Promise<void>;
  listTaskRuns(ctx: RequestContext, taskId: number): Promise<TaskRun[]>;

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

  // —— 租户设置 ——
  getLlmSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<LlmSettings | undefined>;
  setLlmSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: LlmSettings): Promise<void>;
  getSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<SchedulerSettings | undefined>;
  setSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: SchedulerSettings): Promise<void>;
  /** 沙箱服务端连接配置（设置页保存；覆盖 config.jsonc 的连接字段）。 */
  getSandboxSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<SandboxSettings | undefined>;
  setSandboxSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: SandboxSettings): Promise<void>;
  /** MCP server 配置（UI 动态增删后持久化；存在时覆盖 config.jsonc 的 mcpServers）。 */
  getMcpServers(ctx: Pick<RequestContext, 'tenantId'>): Promise<Record<string, McpServerConfig> | undefined>;
  setMcpServers(ctx: Pick<RequestContext, 'tenantId'>, servers: Record<string, McpServerConfig>): Promise<void>;

  close(): Promise<void>;
}
