export type PageId = 'chat' | 'runs' | 'skills' | 'mcp' | 'schedule' | 'sandbox' | 'users' | 'settings';

export type Role = 'user' | 'assistant';

export interface NavItem {
  id: PageId;
  label: string;
  icon: 'chat' | 'runs' | 'skills' | 'mcp' | 'schedule' | 'sandbox' | 'users' | 'settings';
  /** 仅管理员可见的一级菜单（前端隐藏只是 UX，真正的防线是后端 RBAC）。 */
  adminOnly?: boolean;
}

/** 当前登录身份（GET /v1/me）。 */
export interface MeBody {
  tenantId: string;
  userId: string;
  role: 'platform_admin' | 'tenant_admin' | 'user';
  username?: string;
  displayName?: string;
  authProvider?: 'local' | 'oidc' | 'aios';
  /** 绑定的宿主机主目录（启动沙箱时默认挂载）；空串表示未绑定。 */
  homeDir?: string;
}

/** 用户管理列表项（GET /v1/admin/users）。 */
export interface AdminUser {
  id: string;
  tenantId: string;
  username: string;
  role: 'platform_admin' | 'tenant_admin' | 'user';
  status: 'active' | 'disabled';
  authProvider: 'local' | 'oidc' | 'aios';
  displayName?: string;
  createdAt?: string;
}

export interface AdminUsersBody {
  users: AdminUser[];
}

export interface PageMeta {
  title: string;
  hasSandboxWorkspace: boolean;
  hasSessionHistoryDrawer?: boolean;
}

export interface SessionSummary {
  title: string;
  time: string;
  desc: string;
  sessionId?: string;
}

export interface ToolSummary {
  name: string;
  description?: string;
  category?: string;
  source?: string;
  status?: string;
  enabled?: boolean;
  /** 技能所有者用户 id（'' 表示无主存量公共技能）。 */
  owner?: string;
  /** 技能可见性：public 全员 / private 仅所有者 / shared 租户内共享。 */
  visibility?: 'public' | 'private' | 'shared';
  /** 当前用户是否可管理该技能（启停/删除/共享）；服务端计算。 */
  canManage?: boolean;
  lastUsed?: string;
  transport?: string;
  files?: string[];
  fileEntries?: SkillFileEntry[];
  inputSchema?: unknown;
}

export interface SkillFileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  updatedAt: string;
}

export interface McpServerInfo {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  status: 'connected' | 'error';
  error?: string;
  connectedAt?: string;
  tools: string[];
}

export interface McpServersBody {
  servers: McpServerInfo[];
}

export interface McpServerBody {
  server: McpServerInfo;
}

export interface ScheduledTask {
  id?: number;
  /** 列表展示用标题（旧任务可能为空，展示层回退到 task）。 */
  title?: string;
  task: string;
  cron: string;
  nextRunAt?: string;
  enabled?: boolean;
  lastRunAt?: string;
  preApproved?: boolean;
  sessionId?: string;
}

export interface TaskRun {
  id?: number;
  taskId: number;
  status: 'success' | 'error';
  detail?: string;
  steps?: number;
  createdAt?: string;
}

export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required';

export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
}

