export type PageId = 'chat' | 'skills' | 'mcp' | 'schedule' | 'sandbox' | 'settings';

export type Role = 'user' | 'assistant';

export interface NavItem {
  id: PageId;
  label: string;
  icon: 'chat' | 'skills' | 'mcp' | 'schedule' | 'sandbox' | 'settings';
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
  name: string;
  description: string;
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
  running?: boolean;
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
  }>;
}

export interface ContextUsageBody {
  sessionId?: string;
  usedTokens: number;
  maxTokens: number;
  estimated: boolean;
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
