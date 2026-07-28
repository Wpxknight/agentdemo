import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely 表结构类型。JSON 列写入 JSON 字符串、读出由 mysql2 解析为对象，
 * 故用 ColumnType<读=unknown, 插=string, 改=string>，Store 内做归一化。
 */

type JsonColumn = ColumnType<unknown, string, string>;
type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;

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

export interface TaskAgentRunsTable {
  tenant_id: string;
  task_id: number;
  run_id: string;
  created_at: Date;
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

export interface AgentInteractionsTable {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  run_id: string;
  attempt_id: string | null;
  turn_no: number | null;
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
  attempt_id: string | null;
  turn_no: number | null;
  session_id: string;
  tool_call_id: string;
  logical_call_id: string;
  idempotency_key: string;
  capability: string;
  external_correlation_id: string | null;
  result_digest: string | null;
  approved_interaction_id: string | null;
  tool_name: string;
  args_digest: string;
  status: string;
  result: NullableJsonColumn;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

export interface AgentRunsTable {
  tenant_id: string;
  run_id: string;
  user_id: string;
  session_id: string;
  kernel: string;
  kernel_version: string;
  graph_name: string;
  graph_version: string;
  runtime_version: string;
  status: string;
  waiting_reason: string | null;
  current_node: string | null;
  step_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: string | number | null;
  limits_json: NullableJsonColumn;
  error_message: string | null;
  started_at: Date | null;
  updated_at: Date;
  completed_at: Date | null;
  cancel_requested_at: Date | null;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: Date | null;
  append_closed_at: Date | null;
  created_at: Date;
}

export interface AgentRunEventsTable {
  id: Generated<number>;
  tenant_id: string;
  run_id: string;
  sequence: number;
  attempt_id: string | null;
  turn_no: number | null;
  kernel: string | null;
  kernel_version: string | null;
  correlation_id: string | null;
  event_type: string;
  node_name: string | null;
  status: string | null;
  detail: NullableJsonColumn;
  created_at: Date;
}

export interface AgentRunAttemptsTable {
  tenant_id: string;
  run_id: string;
  attempt_id: string;
  worker_id: string;
  lease_token: number;
  kernel: string;
  kernel_version: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
}

export interface AgentTurnSnapshotsTable {
  tenant_id: string;
  run_id: string;
  attempt_id: string;
  turn_no: number;
  session_version: number;
  parent_commit_id: string | null;
  identity_json: JsonColumn;
  model_binding_json: JsonColumn;
  prompt_version: string;
  skill_set_version: string | null;
  tool_set_version: string;
  policy_version: string;
  limits_json: NullableJsonColumn;
  messages_json: JsonColumn;
  deadline_at: Date | null;
  created_at: Date;
}

export interface AgentTurnCommitsTable {
  tenant_id: string;
  run_id: string;
  attempt_id: string;
  turn_no: number;
  pi_session_id: string | null;
  pi_leaf_id: string | null;
  pi_entry_seq: number | null;
  commit_id: string;
  transcript_version: number;
  stop_reason: string | null;
  usage_json: JsonColumn;
  messages_json: JsonColumn;
  event_sequence_end: number;
  committed_at: Date;
}

export interface PiSessionsTable {
  tenant_id: string;
  session_id: string;
  current_leaf_id: string | null;
  committed_leaf_id: string | null;
  metadata_json: NullableJsonColumn;
  created_at: Date;
  updated_at: Date;
}

export interface PiSessionEntriesTable {
  tenant_id: string;
  session_id: string;
  entry_id: string;
  entry_seq: number;
  parent_id: string | null;
  entry_type: string;
  entry_json: JsonColumn;
  created_at: Date;
}

export interface AgentRunInboxMessagesTable {
  tenant_id: string;
  run_id: string;
  message_id: string;
  sequence: number;
  idempotency_key: string;
  mode: string;
  message_json: JsonColumn;
  status: string;
  claim_owner: string | null;
  claim_token: string | null;
  claim_expires_at: Date | null;
  created_at: Date;
  consumed_at: Date | null;
}

export interface Database {
  sessions: SessionsTable;
  messages: MessagesTable;
  audit_events: AuditEventsTable;
  scheduled_tasks: ScheduledTasksTable;
  task_runs: TaskRunsTable;
  task_agent_runs: TaskAgentRunsTable;
  tenants: TenantsTable;
  users: UsersTable;
  user_credentials: UserCredentialsTable;
  tenant_settings: TenantSettingsTable;
  setting_secrets: SettingSecretsTable;
  agent_interactions: AgentInteractionsTable;
  agent_tool_executions: AgentToolExecutionsTable;
  agent_runs: AgentRunsTable;
  agent_run_events: AgentRunEventsTable;
  agent_run_attempts: AgentRunAttemptsTable;
  agent_turn_snapshots: AgentTurnSnapshotsTable;
  agent_turn_commits: AgentTurnCommitsTable;
  pi_sessions: PiSessionsTable;
  pi_session_entries: PiSessionEntriesTable;
  agent_run_inbox_messages: AgentRunInboxMessagesTable;
}
