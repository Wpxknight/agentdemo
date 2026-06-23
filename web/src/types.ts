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

export interface RuntimeModelConfig {
  id: string;
  protocol: 'anthropic' | 'openai';
  base_url: string;
  model: string;
  api_key: string;
  api_key_set: boolean;
  api_key_preview: string;
  options?: RuntimeModelConfig[];
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
}

export interface ChatMessage {
  id?: string;
  role: Role;
  text: string;
  thinking?: string;
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
