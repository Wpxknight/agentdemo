import type { Msg } from '../model/types.js';
import type { AuditEvent, AuditSink } from '../audit/sink.js';
import type { Role, RequestContext, Tenant, User } from '../auth/types.js';

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
  task: string;
  preApproved: boolean;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt?: Date;
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
}

/** 含密钥的用户记录（仅登录校验内部使用）。 */
export interface UserWithSecret extends User {
  passwordHash: string;
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

  // —— 租户设置 ——
  getLlmSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<LlmSettings | undefined>;
  setLlmSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: LlmSettings): Promise<void>;
  getSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<SchedulerSettings | undefined>;
  setSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: SchedulerSettings): Promise<void>;

  close(): Promise<void>;
}