export interface AgentRunAttemptSummary {
  attemptId: string;
  kernel: string;
  kernelVersion: string;
  status: string;
  errorCode?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AgentRunTurnSummary {
  attemptId: string;
  turnNo: number;
  commitId: string;
  transcriptVersion: number;
  stopReason?: string;
  usage: AgentRunUsage;
  eventSequenceEnd: number;
  committedAt: string;
}

export interface AgentRunSummary {
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
  kernel: 'pi';
  kernelVersion?: string;
  status: AgentRunStatus;
  waitingReason?: 'approval' | 'question' | 'plan' | 'external';
  currentNode?: string;
  stepCount: number;
  usage: AgentRunUsage;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  leaseToken: number;
  leaseExpiresAt?: string;
  leaseActive: boolean;
  attemptSummary?: { count: number; latest?: AgentRunAttemptSummary };
  turnSummary?: { count: number; latest?: AgentRunTurnSummary };
}

export interface AgentRunEventBody {
  id?: number;
  type: string;
  node?: string;
  status?: string;
  detail?: unknown;
  createdAt: string;
}

export interface AgentRunListBody {
  runs: AgentRunSummary[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AgentRunDetailBody {
  run: AgentRunSummary;
  events: AgentRunEventBody[];
  interactions: Array<{ id: string; kind: string; status: string; createdAt: string; resolvedAt?: string }>;
  tools: Array<{ toolCallId: string; toolName: string; status: string; startedAt: string; completedAt?: string }>;
  attempts: AgentRunAttemptSummary[];
  turns: AgentRunTurnSummary[];
  canCancel: boolean;
  canResume: boolean;
  recoveryBlockedReason?: string;
}

export interface SandboxSummary {
  id: string;
  status: string;
  sandboxId?: string;
  key?: string;
  type?: string;
  profile?: string;
  image?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  capabilities?: string[];
  privileged?: boolean;
  resources?: Record<string, string>;
  sessionId?: string;
  createdAt?: string;
  lastUsedAt?: string;
  metadata?: Record<string, string>;
  actions?: string[];
}

export interface SandboxProfileSummary {
  id: string;
  name: string;
  template?: string;
  description: string;
  envType: 'code' | 'browser';
  runtimeRole: 'sandbox-reader' | 'sandbox-diag';
  image?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  desktop: boolean;
  privileged: boolean;
  capabilities: string[];
  timeoutMs?: number;
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RuntimeModelConfig {
  id: string;
  protocol: 'anthropic' | 'openai';
  base_url: string;
  model: string;
  api_key: string;
  api_key_set: boolean;
  api_key_preview: string;
  /** 允许该 LLM 访问使用自签名或不受信任证书的 HTTPS 服务。 */
  allow_insecure_tls?: boolean;
  context_window_tokens: number;
  /** 历史里保留图片的最近带图消息条数（更早的替换占位符），默认 1。 */
  context_keep_images?: number;
  /** 推理深度（none 关闭思考；仅 Anthropic 协议生效）。 */
  effort?: ReasoningEffort;
  options?: RuntimeModelConfig[];
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
}

export interface TaskStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
}

/** 智能体导出的可下载文件（file_exported 事件；前端渲染下载按钮）。 */
export interface ExportedFile {
  name: string;
  url: string;
  size: number;
  mime: string;
  expiresAt: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface ChangePlan {
  summary: string;
  changes: { action: string; target: string; detail?: string }[];
  impact: string;
  rollback: string;
}

export interface PendingQuestion {
  id: string;
  sessionId: string;
  questions: QuestionSpec[];
  /** 变更方案审批时携带的结构化方案（change_plan_required）。 */
  plan?: ChangePlan;
}

export interface ChatMessage {
  id?: string;
  role: Role;
  text: string;
  thinking?: string;
  /** 任务执行进度：每个工具调用一步，实时标记完成/失败。 */
  steps?: TaskStep[];
  /** 模型通过 todo_write 维护的任务清单（长任务进度）。 */
  todos?: TodoItem[];
  /** 智能体导出的可下载文件（file_exported 事件）。 */
  files?: ExportedFile[];
  running?: boolean;
  /** 本次助手响应开始时间，仅用于执行中实时计时。 */
  startedAt?: number;
  /** 本次助手响应最终执行耗时。 */
  durationMs?: number;
  time: string;
  tools?: string[];
  attachments?: Attachment[];
  /** 运行期系统提示（如自动压缩上下文），展示在消息气泡顶部。 */
  notices?: string[];
  /** 模型正在自动重试的瞬态提示；输出恢复后清除。 */
  retrying?: string;
  /** 该消息是自动压缩产生的历史摘要（折叠展示）。 */
  summary?: boolean;
}

export interface SessionsBody {
  sessions: Array<{
    sessionId: string;
    title?: string;
    updatedAt?: string;
    lastMessage?: string;
    messageCount?: number;
  }>;
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
}

export interface SessionMessagesBody {
  messages: Array<{
    role: Role | 'tool';
    text?: string;
    thinking?: string;
    durationMs?: number;
  }>;
}

export interface ContextUsageBody {
  sessionId?: string;
  usedTokens: number;
  maxTokens: number;
  estimated: boolean;
}

export interface SessionTokenUsageBody {
  sessionId: string;
  totalTokens: number;
}

export interface ToolsBody {
  tools: ToolSummary[];
  groups?: Record<string, number>;
}

export interface SkillsImportBody {
  skill: ToolSummary;
}

export interface SkillFileBody {
  path: string;
  parentPath: string | null;
  entry?: SkillFileEntry;
  entries?: SkillFileEntry[];
  content?: string;
}

export interface SkillActionBody {
  skill?: ToolSummary;
  ok?: boolean;
}

export interface ScheduleBody {
  tasks: ScheduledTask[];
}

export interface ScheduleRunsBody {
  runs: TaskRun[];
}

export interface SandboxesBody {
  sandboxes: SandboxSummary[];
  profiles?: SandboxProfileSummary[];
}

export type SandboxSettingsMode = 'standard_e2b' | 'aios_lifecycle' | 'opensandbox' | 'local';

export interface SandboxSettingsInfo {
  enabled: boolean;
  mode: SandboxSettingsMode;
  domain?: string;
  protocol?: 'http' | 'https';
  default_image?: string;
  lifecycle_url?: string;
  placement?: {
    cluster_id: string;
    namespace: string;
  };
  api_key_set: boolean;
}

export interface SandboxSettingsBody {
  scope: 'platform';
  settings: SandboxSettingsInfo;
  runtime?: {
    enabled: boolean;
    mode?: SandboxSettingsMode;
    status?: 'disabled' | 'active' | 'catalog_unavailable' | 'refreshing' | string;
    template_count?: number;
    last_successful_refresh_at?: string;
  };
}

export interface ModelSettingsBody {
  config: RuntimeModelConfig;
  options?: RuntimeModelConfig[];
}

export interface ToolCallBody {
  ok?: boolean;
  sessionId?: string;
  result?: {
    content?: string;
    contentBlocks?: Array<{ type: string; mimeType?: string; data?: string }>;
    isError?: boolean;
  };
  error?: string;
}
