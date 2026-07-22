import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely 表结构类型。JSON 列写入 JSON 字符串、读出由 mysql2 解析为对象，
 * 故用 ColumnType<读=unknown, 插=string, 改=string>，Store 内做归一化。
 */

type JsonColumn = ColumnType<unknown, string, string>;
type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;
type BinaryColumn = ColumnType<Uint8Array, Uint8Array | Buffer, Uint8Array | Buffer>;

export interface MessagesTable {
  id: Generated<number>;
  tenant_id: string;
  /** 会话归属用户（用户级隔离）；'' 表示 0006 迁移前的遗留数据。 */
  user_id: string;
  session_id: string;
  role: string;
  /** JSON：{ text?, toolCalls?, toolResults? } */
  content: JsonColumn;
  created_at: Generated<Date>;
}

export interface SessionsTable {
  tenant_id: string;
  /** 会话归属用户（用户级隔离）；'' 表示 0006 迁移前的遗留数据。 */
  user_id: string;
  session_id: string;
  title: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AuditEventsTable {
  id: Generated<number>;
  tenant_id: string | null;
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
  tenant_id: string;
  user_id: string;
  session_id: string;
  title: string;
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

export interface TenantsTable {
  id: string;
  name: string;
  created_at: Generated<Date>;
}

export interface UsersTable {
  id: string;
  tenant_id: string;
  username: string;
  role: string;
  password_hash: string;
  /** active | disabled（软删除/封禁，行不硬删）。 */
  status: Generated<string>;
  /** 登录来源：local | oidc | aios。 */
  auth_provider: Generated<string>;
  display_name: string | null;
  /** 用户绑定的主机主目录（绝对路径）；启动沙箱时默认挂载进沙箱。 */
  home_dir: string | null;
  created_at: Generated<Date>;
}

export interface UserCredentialsTable {
  tenant_id: string;
  user_id: string;
  provider: string;
  /** AES-256-GCM 加密后的 JSON payload。 */
  payload: string;
  expires_at: Date | null;
  updated_at: Generated<Date>;
}

export interface TenantSettingsTable {
  tenant_id: string;
  setting_key: string;
  config: JsonColumn;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SettingSecretsTable {
  tenant_id: string;
  setting_key: string;
  /** AES-256-GCM 加密 envelope；由平台设置 codec 加解密。 */
  payload: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LangGraphCheckpointsTable {
  tenant_id: string;
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_type: string;
  checkpoint_data: BinaryColumn;
  metadata_type: string;
  metadata_data: BinaryColumn;
  run_id: string;
  graph_name: string;
  graph_version: string;
  expires_at: Date | null;
  created_at: Date;
}

export interface LangGraphCheckpointWritesTable {
  tenant_id: string;
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  write_index: number;
  channel: string;
  value_type: string;
  value_data: BinaryColumn;
}

export interface AgentInteractionsTable {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  run_id: string;
  kind: string;
  tool_call_id: string | null;
  payload: JsonColumn;
  status: string;
  resolution: NullableJsonColumn;
  resolved_by: string | null;
  expires_at: Date;
  created_at: Date;
  resolved_at: Date | null;
}

export interface AgentToolExecutionsTable {
  tenant_id: string;
  run_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  args_digest: string;
  status: string;
  result: NullableJsonColumn;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

export interface Database {
  sessions: SessionsTable;
  messages: MessagesTable;
  audit_events: AuditEventsTable;
  scheduled_tasks: ScheduledTasksTable;
  task_runs: TaskRunsTable;
  tenants: TenantsTable;
  users: UsersTable;
  user_credentials: UserCredentialsTable;
  tenant_settings: TenantSettingsTable;
  setting_secrets: SettingSecretsTable;
  langgraph_checkpoints: LangGraphCheckpointsTable;
  langgraph_checkpoint_writes: LangGraphCheckpointWritesTable;
  agent_interactions: AgentInteractionsTable;
  agent_tool_executions: AgentToolExecutionsTable;
}
