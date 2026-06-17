import type { Msg } from '../model/types.js';
import type { AuditEvent, AuditSink } from '../audit/sink.js';

/** 审计查询过滤。 */
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

/**
 * 持久化抽象：会话消息 + 审计。Store 同时实现 AuditSink，
 * 可直接作为审计落地。MySQL / 内存两种实现。
 */
export interface Store extends AuditSink {
  appendMessage(sessionId: string, msg: Msg): Promise<void>;
  listMessages(sessionId: string): Promise<Msg[]>;
  record(event: AuditEvent): Promise<void>;
  listAudit(filter?: AuditFilter): Promise<AuditEvent[]>;

  // —— 定时任务（S6）——
  createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask>;
  listScheduledTasks(sessionId?: string): Promise<ScheduledTask[]>;
  setTaskEnabled(id: number, enabled: boolean): Promise<void>;
  /**
   * 原子领取到点任务并推进 next_run_at：
   * MySQL 用事务 + FOR UPDATE SKIP LOCKED，保证多副本不重复执行。
   * 返回本次领到的任务（已推进下次时间）。
   */
  claimDueTasks(now: Date, limit: number): Promise<ScheduledTask[]>;
  recordTaskRun(run: TaskRun): Promise<void>;
  listTaskRuns(taskId: number): Promise<TaskRun[]>;

  close(): Promise<void>;
}
