import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely 表结构类型。JSON 列写入 JSON 字符串、读出由 mysql2 解析为对象，
 * 故用 ColumnType<读=unknown, 插=string, 改=string>，Store 内做归一化。
 */

type JsonColumn = ColumnType<unknown, string, string>;
type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;

export interface MessagesTable {
  id: Generated<number>;
  session_id: string;
  role: string;
  /** JSON：{ text?, toolCalls?, toolResults? } */
  content: JsonColumn;
  created_at: Generated<Date>;
}

export interface AuditEventsTable {
  id: Generated<number>;
  kind: string;
  action: string;
  session_id: string | null;
  cluster: string | null;
  tool: string | null;
  /** JSON detail */
  detail: NullableJsonColumn;
  created_at: Generated<Date>;
}

export interface ScheduledTasksTable {
  id: Generated<number>;
  session_id: string;
  cron: string;
  task: string;
  pre_approved: number;
  enabled: number;
  next_run_at: Date;
  last_run_at: Date | null;
  created_at: Generated<Date>;
}

export interface TaskRunsTable {
  id: Generated<number>;
  task_id: number;
  status: string;
  detail: string | null;
  steps: number | null;
  created_at: Generated<Date>;
}

export interface Database {
  messages: MessagesTable;
  audit_events: AuditEventsTable;
  scheduled_tasks: ScheduledTasksTable;
  task_runs: TaskRunsTable;
}
