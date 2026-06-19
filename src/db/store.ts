import type { Msg } from '../model/types.js';
import type { AuditEvent, AuditSink } from '../audit/sink.js';
import type { Role, RequestContext, Tenant, User } from '../auth/types.js';

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
  taskId: number;
  status: 'success' | 'error';
  detail?: string;
  steps?: number;
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
  appendMessage(ctx: RequestContext, sessionId: string, msg: Msg): Promise<void>;
  listMessages(ctx: RequestContext, sessionId: string): Promise<Msg[]>;
  listSessions(ctx: RequestContext, limit?: number): Promise<SessionSummary[]>;

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

  close(): Promise<void>;
}
