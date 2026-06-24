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

export interface SandboxSummary {
  id: string;
  status: string;
  type?: string;
  resources?: Record<string, string>;
  sessionId?: string;
  createdAt?: string;
  actions?: string[];
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

export interface ChatMessage {
  id?: string;
  role: Role;
  text: string;
  thinking?: string;
  /** 任务执行进度：每个工具调用一步，实时标记完成/失败。 */
  steps?: TaskStep[];
  running?: boolean;
  time: string;
  tools?: string[];
  attachments?: Attachment[];
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

export interface SandboxesBody {
  sandboxes: SandboxSummary[];
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
