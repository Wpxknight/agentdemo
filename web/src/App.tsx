import { Fragment, isValidElement, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  Activity,
  Bot,
  Boxes,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Code2,
  Cuboid,
  Cpu,
  Database,
  FileText,
  Folder,
  Download,
  FolderTree,
  Globe,
  KeyRound,
  Link2,
  LogOut,
  MessageSquare,
  Monitor,
  PanelLeftClose,
  PanelRightClose,
  Paperclip,
  Play,
  Plus,
  RefreshCcw,
  Search,
  Send,
  Settings,
  SquarePen,
  Terminal,
  TerminalSquare,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { NAV_ITEMS, defaultLlmConfig, fallbackTools } from './app-data';
import { MermaidDiagram } from './components/mermaid-diagram';
import { createApi, numericSessionId, randomId, readStorage, writeStorage } from './api';
import { formatSandboxOutputChunk, parseSandboxOutput, sandboxOutputClassNames, sandboxOutputCommand, sandboxOutputLabels } from './sandbox-output';
import type {
  Attachment,
  ChatMessage,
  ExportedFile,
  ContextUsageBody,
  ModelSettingsBody,
  PageId,
  ReasoningEffort,
  Role,
  RuntimeModelConfig,
  SandboxSummary,
  SandboxProfileSummary,
  SandboxesBody,
  ScheduleBody,
  ScheduleRunsBody,
  ScheduledTask,
  SkillActionBody,
  SkillFileBody,
  SkillFileEntry,
  SkillsImportBody,
  SessionMessagesBody,
  SessionSummary,
  SessionsBody,
  TaskRun,
  PendingQuestion,
  QuestionSpec,
  TaskStep,
  TodoItem,
  McpServerBody,
  McpServerInfo,
  McpServersBody,
  ToolCallBody,
  ToolSummary,
  ToolsBody,
} from './types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const iconMap = {
  chat: MessageSquare,
  skills: Boxes,
  mcp: Link2,
  schedule: CalendarClock,
  sandbox: Cuboid,
  settings: Settings,
};

const logoUrl = '/assets/logo.jpg';
const aiAvatarUrl = logoUrl;
const userAvatarUrl = '/assets/user-avatar.jpg';
const SESSION_PAGE_SIZE = 10;

type ConfirmDialogTone = 'danger' | 'warning' | 'info';

interface ConfirmDialogRequest {
  title: string;
  description: string;
  alert?: string;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  onConfirm: () => void | Promise<void>;
}

function sessionCategoryFor(session: SessionSummary) {
  const text = `${session.title} ${session.desc}`.toLowerCase();
  if (text.includes('pod') || text.includes('异常') || text.includes('oom')) {
    return { Icon: TerminalSquare, tone: 'danger' };
  }
  if (text.includes('巡检') || text.includes('任务')) {
    return { Icon: CalendarClock, tone: 'info' };
  }
  if (text.includes('告警')) {
    return { Icon: Activity, tone: 'warning' };
  }
  if (text.includes('资源') || text.includes('优化')) {
    return { Icon: Database, tone: 'success' };
  }
  return { Icon: MessageSquare, tone: 'neutral' };
}

const initialMessages: ChatMessage[] = [
  {
    role: 'assistant',
    text: '你好，我是你的 AI 运维助手。\n\n可以帮你查询集群状态、分析告警、执行变更、管理配置和排查问题。',
    time: '10:15',
  },
  {
    role: 'user',
    text: '帮我检查 prod 命名空间下 aiop-server 的 Pod 异常，并给出修复建议。',
    time: '10:16',
  },
  {
    role: 'assistant',
    text: '已发现 aiop-server-6d9c 最近一次重启原因是 OOMKilled。\n\n建议先查看资源限制，再评估是否调整内存并滚动重启。',
    time: '10:16',
    tools: ['kubectl get pods', 'kubectl describe pod', '生成修复建议'],
  },
];

function initialPage(): PageId | 'login' {
  if (typeof window !== 'undefined' && window.location.pathname === '/login') return 'login';
  return 'chat';
}

function formatTime(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(value?: string): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clampPreviewWidth(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 440;
  return Math.min(760, Math.max(360, Math.round(n)));
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err || '未知错误');
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTokenCount(value: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function formatContextUsage(usage?: ContextUsageBody): string {
  return `${formatTokenCount(usage?.usedTokens ?? 0)}/${formatTokenCount(usage?.maxTokens ?? 200000)}`;
}

/** 会话累计成本（美元）：小额用更多小数位，避免显示成 $0.00。 */
function formatCostUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function toolCategory(name: string): string {
  if (name === 'load_skill' || name.startsWith('skill__')) return 'skill';
  if (name.startsWith('mcp__')) return 'mcp';
  if (name.startsWith('sbx__') || name.startsWith('sandbox_') || name.startsWith('browser_') || name === 'desktop_stream_url') return 'sandbox';
  return 'builtin';
}

function toolDisplayName(name = ''): string {
  return name.replace(/^mcp__/, '').replace(/^skill__/, '').replace(/^sbx__/, '');
}

function humanizeCron(cron: string): string {
  const map: Record<string, string> = {
    '0 2 * * *': '每天 02:00',
    '0 1 * * *': '每天 01:00',
    '0 * * * *': '每小时',
    '*/5 * * * *': '每 5 分钟',
    '0 9 * * 1': '每周一 09:00',
  };
  return map[cron] || cron || '-';
}

function resourceSummary(resources?: Record<string, string>): string {
  if (!resources) return '-';
  return [resources.cpu, resources.memory, resources.storage].filter(Boolean).join(' / ') || '-';
}

function listSummary(items?: string[]): string {
  return items?.length ? items.join(' / ') : '-';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取附件失败'));
    reader.readAsDataURL(file);
  });
}

function parseSse(block: string): { event?: string; data?: Record<string, unknown> } | undefined {
  const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
  const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
  if (!eventLine) return undefined;
  const event = eventLine.slice('event:'.length).trim();
  const raw = dataLine?.slice('data:'.length).trim();
  if (!raw) return { event };
  try {
    return { event, data: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { event, data: { text: raw } };
  }
}

function isContextUsage(value: unknown): value is ContextUsageBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.usedTokens === 'number'
    && typeof record.maxTokens === 'number'
    && typeof record.estimated === 'boolean';
}

/** 把沙箱 / kubectl 工具调用还原成可读的命令行；非这类工具返回 null。 */
function sandboxCommandLine(call: unknown): string | null {
  if (!call || typeof call !== 'object') return null;
  const { name, args } = call as { name?: string; args?: Record<string, unknown> };
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (name === 'sbx__run_command') return typeof a.command === 'string' ? a.command : null;
  if (name === 'sbx__run_code') {
    const lang = typeof a.language === 'string' ? a.language : 'python';
    return typeof a.code === 'string' ? sandboxOutputCommand(lang, a.code) : null;
  }
  if (name === 'kubectl') {
    const argv = Array.isArray(a.args) ? a.args.join(' ') : '';
    const cluster = typeof a.cluster === 'string' ? `   # cluster=${a.cluster}` : '';
    return `kubectl ${argv}${cluster}`;
  }
  return null;
}

/** 工具调用 → 任务进度条目的可读标签。 */
function stepLabel(call: unknown): string {
  if (!call || typeof call !== 'object') return '执行工具';
  const { name, args } = call as { name?: string; args?: Record<string, unknown> };
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (name === 'sbx__run_command') {
    const cmd = typeof a.command === 'string' ? a.command : '';
    return `执行命令：${truncate(cmd, 60)}`;
  }
  if (name === 'sbx__run_code') {
    const lang = typeof a.language === 'string' ? a.language : 'python';
    return `运行代码（${lang}）`;
  }
  if (name === 'kubectl') {
    const argv = Array.isArray(a.args) ? a.args.join(' ') : '';
    return `kubectl ${truncate(argv, 60)}`;
  }
  if (name === 'load_skill') {
    const skill = typeof a.name === 'string' ? a.name : '';
    return skill ? `加载技能：${skill}` : '加载技能';
  }
  if ((name === 'skill__read_file' || name === 'skill__sync_to_sandbox') && typeof a.name === 'string') {
    const label = name === 'skill__read_file' ? '读取技能文件' : '同步技能到沙箱';
    return `${label}：${a.name}`;
  }
  return `调用工具：${toolDisplayName(name)}`;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function formatToolResponse(body: ToolCallBody): string {
  const content = body.result?.content || body.error || '操作完成。';
  const image = body.result?.contentBlocks?.find((block) => block.type === 'image');
  return image?.data ? `${content}\n[image] ${image.mimeType || 'image/png'} ${image.data.length} bytes base64` : content;
}

function terminalStats(output: string): string {
  if (!output.trim()) return '空';
  const lineCount = output.replace(/\n$/, '').split('\n').length;
  const byteCount = new TextEncoder().encode(output).length;
  return `${lineCount} 行 · ${formatFileSize(byteCount)}`;
}

function extractUrl(text: string): string {
  return text.match(/data:text\/html[^ \n)]+/)?.[0]
    || text.match(/https?:\/\/[^\s)]+/)?.[0]
    || text.match(/\/[a-zA-Z0-9_./?=&%-]+/)?.[0]
    || '';
}

function publicAttachment(file: Attachment): Omit<Attachment, 'id'> {
  const { id: _id, ...rest } = file;
  return rest;
}

/** 与后端 SUMMARY_PREFIX 对应：自动压缩落库的历史摘要消息前缀。 */
const CONTEXT_SUMMARY_PREFIX = '【历史对话摘要（自动压缩，供参考）】';

function sessionMessagesToChatMessages(body: SessionMessagesBody): ChatMessage[] {
  // 一次 agent 运行会落库多条 assistant 消息（工具调用轮通常无正文、叙述与结论分轮）。
  // 回放时跳过空消息、合并连续 assistant 为一个气泡，与流式实时展示保持一致。
  const messages: ChatMessage[] = [];
  for (const message of body.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = message.text || '';
    const thinking = message.thinking || '';
    if (message.role === 'assistant' && !text.trim() && !thinking.trim()) continue;
    const prev = messages[messages.length - 1];
    if (message.role === 'assistant' && prev?.role === 'assistant' && !prev.summary) {
      prev.text = [prev.text, text].filter((part) => part.trim()).join('\n\n');
      const mergedThinking = [prev.thinking || '', thinking].filter((part) => part.trim()).join('\n\n');
      prev.thinking = mergedThinking || undefined;
      continue;
    }
    messages.push({
      id: `history-${messages.length}`,
      role: message.role as Role,
      text,
      thinking: thinking || undefined,
      summary: message.role === 'user' && text.startsWith(CONTEXT_SUMMARY_PREFIX),
      time: '',
    });
  }
  return messages.length ? messages : initialMessages.slice(0, 1);
}

function mapSessionSummary(session: SessionsBody['sessions'][number]): SessionSummary {
  return {
    title: session.title || session.sessionId,
    time: formatTime(session.updatedAt),
    desc: session.lastMessage || `${session.messageCount ?? 0} 条消息`,
    sessionId: session.sessionId,
  };
}

function skillAliases(skill: ToolSummary): string[] {
  return [skill.name, toolDisplayName(skill.name)].filter(Boolean);
}

function parseSkillShortcut(text: string, skills: ToolSummary[]) {
  const match = /^\/([^\s]*)\s*(.*)$/s.exec(text.trimStart());
  if (!match) return undefined;
  const query = match[1] || '';
  const normalized = query.toLowerCase();
  const skill = skills.find((item) => skillAliases(item).some((name) => name.toLowerCase() === normalized));
  return { query, rest: match[2] || '', skill };
}

function skillSuggestionsFor(text: string, skills: ToolSummary[]): ToolSummary[] {
  const shortcut = parseSkillShortcut(text, skills);
  if (!shortcut) return [];
  const query = shortcut.query.toLowerCase();
  return skills
    .filter((skill) => skill.enabled !== false)
    .filter((skill) => !query || skillAliases(skill).some((name) => name.toLowerCase().includes(query)))
    .slice(0, 6);
}

function applySkillShortcut(task: string, skills: ToolSummary[]): string {
  const shortcut = parseSkillShortcut(task, skills);
  if (!shortcut?.skill) return task;
  const rest = shortcut.rest.trim() || '请按技能说明继续处理当前问题。';
  return `请先使用技能 ${shortcut.skill.name}（可调用 load_skill 读取技能说明），然后处理：${rest}`;
}

type ThinkingSegment = {
  type: 'text' | 'thinking';
  content: string;
  streaming?: boolean;
};

function splitThinkingSegments(text: string): ThinkingSegment[] {
  const segments: ThinkingSegment[] = [];
  const lower = text.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    const start = lower.indexOf('<think>', cursor);
    if (start === -1) {
      segments.push({ type: 'text', content: text.slice(cursor) });
      break;
    }
    if (start > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, start) });
    }

    const contentStart = start + '<think>'.length;
    const end = lower.indexOf('</think>', contentStart);
    if (end === -1) {
      segments.push({ type: 'thinking', content: text.slice(contentStart), streaming: true });
      break;
    }

    segments.push({ type: 'thinking', content: text.slice(contentStart, end) });
    cursor = end + '</think>'.length;
  }

  return segments.filter((segment) => segment.content.length > 0);
}

function renderTextLines(text: string, keyPrefix: string) {
  return text.split('\n').map((line, lineIndex) => (
    line ? <p key={`${keyPrefix}-${lineIndex}`}>{line}</p> : <br key={`${keyPrefix}-${lineIndex}`} />
  ));
}

/** 清洗模型 thinking（纯文本渲染）：去掉其输出的 Markdown 噪声——HTML 注释分隔符、加粗标记，折叠多余空行。 */
function stripThinkingArtifacts(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')   // 完整 HTML 注释（模型用 <!-- --> 作分隔符）
    .replace(/<!--[\s\S]*$/, '')        // 流式过程中未闭合的注释残尾
    .replace(/\*\*(.*?)\*\*/g, '$1')    // 去掉成对的加粗标记，保留文字
    .replace(/\*\*/g, '')               // 去掉流式中途残留/未配对的 **
    .replace(/\n{3,}/g, '\n\n');
}

function ThinkingBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const trimmed = stripThinkingArtifacts(content).trim();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  if (!trimmed) return null;
  return (
    <details className="thinking-block" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Cpu />
        thinking
      </summary>
      {/* thinking 按纯文本渲染；stripThinkingArtifacts 已去掉模型输出的 Markdown 噪声。 */}
      <div className="thinking-content">{renderTextLines(trimmed, 'thinking')}</div>
    </details>
  );
}

const OTHER_LABEL = '其他…';

function QuestionCard({ pending, onSubmit }: {
  pending: PendingQuestion;
  onSubmit: (answers: Record<string, string[]>) => void;
}) {
  // 每题选中的 label 集合 + “其他”自由输入文本
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  function toggle(q: QuestionSpec, label: string) {
    setSelected((current) => {
      const set = new Set(current[q.question] ?? []);
      if (q.multiSelect) {
        set.has(label) ? set.delete(label) : set.add(label);
      } else {
        set.clear();
        set.add(label);
      }
      return { ...current, [q.question]: set };
    });
  }

  function submit() {
    const answers: Record<string, string[]> = {};
    for (const q of pending.questions) {
      const picked = [...(selected[q.question] ?? [])];
      const resolved = picked.map((l) => (l === OTHER_LABEL ? (otherText[q.question] ?? '').trim() : l)).filter(Boolean);
      answers[q.question] = resolved;
    }
    onSubmit(answers);
  }

  const allAnswered = pending.questions.every((q) => {
    const picked = selected[q.question] ?? new Set<string>();
    if (!picked.size) return false;
    if (picked.has(OTHER_LABEL)) return Boolean((otherText[q.question] ?? '').trim());
    return true;
  });

  return (
    <div className="question-card">
      {pending.plan ? (
        <div className="change-plan">
          <div className="change-plan-head">变更方案：{pending.plan.summary}</div>
          <ol className="change-plan-list">
            {pending.plan.changes.map((c, i) => (
              <li key={i}><strong>[{c.action}]</strong> {c.target}{c.detail ? ` — ${c.detail}` : ''}</li>
            ))}
          </ol>
          <div className="change-plan-meta"><span>影响面</span>{pending.plan.impact}</div>
          <div className="change-plan-meta"><span>回滚</span>{pending.plan.rollback}</div>
        </div>
      ) : null}
      {pending.questions.map((q) => {
        const picked = selected[q.question] ?? new Set<string>();
        return (
          <div key={q.question} className="question-block">
            <div className="question-head">
              {q.header ? <span className="question-chip">{q.header}</span> : null}
              <strong>{q.question}</strong>
            </div>
            <div className="question-options">
              {[...q.options, { label: OTHER_LABEL }].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className={cn('question-option', picked.has(opt.label) && 'active')}
                  onClick={() => toggle(q, opt.label)}
                >
                  <span className="question-option-label">{opt.label}</span>
                  {'description' in opt && opt.description ? <small>{opt.description}</small> : null}
                </button>
              ))}
            </div>
            {picked.has(OTHER_LABEL) ? (
              <Input
                autoFocus
                placeholder="请输入…"
                value={otherText[q.question] ?? ''}
                onChange={(e) => setOtherText((current) => ({ ...current, [q.question]: e.target.value }))}
              />
            ) : null}
          </div>
        );
      })}
      <div className="question-actions">
        <Button type="button" size="sm" disabled={!allAnswered} onClick={submit}>提交回答</Button>
      </div>
    </div>
  );
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="task-progress todo-list">
      <div className="task-progress-head">
        任务清单 <span className="task-progress-count">{done}/{todos.length}</span>
      </div>
      <ul className="task-progress-list">
        {todos.map((todo, index) => (
          <li key={`${index}-${todo.content}`} className={`task-step todo-${todo.status}`}>
            <span className="task-step-icon">
              {todo.status === 'completed' ? <Check /> : todo.status === 'in_progress' ? <span className="task-spinner" /> : <span className="todo-dot" />}
            </span>
            <span className="task-step-label">{todo.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TaskProgress({ steps }: { steps: TaskStep[] }) {
  const done = steps.filter((s) => s.status !== 'running').length;
  return (
    <div className="task-progress">
      <div className="task-progress-head">
        任务进度 <span className="task-progress-count">{done}/{steps.length}</span>
      </div>
      <ul className="task-progress-list">
        {steps.map((step) => (
          <li key={step.id} className={`task-step task-${step.status}`}>
            <span className="task-step-icon">
              {step.status === 'done' ? <Check /> : step.status === 'error' ? <X /> : <span className="task-spinner" />}
            </span>
            <span className="task-step-label">{step.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 智能体导出文件的下载按钮组：href 指向 /v1/files/<令牌>，download 触发浏览器下载。 */
function DownloadFiles({ files }: { files: ExportedFile[] }) {
  return (
    <div className="export-files">
      {files.map((file) => (
        <a
          key={file.url}
          className="export-file"
          href={file.url}
          download={file.name}
          target="_blank"
          rel="noreferrer"
        >
          <Download className="export-file-icon" />
          <span className="export-file-name">{file.name}</span>
          {file.size ? <span className="export-file-size">{formatFileSize(file.size)}</span> : null}
        </a>
      ))}
    </div>
  );
}

/** 递归取 React 子节点纯文本，用于识别状态/警示内容。 */
function reactNodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  if (isValidElement(node)) return reactNodeText((node.props as { children?: ReactNode }).children);
  return '';
}

/**
 * 按内容判断警示级别：优先识别模板约定的 ✅/⚠️/❌ 符号，其次按关键词兜底。
 * 返回 'danger' | 'warning' | 'success' | ''。
 */
function statusTone(rawText: string): string {
  const text = rawText.trim();
  if (!text) return '';
  if (/^(❌|⛔|🚫|🔴)/.test(text)) return 'danger';
  if (/^(⚠|🟡|🟠)/.test(text)) return 'warning';
  if (/^(✅|✔|🟢)/.test(text)) return 'success';
  if (/(无|未发现|没有|不存在)\s*(错误|异常|失败|告警|警告)/.test(text)) return 'success';
  if (/(失败|错误|异常|不通|不可用|已中断|崩溃|拒绝|超限|error|failed|failure|fatal|critical|down)/i.test(text)) return 'danger';
  if (/(警告|告警|注意|超时|待确认|降级|重试中?|风险|warn|warning|timeout|degraded|pending)/i.test(text)) return 'warning';
  if (/^(成功|正常|已恢复|通过|就绪|healthy|ok|success|passed|ready|running)$/i.test(text)) return 'success';
  return '';
}

const markdownComponents: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  table({ children }) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
  td({ node: _node, children, ...props }) {
    const tone = statusTone(reactNodeText(children));
    return <td className={tone ? `cell-${tone}` : undefined} {...props}>{children}</td>;
  },
  blockquote({ children }) {
    const tone = statusTone(reactNodeText(children));
    return <blockquote className={tone && tone !== 'success' ? `md-alert md-alert-${tone}` : undefined}>{children}</blockquote>;
  },
  p({ children }) {
    const text = reactNodeText(children).trim();
    let tone = '';
    if (/^(❌|⛔|🚫|🔴)/.test(text) || /^.{0,16}(失败|错误|异常)[:：]/.test(text)) tone = 'danger';
    else if (/^(⚠|🟡|🟠)/.test(text) || /^.{0,12}(警告|告警|注意)[:：]/.test(text)) tone = 'warning';
    return <p className={tone ? `md-line md-line-${tone}` : undefined}>{children}</p>;
  },
  code({ className, children, ...props }) {
    const language = /language-([\w-]+)/.exec(className || '')?.[1];
    const codeText = String(children ?? '').replace(/\n$/, '');
    const isBlock = Boolean(language) || codeText.includes('\n');
    if (language === 'mermaid') {
      return <MermaidDiagram code={codeText} />;
    }
    if (isBlock) {
      return (
        <div className="markdown-code-frame">
          {language ? <div className="markdown-code-language">{language}</div> : null}
          <pre className="markdown-code-block">
            <code className={cn(className, 'markdown-code')} {...props}>{children}</code>
          </pre>
        </div>
      );
    }
    return <code className="markdown-inline-code" {...props}>{children}</code>;
  },
  a({ href, children }) {
    return (
      <a className="markdown-link" href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        skipHtml
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** 自动压缩产生的历史摘要：折叠展示，避免占满时间线。 */
function ContextSummaryBlock({ text }: { text: string }) {
  const content = text.startsWith(CONTEXT_SUMMARY_PREFIX)
    ? text.slice(CONTEXT_SUMMARY_PREFIX.length).trim()
    : text;
  return (
    <details className="thinking-block context-summary">
      <summary>
        <Cpu />
        历史摘要（自动压缩）
      </summary>
      <div className="thinking-content">{renderTextLines(content, 'context-summary')}</div>
    </details>
  );
}

function MessageContent({ message }: { message: ChatMessage }) {
  const segments = splitThinkingSegments(message.text);
  const thinkingSegments = [
    ...(message.thinking ? [{ content: message.thinking, streaming: !message.text.trim() }] : []),
    ...segments.filter((segment) => segment.type === 'thinking').map((segment) => ({
      content: segment.content,
      streaming: segment.streaming,
    })),
  ];
  const textSegments = segments.filter((segment) => segment.type === 'text');
  if (message.summary) return <ContextSummaryBlock text={message.text} />;
  return (
    <>
      {message.notices?.map((notice, index) => (
        <div key={`notice-${index}`} className="context-notice">{notice}</div>
      ))}
      {message.retrying ? <div className="context-notice retry-notice">{message.retrying}</div> : null}
      {thinkingSegments.map((segment, index) => (
        <ThinkingBlock key={`thinking-${index}`} content={segment.content} streaming={segment.streaming} />
      ))}
      {/* 有 todo 计划时以 todo 清单作为进度；无计划的简单任务才回退到按工具调用展示步骤。 */}
      {message.todos?.length ? <TodoList todos={message.todos} /> : null}
      {!message.todos?.length && message.steps?.length ? <TaskProgress steps={message.steps} /> : null}
      {textSegments.map((segment, index) => (
        <Fragment key={`text-${index}`}>
          {message.role === 'assistant'
            ? <MarkdownMessage content={segment.content} />
            : renderTextLines(segment.content, `text-${index}`)}
        </Fragment>
      ))}
      {message.files?.length ? <DownloadFiles files={message.files} /> : null}
    </>
  );
}

function BrandLogo({ className }: { className?: string }) {
  return (
    <span className={cn('brand-logo', className)} aria-hidden="true">
      <img src={logoUrl} alt="" />
    </span>
  );
}

function MessageAvatar({ isUser }: { isUser: boolean }) {
  return (
    <div className={cn('avatar', 'message-avatar-image', isUser && 'user-avatar')}>
      <img src={isUser ? userAvatarUrl : aiAvatarUrl} alt="" />
      <span>{isUser ? <User /> : <Bot />}</span>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<PageId | 'login'>(initialPage);
  const [token, setToken] = useState(() => readStorage('aiop_token'));
  const [sessionId, setSessionId] = useState(() => readStorage('aiop_session_id') || numericSessionId());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [contextUsage, setContextUsage] = useState<Record<string, ContextUsageBody>>({});
  const [sessionCostUsd, setSessionCostUsd] = useState<Record<string, number>>({});
  const [pendingQuestions, setPendingQuestions] = useState<Record<string, PendingQuestion>>({});
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [sandboxProfiles, setSandboxProfiles] = useState<SandboxProfileSummary[]>([]);
  const [llm, setLlm] = useState<RuntimeModelConfig>(defaultLlmConfig);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [authStatus, setAuthStatus] = useState('');
  const [historyOpen, setHistoryOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewWidth, setPreviewWidth] = useState(() => clampPreviewWidth(readStorage('aiop_sandbox_width') || 440));
  const [sandboxOutput, setSandboxOutput] = useState('');
  const [browserStreamUrl, setBrowserStreamUrl] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [toolTestOutput, setToolTestOutput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [sessionMessageCache, setSessionMessageCache] = useState<Record<string, ChatMessage[]>>({});
  const [composerValue, setComposerValue] = useState('');
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [runningAgentCount, setRunningAgentCount] = useState(0);
  const [activeRunSessionIds, setActiveRunSessionIds] = useState<Set<string>>(() => new Set());
  const [terminatingSession, setTerminatingSession] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogRequest | null>(null);
  const [confirmDialogBusy, setConfirmDialogBusy] = useState(false);
  const [skillShortcutDraft, setSkillShortcutDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionIdRef = useRef(sessionId);
  const sessionOffsetRef = useRef(0);
  const messagesRef = useRef(messages);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    writeStorage('aiop_session_id', sessionId);
  }, [sessionId]);

  useEffect(() => {
    messagesRef.current = messages;
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return;
    setSessionMessageCache((current) => (
      current[currentSessionId] === messages ? current : { ...current, [currentSessionId]: messages }
    ));
  }, [messages]);

  function activateSession(nextSessionId: string) {
    sessionIdRef.current = nextSessionId;
    setSessionId(nextSessionId);
    writeStorage('aiop_session_id', nextSessionId);
  }

  function showSessionMessages(nextSessionId: string, nextMessages: ChatMessage[]) {
    activateSession(nextSessionId);
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setSessionMessageCache((current) => ({ ...current, [nextSessionId]: nextMessages }));
  }

  function updateSessionMessages(targetSessionId: string, updater: (current: ChatMessage[]) => ChatMessage[]) {
    if (!targetSessionId) return;
    if (sessionIdRef.current === targetSessionId) {
      setMessages((current) => {
        const next = updater(current);
        messagesRef.current = next;
        return next;
      });
      return;
    }
    setSessionMessageCache((current) => {
      const base = current[targetSessionId] || initialMessages.slice(0, 1);
      return { ...current, [targetSessionId]: updater(base) };
    });
  }

  const redirectToLogin = useCallback(() => {
    setPage('login');
    setToken('');
    writeStorage('aiop_token', '');
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.history.replaceState({}, '', '/login');
    }
  }, []);

  const routeAfterLogin = useCallback(() => {
    setPage('chat');
    if (typeof window !== 'undefined' && window.location.pathname === '/login') {
      window.history.replaceState({}, '', '/');
    }
  }, []);

  const api = useMemo(() => createApi(token, redirectToLogin), [token, redirectToLogin]);

  const loadLlmSettings = useCallback(async () => {
    const body = await api.get<ModelSettingsBody>('/v1/settings/llm');
    setLlm((current) => ({ ...current, ...body.config, options: body.options || current.options || [] }));
  }, [api]);

  const fetchSessionsPage = useCallback(async (offset = 0) => {
    let body = await api.get<SessionsBody>(`/v1/sessions?limit=${SESSION_PAGE_SIZE}&offset=${offset}`);
    let effectiveOffset = offset;
    // 当前页被删空时回退到最后一页
    if (!body.sessions?.length && offset > 0) {
      const total = body.total ?? 0;
      const lastPageOffset = Math.max(0, Math.ceil(Math.max(total, 1) / SESSION_PAGE_SIZE) - 1) * SESSION_PAGE_SIZE;
      if (lastPageOffset !== offset) {
        effectiveOffset = lastPageOffset;
        body = await api.get<SessionsBody>(`/v1/sessions?limit=${SESSION_PAGE_SIZE}&offset=${effectiveOffset}`);
      }
    }
    const next = body.sessions?.map(mapSessionSummary) || [];
    setSessions(next);
    setSessionOffset(effectiveOffset);
    sessionOffsetRef.current = effectiveOffset;
    setSessionTotal(body.total ?? next.length);
  }, [api]);

  const refreshSessions = useCallback(async () => {
    await fetchSessionsPage(sessionOffsetRef.current);
  }, [fetchSessionsPage]);

  const loadContextUsage = useCallback(async (nextSessionId: string) => {
    if (!nextSessionId) return;
    try {
      const body = await api.get<ContextUsageBody>(`/v1/sessions/${encodeURIComponent(nextSessionId)}/context`);
      setContextUsage((current) => ({ ...current, [nextSessionId]: body }));
    } catch (err) {
      console.error(err);
    }
  }, [api]);

  useEffect(() => {
    if (!token || !sessionId) return;
    void loadContextUsage(sessionId);
  }, [loadContextUsage, sessionId, token]);

  const loadPageData = useCallback(async (target: PageId | 'login' = page) => {
    if (!token || target === 'login') return;
    try {
      if (target === 'chat') {
        await loadLlmSettings();
        await fetchSessionsPage(0);
        const toolsBody = await api.get<ToolsBody>('/v1/tools');
        setTools(toolsBody.tools || []);
      }
      if (target === 'skills' || target === 'mcp') {
        const body = await api.get<ToolsBody>('/v1/tools');
        setTools(body.tools || []);
      }
      if (target === 'schedule') {
        const body = await api.get<ScheduleBody>('/v1/schedule');
        setTasks(body.tasks || []);
      }
      if (target === 'sandbox') {
        const body = await api.get<SandboxesBody>('/v1/sandboxes');
        setSandboxes(body.sandboxes || []);
        setSandboxProfiles(body.profiles || []);
      }
      if (target === 'settings') await loadLlmSettings();
    } catch (err) {
      console.error(err);
    }
  }, [api, fetchSessionsPage, loadLlmSettings, page, token]);

  useEffect(() => {
    if (!token && page !== 'login') {
      redirectToLogin();
      return;
    }
    void loadPageData(page);
  }, [loadPageData, page, redirectToLogin, token]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tenantId = String(form.get('tenantId') || 'default').trim() || 'default';
    const username = String(form.get('username') || '').trim();
    const password = String(form.get('password') || '');
    if (!username || !password) {
      setAuthStatus('请输入用户名和密码。');
      return;
    }
    setAuthStatus('正在登录...');
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId, username, password }),
    });
    if (!response.ok) {
      setAuthStatus('登录失败，请检查用户名或密码。');
      return;
    }
    const body = await response.json() as { token: string };
    setToken(body.token);
    writeStorage('aiop_token', body.token);
    setAuthStatus('');
    routeAfterLogin();
  }

  function navigate(next: PageId) {
    if (!token) {
      redirectToLogin();
      return;
    }
    setPage(next);
    if (typeof window !== 'undefined') window.history.replaceState({}, '', '/');
  }

  async function selectSession(session: SessionSummary) {
    if (!session.sessionId) return;
    try {
      const cachedMessages = sessionMessageCache[session.sessionId];
      if (activeRunSessionIds.has(session.sessionId) && cachedMessages?.length) {
        showSessionMessages(session.sessionId, cachedMessages);
        setAttachments([]);
        void loadContextUsage(session.sessionId);
        return;
      }
      const body = await api.get<SessionMessagesBody>(`/v1/sessions/${encodeURIComponent(session.sessionId)}/messages`);
      showSessionMessages(session.sessionId, sessionMessagesToChatMessages(body));
      setAttachments([]);
      void loadContextUsage(session.sessionId);
    } catch (err) {
      setMessages([{
        id: randomId(),
        role: 'assistant',
        text: `加载会话失败：${formatError(err)}`,
        time: new Date().toLocaleTimeString(),
      }]);
    }
  }

  async function startNewSession() {
    const id = numericSessionId();
    showSessionMessages(id, initialMessages.slice(0, 1));
    setAttachments([]);
    setContextUsage((current) => ({
      ...current,
      [id]: { sessionId: id, usedTokens: 0, maxTokens: llm.context_window_tokens || 200000, estimated: true },
    }));
    try {
      await api.post<{ session: SessionsBody['sessions'][number] }>('/v1/sessions', {
        sessionId: id,
        title: '新会话',
      });
      await fetchSessionsPage(0);
      void loadContextUsage(id);
    } catch (err) {
      setMessages((current) => [...current, {
        id: randomId(),
        role: 'assistant',
        text: `创建会话失败：${formatError(err)}`,
        time: new Date().toLocaleTimeString(),
      }]);
    }
  }

  async function goToPrevSessionsPage() {
    if (sessionOffset <= 0) return;
    await fetchSessionsPage(Math.max(0, sessionOffset - SESSION_PAGE_SIZE));
  }

  async function goToNextSessionsPage() {
    if (sessionOffset + SESSION_PAGE_SIZE >= sessionTotal) return;
    await fetchSessionsPage(sessionOffset + SESSION_PAGE_SIZE);
  }

  function requestConfirmDialog(request: ConfirmDialogRequest) {
    if (confirmDialogBusy) return;
    setConfirmDialog(request);
  }

  function cancelConfirmDialog() {
    if (confirmDialogBusy) return;
    setConfirmDialog(null);
  }

  async function runConfirmDialogAction() {
    if (!confirmDialog || confirmDialogBusy) return;
    setConfirmDialogBusy(true);
    try {
      await confirmDialog.onConfirm();
    } catch (err) {
      console.error(err);
    } finally {
      setConfirmDialogBusy(false);
      setConfirmDialog(null);
    }
  }

  function requestDeleteSessions(items: SessionSummary[]) {
    const targets = items.filter((item) => item.sessionId);
    if (!targets.length) return;
    requestConfirmDialog({
      title: `删除选中的 ${targets.length} 条会话？`,
      description: '删除后，这些会话记录和历史消息将从列表中移除。',
      alert: '此操作不可恢复，请确认不再需要这些会话记录。',
      confirmLabel: '确认删除',
      busyLabel: '删除中',
      tone: 'danger',
      onConfirm: () => deleteSessions(targets),
    });
  }

  async function deleteSessions(targets: SessionSummary[]) {
    const targetIds = targets.map((item) => item.sessionId).filter((id): id is string => Boolean(id));
    const results = await Promise.allSettled(targetIds.map((id) =>
      api.delete<{ ok: boolean }>(`/v1/sessions/${encodeURIComponent(id)}`),
    ));
    const deletedIds = targetIds.filter((_, index) => results[index].status === 'fulfilled');
    const failedCount = results.length - deletedIds.length;
    await refreshSessions();
    if (deletedIds.includes(sessionId)) await startNewSession();
    if (failedCount > 0) {
      setMessages((current) => [...current, {
        id: randomId(),
        role: 'assistant',
        text: `有 ${failedCount} 条会话删除失败，请稍后重试。`,
        time: new Date().toLocaleTimeString(),
      }]);
    }
  }

  async function terminateCurrentSession() {
    if (!sessionId || runningAgentCount <= 0 || terminatingSession) return;
    setTerminatingSession(true);
    try {
      await api.post<{ ok: boolean; sessionId: string; aborted: number }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/terminate`,
      );
    } catch (err) {
      setMessages((current) => [...current, {
        id: randomId(),
        role: 'assistant',
        text: `停止任务失败：${formatError(err)}`,
        time: new Date().toLocaleTimeString(),
      }]);
    } finally {
      setTerminatingSession(false);
    }
  }

  function requestStopCurrentSession() {
    if (!sessionId || runningAgentCount <= 0 || terminatingSession) return;
    requestConfirmDialog({
      title: '确认停止当前任务？',
      description: '停止后，当前会话正在执行的模型响应和工具调用会被中断。',
      alert: '中断执行前请确认影响范围，已产生的消息和工具输出会保留。',
      confirmLabel: '确认停止',
      busyLabel: '停止中',
      tone: 'danger',
      onConfirm: terminateCurrentSession,
    });
  }

  async function addAttachments(fileList: FileList | null) {
    const files = [...(fileList || [])].slice(0, 6);
    if (!files.length) return;
    const loaded: Attachment[] = [];
    for (const file of files) {
      loaded.push({
        id: randomId(),
        name: file.name || 'attachment',
        type: file.type || 'application/octet-stream',
        size: file.size || 0,
        data: await readFileAsDataUrl(file),
      });
    }
    setAttachments((current) => [...current, ...loaded]);
  }

  function insertComposerNewline(textarea: HTMLTextAreaElement) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    if (typeof textarea.setRangeText === 'function') {
      textarea.setRangeText('\n', start, end, 'end');
    } else {
      textarea.value = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + 1;
    }
    setComposerValue(textarea.value);
  }

  async function runAgent(task: string, files: Omit<Attachment, 'id'>[] = [], requestSessionId = sessionId) {
    const payload = { task, sessionId: requestSessionId, attachments: files };
    let activeSessionId = requestSessionId;
    const response = await fetch('/v1/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    if (!response.ok || !response.body) {
      // 带出后端错误详情（如 409 会话正在运行的互斥提示），而不是只报状态码。
      const detail = await response.json().then((body: { error?: string }) => body?.error).catch(() => undefined);
      setMessages((current) => [...current, { id: randomId(), role: 'assistant', text: `请求失败：${detail || response.status}`, time: new Date().toLocaleTimeString() }]);
      return;
    }
    const assistantId = randomId();
    const assistant: ChatMessage = { id: assistantId, role: 'assistant', text: '', time: new Date().toLocaleTimeString(), running: true };
    const publishAssistant = () => {
      updateSessionMessages(activeSessionId, (current) => current.map((message) => (message.id === assistantId ? { ...assistant } : message)));
    };
    updateSessionMessages(requestSessionId, (current) => [...current, assistant]);
    setRunningAgentCount((current) => current + 1);
    setActiveRunSessionIds((current) => new Set(current).add(requestSessionId));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // 沙箱执行过程汇入右侧面板终端：首个沙箱事件出现时才清空旧内容，
    // 避免无沙箱调用的对话误清手动运行的输出。
    let terminalBuffer = '';
    let terminalStarted = false;
    const pushTerminal = (chunk: string) => {
      if (!terminalStarted) {
        terminalStarted = true;
        terminalBuffer = '';
      }
      terminalBuffer += chunk;
      setSandboxOutput(terminalBuffer);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const event = parseSse(part);
          if (event?.event === 'session' && typeof event.data?.sessionId === 'string') {
            const previousSessionId = activeSessionId;
            activeSessionId = event.data.sessionId;
            if (previousSessionId !== activeSessionId) {
              setSessionMessageCache((current) => {
                if (current[activeSessionId]) return current;
                const previousMessages = current[previousSessionId]
                  || (sessionIdRef.current === previousSessionId ? messagesRef.current : undefined);
                return previousMessages ? { ...current, [activeSessionId]: previousMessages } : current;
              });
            }
            activateSession(event.data.sessionId);
            setActiveRunSessionIds((current) => new Set(current).add(event.data!.sessionId as string));
          }
          if (event?.event === 'thinking_delta' && typeof event.data?.text === 'string') {
            assistant.thinking = `${assistant.thinking || ''}${event.data.text}`;
            assistant.retrying = undefined; // 输出恢复即清除重试提示
            publishAssistant();
          }
          if (event?.event === 'text_delta' && typeof event.data?.text === 'string') {
            assistant.text += event.data.text;
            assistant.retrying = undefined;
            publishAssistant();
          }
          if (event?.event === 'model_retry' && typeof event.data?.attempt === 'number') {
            // 重试会整轮重放：回滚失败尝试已流式展示的部分输出，丢弃未执行的工具步骤
            const discardText = typeof event.data.discardTextChars === 'number' ? event.data.discardTextChars : 0;
            const discardThinking = typeof event.data.discardThinkingChars === 'number' ? event.data.discardThinkingChars : 0;
            if (discardText > 0) assistant.text = assistant.text.slice(0, -discardText);
            if (discardThinking > 0 && assistant.thinking) assistant.thinking = assistant.thinking.slice(0, -discardThinking);
            const discardIds = Array.isArray(event.data.discardToolIds) ? (event.data.discardToolIds as string[]) : [];
            if (discardIds.length && assistant.steps?.length) {
              assistant.steps = assistant.steps.filter((s) => !discardIds.includes(s.id));
            }
            const error = typeof event.data.error === 'string' ? event.data.error : '';
            assistant.retrying = `模型调用异常，正在自动重试（第 ${event.data.attempt}/${event.data.maxAttempts ?? 10} 次）${error ? `：${error}` : ''}`;
            publishAssistant();
          }
          if (event?.event === 'tool_call' && event.data?.call) {
            const call = event.data.call as { id?: string };
            if (typeof call.id === 'string') {
              const step: TaskStep = { id: call.id, label: stepLabel(event.data.call), status: 'running' };
              assistant.steps = [...(assistant.steps || []), step];
              publishAssistant();
            }
            // 仅沙箱/kubectl 工具的命令进右侧终端面板
            const line = sandboxCommandLine(event.data.call);
            if (line) pushTerminal(`${terminalStarted ? '\n' : ''}$ ${line}\n`);
          }
          if (
            event?.event === 'tool_output'
            && typeof event.data?.text === 'string'
            && (event.data?.stream === 'stdout' || event.data?.stream === 'stderr')
          ) {
            pushTerminal(formatSandboxOutputChunk(event.data.stream, event.data.text));
          }
          if (
            (event?.event === 'question_required' || event?.event === 'change_plan_required')
            && event.data && typeof event.data.id === 'string' && Array.isArray(event.data.questions)
          ) {
            const pending: PendingQuestion = {
              id: event.data.id as string,
              sessionId: (event.data.sessionId as string) || activeSessionId,
              questions: event.data.questions as PendingQuestion['questions'],
              plan: (event.data as { plan?: PendingQuestion['plan'] }).plan,
            };
            setPendingQuestions((current) => ({ ...current, [pending.sessionId]: pending }));
          }
          if (event?.event === 'todo_updated' && Array.isArray(event.data?.todos)) {
            assistant.todos = (event.data.todos as TodoItem[]).filter(
              (t) => t && typeof t.content === 'string' && typeof t.status === 'string',
            );
            publishAssistant();
          }
          if (event?.event === 'tool_result' && typeof event.data?.toolId === 'string') {
            const toolId = event.data.toolId;
            const status: TaskStep['status'] = event.data.isError === true ? 'error' : 'done';
            assistant.steps = (assistant.steps || []).map((s) => (s.id === toolId ? { ...s, status } : s));
            publishAssistant();
          }
          if (
            event?.event === 'file_exported'
            && typeof event.data?.url === 'string'
            && typeof event.data?.name === 'string'
          ) {
            const file: ExportedFile = {
              name: event.data.name as string,
              url: event.data.url as string,
              size: typeof event.data.size === 'number' ? event.data.size : 0,
              mime: typeof event.data.mime === 'string' ? event.data.mime : '',
              expiresAt: typeof event.data.expiresAt === 'string' ? event.data.expiresAt : '',
            };
            // 去重：同一 URL 只保留一份。
            assistant.files = [...(assistant.files || []).filter((f) => f.url !== file.url), file];
            publishAssistant();
          }
          if (
            event?.event === 'context_compacted'
            && typeof event.data?.summarizedMessages === 'number'
            && typeof event.data?.beforeTokens === 'number'
            && typeof event.data?.afterTokens === 'number'
          ) {
            const notice = `已自动压缩上下文：${event.data.summarizedMessages} 条较早消息摘要为一段（${formatTokenCount(event.data.beforeTokens)} → ${formatTokenCount(event.data.afterTokens)} tokens）`;
            assistant.notices = [...(assistant.notices || []), notice];
            publishAssistant();
          }
          if (event?.event === 'terminated') {
            assistant.text = assistant.text.trim()
              ? `${assistant.text}\n\n已终止当前运行。`
              : '已终止当前运行。';
            publishAssistant();
          }
          if (event?.event === 'error') {
            const message = typeof event.data?.error === 'string' ? event.data.error : '运行失败';
            assistant.text = assistant.text.trim()
              ? `${assistant.text}\n\n运行失败：${message}`
              : `运行失败：${message}`;
            publishAssistant();
          }
          if (event?.event === 'done' && typeof event.data?.sessionId === 'string') {
            activateSession(event.data.sessionId);
            // SSE payloads may provide event.data?.context or event.data?.usage?.context.
            const eventData = event.data as { context?: unknown; usage?: { context?: unknown } };
            const nextContext = isContextUsage(eventData.context)
              ? eventData.context
              : isContextUsage(eventData.usage?.context)
                ? eventData.usage.context
                : undefined;
            if (nextContext) {
              setContextUsage((current) => ({ ...current, [event.data!.sessionId as string]: nextContext }));
            }
            const cost = (event.data as { cost?: { costUsd?: number } }).cost;
            if (typeof cost?.costUsd === 'number') {
              setSessionCostUsd((current) => ({ ...current, [event.data!.sessionId as string]: cost.costUsd as number }));
            }
          }
        }
      }
    } catch (err) {
      assistant.text = assistant.text.trim()
        ? `${assistant.text}\n\n连接中断：${formatError(err)}`
        : `连接中断：${formatError(err)}`;
    } finally {
      // 运行结束：未收到结果的步骤（连接中断等）标记为失败，避免一直转圈。
      if (assistant.steps?.some((s) => s.status === 'running')) {
        assistant.steps = assistant.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s));
      }
      Object.assign(assistant, { running: false, retrying: undefined });
      publishAssistant();
      setRunningAgentCount((current) => Math.max(0, current - 1));
      setActiveRunSessionIds((current) => {
        const next = new Set(current);
        next.delete(requestSessionId);
        next.delete(activeSessionId);
        return next;
      });
      await refreshSessions();
      await loadContextUsage(activeSessionId);
    }
  }

  async function appendToActiveSession(task: string, files: Omit<Attachment, 'id'>[]) {
    try {
      await api.post<{ ok: boolean; sessionId: string; queued: boolean }>(`/v1/sessions/${encodeURIComponent(sessionId)}/append`, {
        task,
        attachments: files,
      });
      await loadContextUsage(sessionId);
    } catch (err) {
      setMessages((current) => [...current, {
        id: randomId(),
        role: 'assistant',
        text: `追加消息失败：${formatError(err)}`,
        time: new Date().toLocaleTimeString(),
      }]);
    }
  }

  async function submitQuestionAnswer(pending: PendingQuestion, answers: Record<string, string[]>) {
    // 乐观清除，避免重复提交；失败则恢复。
    setPendingQuestions((current) => {
      const next = { ...current };
      delete next[pending.sessionId];
      return next;
    });
    try {
      await api.post<{ ok: boolean }>(`/v1/questions/${encodeURIComponent(pending.id)}/answer`, { answers });
    } catch (err) {
      setPendingQuestions((current) => ({ ...current, [pending.sessionId]: pending }));
      setMessages((currentMessages) => [...currentMessages, {
        id: randomId(),
        role: 'assistant',
        text: `提交回答失败：${formatError(err)}`,
        time: new Date().toLocaleTimeString(),
      }]);
    }
  }

  function sendComposer() {
    const task = composerValue.trim();
    const files = attachments.map(publicAttachment);
    if (!task && !files.length) return;
    const taskForAgent = applySkillShortcut(task, skillTools);
    const sentAttachments = attachments;
    updateSessionMessages(sessionId, (current) => [...current, {
      id: randomId(),
      role: 'user',
      text: task || '请分析上传附件。',
      time: new Date().toLocaleTimeString(),
      attachments: sentAttachments,
    }]);
    setComposerValue('');
    setSkillShortcutDraft('');
    setAttachments([]);
    if (activeRunSessionIds.has(sessionId)) {
      void appendToActiveSession(taskForAgent || '请分析上传附件。', files);
      return;
    }
    void runAgent(taskForAgent || '请分析上传附件。', files, sessionId);
  }

  function handleComposerKeydown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    if (event.altKey) {
      event.preventDefault();
      insertComposerNewline(event.currentTarget);
      return;
    }
    event.preventDefault();
    void sendComposer();
  }

  async function runSandboxCode(code: string, language: string) {
    if (!code.trim()) return;
    const command = sandboxOutputCommand(language, code);
    setSandboxOutput(`$ ${command}\n正在沙箱中运行代码...`);
    try {
      const body = await api.post<ToolCallBody>('/v1/sandbox/run-code', { sessionId, code, language });
      setSandboxOutput(`$ ${command}\n${formatToolResponse(body)}`);
    } catch (err) {
      setSandboxOutput(`$ ${command}\n[error]\n运行失败：${formatError(err)}`);
    }
  }

  async function openBrowserStream() {
    setSandboxOutput('$ browser stream\n正在获取浏览器预览...');
    try {
      const body = await api.post<ToolCallBody>('/v1/browser/stream', { sessionId });
      const text = formatToolResponse(body);
      const url = extractUrl(text);
      if (url) setBrowserStreamUrl(url);
      setSandboxOutput(url ? `$ browser stream\n${text}\n已加载到右侧预览。` : `$ browser stream\n${text}`);
    } catch (err) {
      setSandboxOutput(`$ browser stream\n[error]\n预览获取失败：${formatError(err)}`);
    }
  }

  async function captureBrowserScreenshot() {
    setSandboxOutput('$ browser screenshot\n正在刷新浏览器截图...');
    try {
      const body = await api.post<ToolCallBody>('/v1/browser/screenshot', { sessionId });
      setSandboxOutput(`$ browser screenshot\n${formatToolResponse(body)}`);
    } catch (err) {
      setSandboxOutput(`$ browser screenshot\n[error]\n截图失败：${formatError(err)}`);
    }
  }

  async function switchComposerModel(id: string) {
    if (!id) return;
    setSettingsStatus('正在切换模型...');
    try {
      const body = await api.post<ModelSettingsBody>('/v1/settings/llm', { id });
      setLlm((current) => ({ ...current, ...body.config, options: body.options || current.options || [] }));
      setSettingsStatus('模型已切换。');
    } catch (err) {
      setSettingsStatus(`模型切换失败：${formatError(err)}`);
    }
  }

  function startPreviewResize(event: PointerEvent<HTMLButtonElement>) {
    if (!previewOpen) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = previewWidth;
    document.body.classList.add('resizing-preview');
    const move = (moveEvent: globalThis.PointerEvent) => {
      setPreviewWidth(clampPreviewWidth(startWidth - (moveEvent.clientX - startX)));
    };
    const up = () => {
      document.body.classList.remove('resizing-preview');
      writeStorage('aiop_sandbox_width', String(clampPreviewWidth(startWidth)));
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  useEffect(() => {
    writeStorage('aiop_sandbox_width', String(previewWidth));
  }, [previewWidth]);

  async function testTool(name: string, rawArgs: string) {
    if (!name) return;
    setToolTestOutput('正在调用工具...');
    try {
      const args = rawArgs.trim() ? JSON.parse(rawArgs) as unknown : {};
      const body = await api.post<ToolCallBody>('/v1/tools/call', { sessionId, name, args });
      setToolTestOutput(formatToolResponse(body));
    } catch (err) {
      setToolTestOutput(`调用失败：${formatError(err)}`);
    }
  }

  async function testMcpTool(name: string, rawArgs: string) {
    await testTool(name, rawArgs);
  }

  if (page === 'login') {
    return <LoginPage authStatus={authStatus} onSubmit={submitLogin} />;
  }

  const activePage = page as PageId;
  const skillTools = tools.filter((tool) => (tool.category || toolCategory(tool.name)) === 'skill');
  const mcpTools = tools.filter((tool) => (tool.category || toolCategory(tool.name)) === 'mcp');
  const skillSuggestions = skillSuggestionsFor(composerValue, skillTools);

  if (activePage === 'chat') {
    return (
      <TooltipProvider>
        <PrototypeChatShell
          token={token}
          historyOpen={historyOpen}
          previewOpen={previewOpen}
          previewWidth={previewWidth}
          sessions={sessions}
          sessionTotal={sessionTotal}
          sessionPage={Math.floor(sessionOffset / SESSION_PAGE_SIZE) + 1}
          sessionPageCount={Math.max(1, Math.ceil(sessionTotal / SESSION_PAGE_SIZE))}
          selectedSessionId={sessionId}
          contextUsage={contextUsage[sessionId]}
          sessionCostUsd={sessionCostUsd[sessionId]}
          pendingQuestion={pendingQuestions[sessionId]}
          onAnswerQuestion={submitQuestionAnswer}
          messages={messages}
          attachments={attachments}
          composerValue={composerValue}
          skillSuggestions={skillSuggestions}
          skillShortcutDraft={skillShortcutDraft}
          llm={llm}
          settingsStatus={settingsStatus}
          runningAgentCount={runningAgentCount}
          terminatingSession={terminatingSession}
          sandboxOutput={sandboxOutput}
          browserStreamUrl={browserStreamUrl}
          composerRef={composerRef}
          fileInputRef={fileInputRef}
          onNavigate={navigate}
          onLogout={redirectToLogin}
          onToggleHistory={() => setHistoryOpen((value) => !value)}
          onTogglePreview={() => setPreviewOpen((value) => !value)}
          onNewSession={startNewSession}
          onRequestStopSession={requestStopCurrentSession}
          onSelectSession={selectSession}
          onDeleteSessions={requestDeleteSessions}
          onPrevSessionsPage={() => void goToPrevSessionsPage()}
          onNextSessionsPage={() => void goToNextSessionsPage()}
          onChooseAttachment={() => fileInputRef.current?.click()}
          onAddAttachments={(files) => void addAttachments(files)}
          onRemoveAttachment={(id) => setAttachments((current) => current.filter((file) => file.id !== id))}
          onComposerChange={(value) => {
            setComposerValue(value);
            setSkillShortcutDraft(value.startsWith('/') ? value : '');
          }}
          onChooseSkillSuggestion={(skill) => {
            const next = `/${skill.name} `;
            setComposerValue(next);
            setSkillShortcutDraft(next);
            requestAnimationFrame(() => composerRef.current?.focus());
          }}
          onComposerKeydown={handleComposerKeydown}
          onSubmitComposer={(event) => {
            event.preventDefault();
            sendComposer();
          }}
          onModelSwitch={(id) => void switchComposerModel(id)}
          onRunSandbox={runSandboxCode}
          onOpenPreview={() => void openBrowserStream()}
          onRefreshPreview={() => void captureBrowserScreenshot()}
          onStartResize={startPreviewResize}
        />
        <ConfirmDialog
          request={confirmDialog}
          busy={confirmDialogBusy}
          onConfirm={() => void runConfirmDialogAction()}
          onCancel={cancelConfirmDialog}
        />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="prototype-chat-page management-page">
        <div className="prototype-main-content management-main-content">
          <PrototypeSidebarNav page={activePage} token={token} onNavigate={navigate} onLogout={redirectToLogin} />
          <main className="main-shell">
          <section className="content-shell content-wide">
            {activePage === 'skills' && (
              <SkillsPage
                tools={skillTools.length ? skillTools : fallbackTools.filter((tool) => tool.category === 'skill')}
                api={api}
                onImported={() => loadPageData('skills')}
                onRequestConfirm={requestConfirmDialog}
              />
            )}
            {activePage === 'mcp' && <McpPage tools={mcpTools} api={api} output={toolTestOutput} onTest={testMcpTool} onRequestConfirm={requestConfirmDialog} onChanged={() => void loadPageData('mcp')} />}
            {activePage === 'schedule' && <SchedulePage tasks={tasks} api={api} onChanged={() => void loadPageData('schedule')} onRequestConfirm={requestConfirmDialog} />}
            {activePage === 'sandbox' && <SandboxPage sandboxes={sandboxes} profiles={sandboxProfiles} />}
            {activePage === 'settings' && <SettingsPage llm={llm} status={settingsStatus} api={api} onLlmChange={setLlm} onStatus={setSettingsStatus} />}
          </section>
          </main>
        </div>
      </div>
      <ConfirmDialog
        request={confirmDialog}
        busy={confirmDialogBusy}
        onConfirm={() => void runConfirmDialogAction()}
        onCancel={cancelConfirmDialog}
      />
    </TooltipProvider>
  );
}

function Sidebar({ page, token, onNavigate, onLogout }: {
  page: PageId;
  token: string;
  onNavigate: (page: PageId) => void;
  onLogout: () => void;
}) {
  return (
    <aside className="sidebar" aria-label="主导航">
      <BrandLogo className="brand-logo-rail" />
      <nav className="nav-rail">
        {NAV_ITEMS.map((item) => {
          const Icon = iconMap[item.icon];
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  className={cn('nav-btn', page === item.id && 'active')}
                  type="button"
                  aria-label={item.label}
                  onClick={() => onNavigate(item.id)}
                >
                  <Icon />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
      <SidebarAccountMenu token={token} onLogout={onLogout} />
    </aside>
  );
}

function SidebarAccountMenu({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sidebar-account">
      <button
        className={cn('account-avatar-button', open && 'active')}
        type="button"
        aria-label="用户菜单"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <img src={userAvatarUrl} alt="" />
      </button>
      {open ? (
        <div className="account-popover" role="menu">
          <div className="account-popover-user">
            <img src={userAvatarUrl} alt="" />
            <div>
              <strong>{token ? 'platform_admin' : '未登录'}</strong>
              <span>租户 default</span>
            </div>
          </div>
          <Separator />
          <Button variant="ghost" size="sm" type="button" role="menuitem" onClick={onLogout}>
            <LogOut data-icon="inline-start" />
            退出
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PrototypeChatShell(props: {
  token: string;
  historyOpen: boolean;
  previewOpen: boolean;
  previewWidth: number;
  sessions: SessionSummary[];
  sessionTotal: number;
  sessionPage: number;
  sessionPageCount: number;
  selectedSessionId: string;
  contextUsage?: ContextUsageBody;
  sessionCostUsd?: number;
  pendingQuestion?: PendingQuestion;
  onAnswerQuestion: (pending: PendingQuestion, answers: Record<string, string[]>) => void;
  messages: ChatMessage[];
  attachments: Attachment[];
  composerValue: string;
  skillSuggestions: ToolSummary[];
  skillShortcutDraft: string;
  llm: RuntimeModelConfig;
  settingsStatus: string;
  runningAgentCount: number;
  terminatingSession: boolean;
  sandboxOutput: string;
  browserStreamUrl: string;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onNavigate: (page: PageId) => void;
  onLogout: () => void;
  onToggleHistory: () => void;
  onTogglePreview: () => void;
  onNewSession: () => void;
  onRequestStopSession: () => void;
  onSelectSession: (session: SessionSummary) => void;
  onDeleteSessions: (sessions: SessionSummary[]) => void;
  onPrevSessionsPage: () => void;
  onNextSessionsPage: () => void;
  onChooseAttachment: () => void;
  onAddAttachments: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onComposerChange: (value: string) => void;
  onChooseSkillSuggestion: (skill: ToolSummary) => void;
  onComposerKeydown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmitComposer: (event: FormEvent<HTMLFormElement>) => void;
  onModelSwitch: (id: string) => void;
  onRunSandbox: (code: string, language: string) => void;
  onOpenPreview: () => void;
  onRefreshPreview: () => void;
  onStartResize: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="prototype-chat-page">
      <div className="prototype-main-content" id="main-content" style={{ '--sandbox-width': `${props.previewWidth}px` } as CSSProperties}>
        <PrototypeSidebarNav page="chat" token={props.token} onNavigate={props.onNavigate} onLogout={props.onLogout} />
        {props.historyOpen ? (
          <PrototypeSessionPanel
            sessions={props.sessions}
            total={props.sessionTotal}
            page={props.sessionPage}
            pageCount={props.sessionPageCount}
            selectedSessionId={props.selectedSessionId}
            onToggle={props.onToggleHistory}
            onSelect={props.onSelectSession}
            onDeleteMany={props.onDeleteSessions}
            onPrevPage={props.onPrevSessionsPage}
            onNextPage={props.onNextSessionsPage}
          />
        ) : null}
        <main className="prototype-chat-center">
          <PrototypeChatHeader
            runningAgentCount={props.runningAgentCount}
            terminatingSession={props.terminatingSession}
            contextUsage={props.contextUsage}
            sessionCostUsd={props.sessionCostUsd}
            onNewSession={props.onNewSession}
            onRequestStopSession={props.onRequestStopSession}
            onToggleHistory={props.onToggleHistory}
            onTogglePreview={props.onTogglePreview}
          />
          <PrototypeMessages messages={props.messages} />
          {props.pendingQuestion ? (
            <QuestionCard
              key={props.pendingQuestion.id}
              pending={props.pendingQuestion}
              onSubmit={(answers) => props.onAnswerQuestion(props.pendingQuestion!, answers)}
            />
          ) : null}
          <PrototypeComposer
            attachments={props.attachments}
            value={props.composerValue}
            skillSuggestions={props.skillSuggestions}
            skillShortcutDraft={props.skillShortcutDraft}
            composerRef={props.composerRef}
            fileInputRef={props.fileInputRef}
            onChooseAttachment={props.onChooseAttachment}
            onAddAttachments={props.onAddAttachments}
            onRemoveAttachment={props.onRemoveAttachment}
            onComposerChange={props.onComposerChange}
            onChooseSkillSuggestion={props.onChooseSkillSuggestion}
            onComposerKeydown={props.onComposerKeydown}
            onSubmitComposer={props.onSubmitComposer}
          />
        </main>
        {props.previewOpen ? (
          <PrototypeSandboxPanel
            sandboxOutput={props.sandboxOutput}
            browserStreamUrl={props.browserStreamUrl}
            onRunSandbox={props.onRunSandbox}
            onOpenPreview={props.onOpenPreview}
            onRefreshPreview={props.onRefreshPreview}
            onStartResize={props.onStartResize}
            onClose={props.onTogglePreview}
          />
        ) : null}
      </div>
    </div>
  );
}

function PrototypeSidebarNav({ page, token, onNavigate, onLogout }: {
  page: PageId;
  token: string;
  onNavigate: (page: PageId) => void;
  onLogout: () => void;
}) {
  return (
    <aside className="prototype-sidebar-nav" aria-label="主导航">
      <BrandLogo className="prototype-sidebar-logo" />
      {NAV_ITEMS.map((item) => {
        const Icon = iconMap[item.icon];
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn('prototype-nav-btn', item.id === page && 'active')}
                title={item.label}
                aria-label={item.label}
                onClick={() => onNavigate(item.id)}
              >
                <Icon />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        );
      })}
      <SidebarAccountMenu token={token} onLogout={onLogout} />
    </aside>
  );
}

function PrototypeSessionPanel({ sessions, total, page, pageCount, selectedSessionId, onToggle, onSelect, onDeleteMany, onPrevPage, onNextPage }: {
  sessions: SessionSummary[];
  total: number;
  page: number;
  pageCount: number;
  selectedSessionId: string;
  onToggle: () => void;
  onSelect: (session: SessionSummary) => void;
  onDeleteMany: (sessions: SessionSummary[]) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const trimmedQuery = query.trim().toLowerCase();
  const items = sessions.filter((session) => {
    const value = `${session.title} ${session.desc}`.toLowerCase();
    return value.includes(trimmedQuery);
  });
  const emptyCopy = trimmedQuery ? '没有匹配会话' : '暂无会话记录';
  const selectableIds = items.map((session) => session.sessionId).filter(Boolean) as string[];
  const checkedItems = items.filter((session) => session.sessionId && checkedIds.has(session.sessionId));
  const allChecked = selectableIds.length > 0 && selectableIds.every((id) => checkedIds.has(id));

  useEffect(() => {
    setCheckedIds((current) => {
      const valid = new Set(sessions.map((session) => session.sessionId).filter(Boolean) as string[]);
      const next = new Set(Array.from(current).filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [sessions]);

  function toggleChecked(id: string) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllChecked() {
    setCheckedIds(allChecked ? new Set() : new Set(selectableIds));
  }

  function exitSelectMode() {
    setSelectMode(false);
    setCheckedIds(new Set());
  }

  // 未进入选择模式 → 显示复选框；已勾选 → 删除；未勾选 → 退出选择模式
  function handleBatchDelete() {
    if (!selectMode) {
      setSelectMode(true);
      return;
    }
    if (checkedItems.length) {
      onDeleteMany(checkedItems);
      return;
    }
    exitSelectMode();
  }

  return (
    <aside className={cn('prototype-session-panel', selectMode && 'select-mode')}>
      <div className="prototype-session-head">
        <h2>最近会话</h2>
        <div>
          <button
            type="button"
            className={cn('prototype-batch-delete', selectMode && checkedItems.length && 'danger')}
            onClick={handleBatchDelete}
            aria-label={selectMode ? (checkedItems.length ? `删除选中的 ${checkedItems.length} 条会话` : '退出批量删除') : '批量删除会话'}
          >
            {selectMode ? (checkedItems.length ? `删除 (${checkedItems.length})` : '取消') : '批量删除'}
          </button>
          <button type="button" onClick={onToggle} aria-label="收起最近会话">
            <ChevronLeft />
          </button>
        </div>
      </div>
      <label className="prototype-session-search">
        <Search />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" />
      </label>
      {selectMode ? (
        <div className="prototype-session-toolbar">
          <label>
            <input
              type="checkbox"
              checked={allChecked}
              disabled={!selectableIds.length}
              onChange={toggleAllChecked}
              aria-label="全选会话"
            />
            全选
          </label>
          <span>{checkedItems.length ? `已选 ${checkedItems.length} 条` : '勾选要删除的会话'}</span>
        </div>
      ) : null}
      <ScrollArea className="prototype-session-scroll">
        <div className="prototype-session-group">
          <span>今天</span>
          {items.length ? items.map((session, index) => {
            const category = sessionCategoryFor(session);
            const SessionIcon = category.Icon;
            const isActive = Boolean(session.sessionId && session.sessionId === selectedSessionId);
            const activate = () => {
              if (selectMode) {
                if (session.sessionId) toggleChecked(session.sessionId);
                return;
              }
              onSelect(session);
            };
            return (
              <div
                key={`${session.sessionId || session.title}-${index}`}
                className={cn('prototype-session-item', isActive && 'active')}
                role="button"
                tabIndex={0}
                onClick={activate}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate();
                  }
                }}
              >
                {selectMode ? (
                  session.sessionId ? (
                    <input
                      type="checkbox"
                      className="prototype-session-check"
                      checked={checkedIds.has(session.sessionId)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      onChange={() => toggleChecked(session.sessionId!)}
                      aria-label={`选择会话 ${session.title}`}
                    />
                  ) : (
                    <span className="prototype-session-check" aria-hidden="true" />
                  )
                ) : null}
                <span className={cn('prototype-session-icon', category.tone)}>
                  <SessionIcon />
                </span>
                <strong>{session.title}</strong>
                <time>{session.time}</time>
                {session.sessionId ? <code className="prototype-session-id">ID: {session.sessionId}</code> : null}
                <p>{session.desc}</p>
              </div>
            );
          }) : (
            <div className="prototype-session-empty">
              <MessageSquare />
              <strong>{emptyCopy}</strong>
              <p>{trimmedQuery ? '换个关键词再试。' : '新建或发送消息后，会话会出现在这里。'}</p>
            </div>
          )}
        </div>
      </ScrollArea>
      <div className="prototype-session-pagination">
        <span>第 {page}/{pageCount} 页 · 共 {total} 条</span>
        <div>
          <button type="button" disabled={page <= 1} onClick={onPrevPage}>上一页</button>
          <button type="button" disabled={page >= pageCount} onClick={onNextPage}>下一页</button>
        </div>
      </div>
    </aside>
  );
}

function PrototypeChatHeader(props: {
  runningAgentCount: number;
  terminatingSession: boolean;
  contextUsage?: ContextUsageBody;
  sessionCostUsd?: number;
  onNewSession: () => void;
  onRequestStopSession: () => void;
  onToggleHistory: () => void;
  onTogglePreview: () => void;
}) {
  const canTerminate = props.runningAgentCount > 0 && !props.terminatingSession;
  return (
    <div className="prototype-chat-header">
      <div>
        <h1>AI 助手</h1>
        <span>
          <i />
          {props.runningAgentCount ? `${props.runningAgentCount} 个任务运行中` : '就绪'}
          <b>上下文 {formatContextUsage(props.contextUsage)}</b>
          {typeof props.sessionCostUsd === 'number' ? <b>成本 {formatCostUsd(props.sessionCostUsd)}</b> : null}
        </span>
      </div>
      <div className="prototype-chat-actions">
        <button type="button" onClick={props.onToggleHistory} aria-label="切换会话列表">
          <PanelLeftClose />
        </button>
        <button type="button" onClick={props.onTogglePreview} aria-label="切换沙箱">
          <PanelRightClose />
        </button>
        <button
          type="button"
          className="danger"
          disabled={!canTerminate}
          onClick={props.onRequestStopSession}
          title="停止当前运行"
          aria-label="停止"
        >
          <CircleStop />
          {props.terminatingSession ? '停止中' : '停止'}
        </button>
        <button type="button" className="primary" onClick={props.onNewSession}>
          <Plus />
          新建会话
        </button>
      </div>
    </div>
  );
}

function ConfirmDialog(props: {
  request: ConfirmDialogRequest | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!props.request) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !props.busy) props.onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props]);

  if (!props.request) return null;
  const tone = props.request.tone || 'info';
  return (
    <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={props.busy ? undefined : props.onCancel}>
      <section
        className={cn('confirm-dialog-panel', tone)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-copy">
          <h2 id="confirm-dialog-title">{props.request.title}</h2>
          <p id="confirm-dialog-desc">{props.request.description}</p>
          {props.request.alert ? (
            <div className="confirm-dialog-alert">
              <span>{props.request.alert}</span>
            </div>
          ) : null}
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="ghost" disabled={props.busy} onClick={props.onCancel}>
            {props.request.cancelLabel || '取消'}
          </button>
          <button type="button" className={tone === 'danger' ? 'danger' : 'primary'} disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? props.request.busyLabel || '处理中' : props.request.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

/** 通用内容弹窗：点击遮罩 / Esc / 右上角关闭。 */
function ModalDialog({ title, status, icon, onClose, children }: {
  title: string;
  status?: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-dialog-head">
          {icon ? <div className="large-icon">{icon}</div> : null}
          <div>
            <h2>{title}</h2>
            {status ? <Badge variant="secondary">{status}</Badge> : null}
          </div>
          <button type="button" className="modal-dialog-close" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </div>
        <div className="modal-dialog-body">{children}</div>
      </section>
    </div>
  );
}

function PrototypeMessages({ messages }: { messages: ChatMessage[] }) {
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  return (
    <ScrollArea className="prototype-message-scroll">
      <div className="prototype-message-list">
        {messages.map((message, index) => {
          const isUser = message.role === 'user';
          return (
            <article key={message.id || `${message.role}-${index}`} className={cn('prototype-message', isUser && 'user')}>
              <MessageAvatar isUser={isUser} />
              <div className="prototype-message-stack">
                <div className="prototype-bubble">
                  <MessageContent message={message} />
                  {message.attachments?.length ? <AttachmentChips attachments={message.attachments} /> : null}
                  {message.tools?.length ? (
                    <div className="tool-chips">
                      {message.tools.map((tool) => <Badge key={tool} variant="secondary">{tool}</Badge>)}
                    </div>
                  ) : null}
                  {message.running ? <RunningIndicator /> : null}
                </div>
                <time className="prototype-message-time">{message.time}</time>
              </div>
            </article>
          );
        })}
        <div ref={messageEndRef} className="prototype-message-end" aria-hidden="true" />
      </div>
    </ScrollArea>
  );
}

function RunningIndicator() {
  return (
    <div className="prototype-running-indicator" aria-label="执行中">
      <span />
      <span />
      <span />
      <em>执行中</em>
    </div>
  );
}

function PrototypeComposer(props: {
  attachments: Attachment[];
  value: string;
  skillSuggestions: ToolSummary[];
  skillShortcutDraft: string;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onChooseAttachment: () => void;
  onAddAttachments: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onComposerChange: (value: string) => void;
  onChooseSkillSuggestion: (skill: ToolSummary) => void;
  onComposerKeydown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmitComposer: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="prototype-composer" onSubmit={props.onSubmitComposer}>
      <input
        ref={props.fileInputRef}
        id="attachment-input"
        type="file"
        multiple
        hidden
        onChange={(event) => props.onAddAttachments(event.currentTarget.files)}
      />
      {props.attachments.length ? <AttachmentChips attachments={props.attachments} onRemove={props.onRemoveAttachment} /> : null}
      {props.skillShortcutDraft && props.skillSuggestions.length ? (
        <div className="slash-skill-menu" role="listbox" aria-label="技能快捷选择">
          {props.skillSuggestions.map((skill) => (
            <button
              key={skill.name}
              className="slash-skill-option"
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                props.onChooseSkillSuggestion(skill);
              }}
            >
              <Boxes />
              <span>
                <strong>/{skill.name}</strong>
                <small>{skill.description || '使用技能'}</small>
              </span>
              <em>使用技能</em>
            </button>
          ))}
        </div>
      ) : null}
      <div className="prototype-input-box">
        <button type="button" onClick={props.onChooseAttachment} aria-label="添加附件">
          <Paperclip />
        </button>
        <button type="button" aria-label="代码模式">
          <Code2 />
        </button>
        <textarea
          ref={props.composerRef}
          name="task"
          value={props.value}
          rows={1}
          placeholder="输入你的运维问题，或输入 /技能名 快速使用技能..."
          onChange={(event) => props.onComposerChange(event.target.value)}
          onKeyDown={props.onComposerKeydown}
        />
        <button type="submit" className="send" aria-label="发送">
          <Send />
        </button>
      </div>
    </form>
  );
}

function PrototypeSandboxPanel(props: {
  sandboxOutput: string;
  browserStreamUrl: string;
  onRunSandbox: (code: string, language: string) => void;
  onOpenPreview: () => void;
  onRefreshPreview: () => void;
  onStartResize: (event: PointerEvent<HTMLButtonElement>) => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'terminal' | 'browser'>('terminal');
  const [code, setCode] = useState('print("hello from sandbox")');
  const [language, setLanguage] = useState('python');
  const [codeOpen, setCodeOpen] = useState(false);

  return (
    <aside className="prototype-sandbox-panel">
      <button className="prototype-resize-handle" type="button" aria-label="拖动调整沙箱宽度" onPointerDown={props.onStartResize} />
      <div className="prototype-sandbox-head">
        <div>
          <h2>当前沙箱</h2>
          <span>
            <i />
            sandbox-prod · ready
          </span>
        </div>
        <button type="button" onClick={props.onClose} aria-label="收起当前沙箱">
          <ChevronRight />
        </button>
      </div>
      <div className="prototype-tabs">
        {[
          { key: 'terminal' as const, label: '终端', icon: Terminal },
          { key: 'browser' as const, label: '浏览器预览', icon: Globe },
        ].map((tab) => (
          <button key={tab.key} type="button" className={cn(activeTab === tab.key && 'active')} onClick={() => setActiveTab(tab.key)}>
            <tab.icon />
            {tab.label}
          </button>
        ))}
      </div>
      <div className="prototype-sandbox-body">
        {activeTab === 'terminal' && (
          <>
            <details className="prototype-code-card" open={codeOpen} onToggle={(event) => setCodeOpen(event.currentTarget.open)}>
              <summary>
                <span>
                  <Code2 />
                  运行代码
                </span>
                <em>{codeOpen ? '收起' : '展开'}</em>
              </summary>
              <div className="prototype-code-card-body">
                <div className="prototype-code-options">
                  <span>执行语言</span>
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger className="prototype-language-select" aria-label="选择语言">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="python">Python</SelectItem>
                        <SelectItem value="javascript">JavaScript</SelectItem>
                        <SelectItem value="bash">Bash</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <textarea value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} />
                <button
                  type="button"
                  onClick={() => {
                    setCodeOpen(false);
                    props.onRunSandbox(code, language);
                  }}
                >
                  <Play />
                  运行代码
                </button>
              </div>
            </details>
            <PrototypeTerminal output={props.sandboxOutput} />
          </>
        )}
        {activeTab === 'browser' && (
          <div className="prototype-browser-card">
            <div>
              <span>
                <Globe />
                浏览器预览
              </span>
              <div>
                <button type="button" onClick={props.onOpenPreview}>
                  <Monitor />
                  加载预览
                </button>
                <button type="button" onClick={props.onRefreshPreview}>
                  <RefreshCcw />
                  刷新截图
                </button>
              </div>
            </div>
            {props.browserStreamUrl ? (
              <iframe src={props.browserStreamUrl} title="浏览器预览" />
            ) : (
              <div className="prototype-empty-preview">
                <Globe />
                <strong>浏览器预览区域</strong>
                <span>加载后会在这里显示截图流。</span>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function PrototypeTerminal({ output }: { output: string }) {
  const outputRef = useRef<HTMLDivElement>(null);
  const entries = parseSandboxOutput(output);
  // 实时输出时自动滚到底部，像终端一样跟随最新内容。
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);
  return (
    <div className="prototype-terminal">
      <div className="prototype-terminal-head">
        <span>
          <Check />
          输出
        </span>
        <small>{terminalStats(output)}</small>
      </div>
      <div ref={outputRef} className="prototype-terminal-output">
        {entries.length ? entries.map((entry) => (
          <div key={entry.id} className={sandboxOutputClassNames[entry.kind]}>
            <span className="sandbox-output-label">{sandboxOutputLabels[entry.kind]}</span>
            <code>{renderSandboxOutputSegments(entry)}</code>
          </div>
        )) : (
          <div className="prototype-terminal-empty">暂无沙箱输出。</div>
        )}
      </div>
    </div>
  );
}

function renderSandboxOutputSegments(entry: ReturnType<typeof parseSandboxOutput>[number]) {
  const segments = entry.kind === 'command' ? [{ text: `$ ${entry.text}` }] : entry.segments;
  return segments.map((segment, index) => (
    segment.className || segment.style
      ? <span key={index} className={segment.className} style={segment.style}>{segment.text}</span>
      : <Fragment key={index}>{segment.text}</Fragment>
  ));
}

function ChatWorkbench(props: {
  historyOpen: boolean;
  previewOpen: boolean;
  previewWidth: number;
  sessions: SessionSummary[];
  messages: ChatMessage[];
  attachments: Attachment[];
  llm: RuntimeModelConfig;
  settingsStatus: string;
  sandboxOutput: string;
  browserStreamUrl: string;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onToggleHistory: () => void;
  onTogglePreview: () => void;
  onNewSession: () => void;
  onChooseAttachment: () => void;
  onAddAttachments: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onComposerKeydown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmitComposer: (event: FormEvent<HTMLFormElement>) => void;
  onModelSwitch: (id: string) => void;
  onRunSandbox: (code: string, language: string) => void;
  onOpenPreview: () => void;
  onRefreshPreview: () => void;
  onStartResize: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const layoutClass = cn('chat-layout', !props.historyOpen && 'history-closed', !props.previewOpen && 'preview-closed');
  return (
    <div className={layoutClass} style={{ '--sandbox-width': `${props.previewWidth}px` } as CSSProperties}>
      {props.historyOpen && <SessionHistory sessions={props.sessions} onCollapse={props.onToggleHistory} />}
      <section className="chat-panel">
        <div className="panel-header">
          <div className="page-heading">
            <h1>AI 运维助手</h1>
            <p className="page-subtitle">查询集群、分析告警、执行变更和管理沙箱。</p>
          </div>
          <div className="header-actions">
            <Button variant="outline" size="icon" title="切换会话列表" onClick={props.onToggleHistory}>
              <PanelLeftClose />
            </Button>
            <Button variant="outline" size="icon" title="切换浏览器预览" onClick={props.onTogglePreview}>
              <PanelRightClose />
            </Button>
            <Button onClick={props.onNewSession}>
              <MessageSquare data-icon="inline-start" />
              新建会话
            </Button>
          </div>
        </div>
        <Messages messages={props.messages} />
        <ComposerInput
          attachments={props.attachments}
          composerRef={props.composerRef}
          fileInputRef={props.fileInputRef}
          onChooseAttachment={props.onChooseAttachment}
          onAddAttachments={props.onAddAttachments}
          onRemoveAttachment={props.onRemoveAttachment}
          onComposerKeydown={props.onComposerKeydown}
          onSubmitComposer={props.onSubmitComposer}
        />
      </section>
      {props.previewOpen && (
        <BrowserPreviewPanel
          sandboxOutput={props.sandboxOutput}
          browserStreamUrl={props.browserStreamUrl}
          onRunSandbox={props.onRunSandbox}
          onOpenPreview={props.onOpenPreview}
          onRefreshPreview={props.onRefreshPreview}
          onStartResize={props.onStartResize}
          onClose={props.onTogglePreview}
        />
      )}
    </div>
  );
}

function SessionHistory({ sessions, onCollapse }: { sessions: SessionSummary[]; onCollapse: () => void }) {
  const recentSessions = sessions.slice(0, 10);
  return (
    <aside className="session-drawer">
      <div className="drawer-head">
        <div>
          <h2>最近会话</h2>
          <span>按更新时间排序</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onCollapse}>
          <X />
        </Button>
      </div>
      <ScrollArea className="session-scroll">
        <div className="session-list">
          {recentSessions.length ? recentSessions.map((session, index) => {
            const category = sessionCategoryFor(session);
            const SessionIcon = category.Icon;
            return (
              <button key={`${session.sessionId || session.title}-${index}`} className={cn('session-row', index === 0 && 'active')} type="button">
                <span className={cn('session-row-icon', category.tone)}>
                  <SessionIcon />
                </span>
                <strong>{session.title}</strong>
                <time>{session.time}</time>
                <span className="session-desc">{session.desc}</span>
              </button>
            );
          }) : (
            <div className="session-empty">
              <MessageSquare />
              <strong>暂无会话记录</strong>
              <span>开始一次对话后，这里会显示最近会话。</span>
            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}

function Messages({ messages }: { messages: ChatMessage[] }) {
  return (
    <ScrollArea className="messages-scroll">
      <div className="messages-grid">
        {messages.map((message, index) => {
          const isUser = message.role === 'user';
          return (
            <article key={message.id || `${message.role}-${index}`} className={cn('message', isUser && 'message-user')}>
              <MessageAvatar isUser={isUser} />
              <div className="message-stack">
                <div className="bubble">
                  <MessageContent message={message} />
                  {message.attachments?.length ? <AttachmentChips attachments={message.attachments} /> : null}
                  {message.tools?.length ? (
                    <div className="tool-chips">
                      {message.tools.map((tool) => <Badge key={tool} variant="secondary">{tool}</Badge>)}
                    </div>
                  ) : null}
                  {message.running ? <RunningIndicator /> : null}
                </div>
                <time className="message-time">{message.time}</time>
              </div>
            </article>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function AttachmentChips({ attachments, onRemove }: { attachments: Attachment[]; onRemove?: (id: string) => void }) {
  return (
    <div className="attachment-list">
      {attachments.map((file) => (
        <span className="attachment-chip" key={file.id} title={file.name}>
          <Paperclip />
          <span>{file.name}</span>
          <small>{file.type || 'file'} · {formatFileSize(file.size)}</small>
          {onRemove ? (
            <button type="button" onClick={() => onRemove(file.id)} aria-label={`移除 ${file.name}`}>
              <Trash2 />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function ComposerInput(props: {
  attachments: Attachment[];
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onChooseAttachment: () => void;
  onAddAttachments: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onComposerKeydown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmitComposer: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="composer-shell" onSubmit={props.onSubmitComposer}>
      <input
        ref={props.fileInputRef}
        id="attachment-input"
        type="file"
        multiple
        hidden
        onChange={(event) => props.onAddAttachments(event.currentTarget.files)}
      />
      {props.attachments.length ? <AttachmentChips attachments={props.attachments} onRemove={props.onRemoveAttachment} /> : null}
      <div className="composer-main">
        <Textarea
          ref={props.composerRef}
          name="task"
          rows={2}
          placeholder="输入运维问题或指令，Enter 发送"
          onKeyDown={props.onComposerKeydown}
        />
        <div className="composer-action-row">
          <Button variant="outline" size="icon" type="button" title="添加附件" onClick={props.onChooseAttachment}>
            <Paperclip />
          </Button>
          <Button className="send-button" type="submit">
            <Send data-icon="inline-start" />
            发送
          </Button>
        </div>
      </div>
    </form>
  );
}

function BrowserPreviewPanel(props: {
  sandboxOutput: string;
  browserStreamUrl: string;
  onRunSandbox: (code: string, language: string) => void;
  onOpenPreview: () => void;
  onRefreshPreview: () => void;
  onStartResize: (event: PointerEvent<HTMLButtonElement>) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState('print("hello from sandbox")');
  const [language, setLanguage] = useState('python');
  return (
    <aside className="browser-preview-panel">
      <button className="resize-handle" type="button" aria-label="拖动调整浏览器预览宽度" onPointerDown={props.onStartResize} />
      <div className="sandbox-head">
        <div>
          <h2>当前沙箱</h2>
          <p><span className="ready-dot" />sandbox-prod · ready</p>
        </div>
        <Button variant="ghost" size="icon" onClick={props.onClose}>
          <X />
        </Button>
      </div>
      <Card className="sandbox-tool">
        <CardHeader>
          <div className="tool-title">
            <CardTitle>运行代码</CardTitle>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="language-select" aria-label="选择语言">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="python">Python</SelectItem>
                  <SelectItem value="javascript">JavaScript</SelectItem>
                  <SelectItem value="bash">Bash</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="sandbox-code">
          <Textarea value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} />
          <Button type="button" onClick={() => props.onRunSandbox(code, language)}>
            <Play data-icon="inline-start" />
            运行代码
          </Button>
        </CardContent>
      </Card>
      <Card className="preview-tool">
        <CardHeader>
          <div className="tool-title">
            <CardTitle>浏览器预览</CardTitle>
            <div className="tool-actions">
              <Button variant="outline" size="sm" type="button" onClick={props.onOpenPreview}>
                <Monitor data-icon="inline-start" />
                加载预览
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={props.onRefreshPreview}>
                <RefreshCcw data-icon="inline-start" />
                刷新截图
              </Button>
            </div>
          </div>
          <CardDescription>这里只展示远端浏览器画面，不提供打开 URL、点击、输入等操作控件。</CardDescription>
        </CardHeader>
        <CardContent>
          {props.browserStreamUrl ? (
            <iframe className="browser-preview-frame" src={props.browserStreamUrl} title="浏览器预览" />
          ) : (
            <div className="preview-empty">
              <Monitor />
              <strong>预览当前沙箱浏览器画面</strong>
              <span>加载后会在这里显示截图流。</span>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="terminal">
        {parseSandboxOutput(props.sandboxOutput).map((entry) => (
          <div key={entry.id} className={sandboxOutputClassNames[entry.kind]}>
            <span className="sandbox-output-label">{sandboxOutputLabels[entry.kind]}</span>
            <code>{renderSandboxOutputSegments(entry)}</code>
          </div>
        ))}
      </div>
    </aside>
  );
}

function skillFileEntries(tool?: ToolSummary): SkillFileEntry[] {
  if (tool?.fileEntries?.length) return tool.fileEntries;
  const paths = ['SKILL.md', ...(tool?.files || [])];
  return paths.map((path) => ({
    path,
    name: path.split('/').pop() || path,
    isDirectory: false,
    size: 0,
    updatedAt: '',
  }));
}

function skillFiles(tool?: ToolSummary): string[] {
  return skillFileEntries(tool).filter((file) => !file.isDirectory).map((file) => file.path);
}

function skillPreview(tool?: ToolSummary, selectedFile = 'SKILL.md'): string {
  const name = toolDisplayName(tool?.name || 'skill');
  const description = tool?.description || '后端已注册的 AI 助手技能。';
  const files = skillFiles(tool).map((file) => `- ${file}`).join('\n');
  if (selectedFile && selectedFile !== 'SKILL.md') {
    return `# ${selectedFile}\n\n该文件来自技能 ${name} 的目录。\n\n文件内容需要通过后端技能导入或文件浏览能力读取。`;
  }
  return `# ${name}\n\n${description}\n\n## Files\n${files}`;
}

function skillIconFor(tool?: ToolSummary) {
  const text = `${tool?.name || ''} ${tool?.description || ''}`.toLowerCase();
  if (text.includes('kubectl') || text.includes('集群')) return TerminalSquare;
  if (text.includes('web') || text.includes('browser')) return Globe;
  if (text.includes('pdf') || text.includes('doc')) return FileText;
  return Boxes;
}

function isSkillEnabled(tool?: ToolSummary): boolean {
  if (!tool) return false;
  return tool.enabled ?? ((tool.status || '已启用') !== '已禁用');
}

function parentPathOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function SkillsPage({ tools, api, onImported, onRequestConfirm }: {
  tools: ToolSummary[];
  api: ReturnType<typeof createApi>;
  onImported: () => Promise<void>;
  onRequestConfirm: (request: ConfirmDialogRequest) => void;
}) {
  const sourceTools = useMemo(
    () => (tools.length ? tools : fallbackTools.filter((tool) => tool.category === 'skill')),
    [tools],
  );
  const [selectedName, setSelectedName] = useState(sourceTools[0]?.name || '');
  const [selectedFile, setSelectedFile] = useState('SKILL.md');
  const [currentDir, setCurrentDir] = useState('');
  const [directoryEntries, setDirectoryEntries] = useState<SkillFileEntry[]>([]);
  const [fileBody, setFileBody] = useState<SkillFileBody | null>(null);
  const [query, setQuery] = useState('');
  const [showSkillFiles, setShowSkillFiles] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const selected = sourceTools.find((tool) => tool.name === selectedName) || sourceTools[0];
  const files = useMemo(() => skillFiles(selected), [selected]);
  const selectedEntry = fileBody?.entry || skillFileEntries(selected).find((file) => file.path === selectedFile);
  const filteredTools = sourceTools.filter((tool) => {
    const value = `${toolDisplayName(tool.name)} ${tool.description || ''}`.toLowerCase();
    return value.includes(query.trim().toLowerCase());
  });
  const enabledCount = sourceTools.filter((tool) => (tool.status || '已启用') !== '已禁用').length;
  const SkillIcon = skillIconFor(selected);

  useEffect(() => {
    if (!sourceTools.some((tool) => tool.name === selectedName)) {
      setSelectedName(sourceTools[0]?.name || '');
    }
  }, [selectedName, sourceTools]);

  useEffect(() => {
    if (!selectedName) return;
    setSelectedFile('SKILL.md');
    setCurrentDir('');
    setFileBody(null);
    void loadSkillDirectory('');
    void loadSkillFile('SKILL.md');
  }, [selectedName]);

  async function loadSkillDirectory(path = '') {
    if (!selectedName) return;
    try {
      const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
      const body = await api.get<SkillFileBody>(`/v1/skills/${encodeURIComponent(selectedName)}/files${suffix}`);
      setCurrentDir(body.path || path);
      setDirectoryEntries(body.entries || []);
    } catch (err) {
      const entries = skillFileEntries(selected)
        .filter((entry) => parentPathOf(entry.path) === path)
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN'));
      setCurrentDir(path);
      setDirectoryEntries(entries);
      setImportStatus(`目录加载失败：${formatError(err)}`);
    }
  }

  async function loadSkillFile(path = 'SKILL.md') {
    if (!selectedName) return;
    setSelectedFile(path);
    try {
      const body = await api.get<SkillFileBody>(`/v1/skills/${encodeURIComponent(selectedName)}/files?path=${encodeURIComponent(path)}`);
      setSelectedFile(body.path || path);
      setFileBody(body);
    } catch (err) {
      const entry = skillFileEntries(selected).find((file) => file.path === path);
      setFileBody({
        path,
        parentPath: parentPathOf(path),
        entry,
        content: `${skillPreview(selected, path)}\n\n读取失败：${formatError(err)}`,
      });
    }
  }

  async function toggleSkillEnabled() {
    if (!selectedName) return;
    const shouldDisable = isSkillEnabled(selected);
    setImportStatus(shouldDisable ? '正在禁用技能...' : '正在启用技能...');
    try {
      const body = shouldDisable
        ? await api.post<SkillActionBody>(`/v1/skills/${encodeURIComponent(selectedName)}/disable`)
        : await api.post<SkillActionBody>(`/v1/skills/${encodeURIComponent(selectedName)}/enable`);
      await onImported();
      if (body.skill?.name) setSelectedName(body.skill.name);
      setImportStatus(shouldDisable ? '技能已禁用。' : '技能已启用。');
    } catch (err) {
      setImportStatus(`操作失败：${formatError(err)}`);
    }
  }

  function requestDeleteSelectedSkill() {
    if (!selectedName) return;
    onRequestConfirm({
      title: `删除技能 ${toolDisplayName(selectedName)}？`,
      description: '删除后，该 Skill 目录会从服务端移除，AI 将无法继续加载它。',
      alert: '此操作不可恢复，请确认已有备份或不再需要该技能。',
      confirmLabel: '确认删除',
      busyLabel: '删除中',
      tone: 'danger',
      onConfirm: deleteSelectedSkill,
    });
  }

  async function deleteSelectedSkill() {
    if (!selectedName) return;
    setImportStatus('正在删除技能...');
    try {
      await api.delete<SkillActionBody>(`/v1/skills/${encodeURIComponent(selectedName)}`, { confirm: true });
      const next = sourceTools.find((tool) => tool.name !== selectedName)?.name || '';
      setSelectedName(next);
      setSelectedFile('SKILL.md');
      setFileBody(null);
      await onImported();
      setImportStatus('技能已删除。');
    } catch (err) {
      setImportStatus(`删除失败：${formatError(err)}`);
    }
  }

  async function importSkillFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setImportStatus('请选择 zip 技能包。');
      return;
    }
    setImportStatus('正在导入技能...');
    try {
      const body = await api.post<SkillsImportBody>('/v1/skills/import', {
        filename: file.name,
        data: await readFileAsDataUrl(file),
      });
      await onImported();
      setSelectedName(body.skill.name);
      setSelectedFile('SKILL.md');
      setShowSkillFiles(false);
      setImportStatus(`已导入 ${toolDisplayName(body.skill.name)}。`);
    } catch (err) {
      setImportStatus(`导入失败：${formatError(err)}`);
    }
  }

  return (
    <section className="skills-page">
      <div className="skills-page-header">
        <div className="page-heading">
          <h1>技能管理</h1>
          <p className="page-subtitle">管理本地与导入的 Skill，供 AI 调用</p>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importSkillFile(file);
          }}
        />
        <Button className="skill-import-button" type="button" onClick={() => importInputRef.current?.click()}>
          <Plus data-icon="inline-start" />
          导入技能
        </Button>
      </div>
      {importStatus ? <div className="skill-import-status">{importStatus}</div> : null}
      <div className={cn('skills-workbench', showSkillFiles && 'with-file-tree')}>
        <aside className="skill-list-panel">
          <label className="skill-search-box">
            <Search />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能..." />
          </label>
          <div className="skill-list-meta">
            <span>共 {sourceTools.length} 个技能</span>
            <span>{enabledCount} 个已启用</span>
          </div>
          <ScrollArea className="skill-list-scroll">
            <div className="skill-list">
              {filteredTools.map((tool) => {
                const Icon = skillIconFor(tool);
                const active = tool.name === selected?.name;
                return (
                  <button
                    key={tool.name}
                    className={cn('skill-list-item', active && 'active')}
                    type="button"
                    onClick={() => {
                      setSelectedName(tool.name);
                      setSelectedFile(skillFiles(tool)[0] || 'SKILL.md');
                    }}
                  >
                    <span className="skill-list-icon"><Icon /></span>
                    <span className="skill-list-copy">
                      <span>
                        <strong>{toolDisplayName(tool.name)}</strong>
                        <small>{skillFiles(tool).length} 个文件</small>
                      </span>
                      <em>{tool.description || '后端已注册的 AI 助手技能。'}</em>
                      <span className="skill-list-foot">
                        <Badge variant="secondary">{tool.status || '已启用'}</Badge>
                        <small>{isSkillEnabled(tool) ? '可被助手加载' : '不会被助手加载'}</small>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </aside>
        {showSkillFiles ? (
          <aside className="skill-file-tree-panel">
            <div className="skill-panel-title">
              <strong>文件目录</strong>
              <span>{currentDir || '根目录'}</span>
            </div>
            <div className="skill-file-tree">
              {currentDir ? (
                <button
                  className="skill-tree-up-button"
                  type="button"
                  onClick={() => void loadSkillDirectory(parentPathOf(currentDir))}
                >
                  <ChevronLeft />
                  <span>上级目录</span>
                </button>
              ) : null}
              {directoryEntries.map((entry) => (
                <button
                  key={entry.path}
                  className={cn('skill-file-row', 'skill-tree-node', entry.isDirectory && 'directory', selectedFile === entry.path && 'active')}
                  style={{ '--depth': String(Math.max(0, entry.path.split('/').length - 1)) } as CSSProperties}
                  type="button"
                  onClick={() => {
                    if (entry.isDirectory) void loadSkillDirectory(entry.path);
                    else void loadSkillFile(entry.path);
                  }}
                >
                  {entry.isDirectory ? <Folder /> : <FileText />}
                  <span>{entry.name}</span>
                </button>
              ))}
            </div>
          </aside>
        ) : null}
        <main className="skill-detail-panel">
          <div className="skill-detail-head">
            <div className="skill-title-block">
              <span className="skill-detail-icon"><SkillIcon /></span>
              <div>
                <h2>{toolDisplayName(selected?.name)}</h2>
                <p>{selected?.description || '后端已注册的 AI 助手技能。'}</p>
              </div>
            </div>
            <div className="skill-detail-actions">
              <Button variant="outline" size="sm" type="button" onClick={() => setShowSkillFiles((value) => !value)}>
                <FolderTree data-icon="inline-start" />
                {showSkillFiles ? '隐藏目录' : '目录'}
              </Button>
              <Button variant="outline" size="sm" type="button" onClick={() => void toggleSkillEnabled()}>
                {isSkillEnabled(selected) ? <X data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                {isSkillEnabled(selected) ? '禁用' : '启用'}
              </Button>
              <Button variant="outline" size="sm" type="button" onClick={requestDeleteSelectedSkill}>
                <Trash2 data-icon="inline-start" />
                删除
              </Button>
              <Badge variant="secondary">{selected?.status || '已启用'}</Badge>
            </div>
          </div>
          <div className="skill-meta-row">
            <span>文件大小 <strong>{formatFileSize(selectedEntry?.size || 0)}</strong></span>
            <span>更新时间 <strong>{formatDateTime(selectedEntry?.updatedAt)}</strong></span>
            <span>当前文件 <strong>{selectedFile}</strong></span>
          </div>
          {selectedFile.toLowerCase().endsWith('.md') ? (
            <div className="skill-preview-markdown">
              <MarkdownMessage content={fileBody?.content || skillPreview(selected, selectedFile)} />
            </div>
          ) : (
            <pre className="skill-preview">{fileBody?.content || skillPreview(selected, selectedFile)}</pre>
          )}
        </main>
      </div>
    </section>
  );
}

type McpTransport = McpServerInfo['transport'];

const emptyMcpForm = { name: '', transport: 'stdio' as McpTransport, command: '', args: '', url: '', headers: '' };

function mcpStatusText(status: McpServerInfo['status']): string {
  return status === 'connected' ? '已连接' : '异常';
}

function McpPage({ tools, api, output, onTest, onRequestConfirm, onChanged }: {
  tools: ToolSummary[];
  api: ReturnType<typeof createApi>;
  output: string;
  onTest: (tool: string, args: string) => void;
  onRequestConfirm: (request: ConfirmDialogRequest) => void;
  onChanged: () => void;
}) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [selectedName, setSelectedName] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'connected'>('all');
  const [pageStatus, setPageStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(emptyMcpForm);
  const [testToolName, setTestToolName] = useState('');
  const [testArgs, setTestArgs] = useState('{}');

  const loadServers = useCallback(async () => {
    try {
      const body = await api.get<McpServersBody>('/v1/mcp/servers');
      setServers(body.servers || []);
    } catch (err) {
      setServers([]);
      setPageStatus(`加载 MCP 服务器失败：${formatError(err)}`);
    }
  }, [api]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const keyword = search.trim().toLowerCase();
  const filtered = servers.filter((server) =>
    (statusFilter === 'all' || server.status === 'connected')
    && (!keyword || server.name.toLowerCase().includes(keyword)));
  // 详情默认不展示：只有点击某行后才以弹窗打开
  const selected = servers.find((server) => server.name === selectedName);
  const selectedTools = selected?.tools ?? [];
  const hasTools = selectedTools.length > 0;

  useEffect(() => {
    if (!selectedTools.includes(testToolName)) setTestToolName(selectedTools[0] || '');
  }, [selectedTools, testToolName]);

  const serverRows = filtered.length
    ? filtered.map((server) => [server.name, server.transport, mcpStatusText(server.status), String(server.tools.length), formatTime(server.connectedAt)])
    : [['-', '-', '未连接', '0', '-']];

  async function submitAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) return setPageStatus('请填写服务器名称');
    const config: Record<string, unknown> = { transport: form.transport };
    if (form.transport === 'stdio') {
      if (!form.command.trim()) return setPageStatus('stdio 传输需要启动命令');
      config.command = form.command.trim();
      const args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
      if (args.length) config.args = args;
    } else {
      if (!form.url.trim()) return setPageStatus(`${form.transport} 传输需要 URL`);
      config.url = form.url.trim();
      if (form.headers.trim()) {
        try {
          config.headers = JSON.parse(form.headers) as Record<string, string>;
        } catch {
          return setPageStatus('headers 必须是 JSON 对象，如 {"Authorization": "Bearer xxx"}');
        }
      }
    }
    setBusy(true);
    setPageStatus(`正在连接 ${name}...`);
    try {
      const body = await api.post<McpServerBody>('/v1/mcp/servers', { name, config });
      setPageStatus(body.server.status === 'connected'
        ? `已连接 ${name}，发现 ${body.server.tools.length} 个工具`
        : `已保存 ${name}，但连接失败：${body.server.error || '未知错误'}（可稍后重连）`);
      setShowAdd(false);
      setForm(emptyMcpForm);
      setSelectedName(name);
      await loadServers();
      onChanged();
    } catch (err) {
      setPageStatus(`新增失败：${formatError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function reconnectSelected() {
    if (!selected || busy) return;
    setBusy(true);
    setPageStatus(`正在重连 ${selected.name}...`);
    try {
      const body = await api.post<McpServerBody>(`/v1/mcp/servers/${encodeURIComponent(selected.name)}/reconnect`);
      setPageStatus(body.server.status === 'connected'
        ? `已重连 ${selected.name}，发现 ${body.server.tools.length} 个工具`
        : `重连 ${selected.name} 失败：${body.server.error || '未知错误'}`);
      await loadServers();
      onChanged();
    } catch (err) {
      setPageStatus(`重连失败：${formatError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function requestDeleteSelected() {
    if (!selected || busy) return;
    const target = selected;
    onRequestConfirm({
      title: '删除 MCP server',
      description: `将断开并移除「${target.name}」及其 ${target.tools.length} 个工具，AI 将无法继续调用。`,
      confirmLabel: '确认删除',
      busyLabel: '正在删除...',
      tone: 'danger',
      onConfirm: async () => {
        await api.delete(`/v1/mcp/servers/${encodeURIComponent(target.name)}`);
        setPageStatus(`已删除 ${target.name}`);
        setSelectedName('');
        await loadServers();
        onChanged();
      },
    });
  }

  function toolDescription(name: string): string {
    return tools.find((tool) => tool.name === name)?.description || '';
  }

  return (
    <>
      <ManagementPage
        title="MCP"
        desc="接入 MCP Server，扩展 AI 可用的工具"
        actionLabel="新增 MCP"
        onAction={() => {
          setShowAdd(true);
          setPageStatus('');
        }}
        search={search}
        onSearchChange={setSearch}
        filters={[
          { key: 'all', label: '全部', active: statusFilter === 'all', onClick: () => setStatusFilter('all') },
          { key: 'connected', label: '已连接', active: statusFilter === 'connected', onClick: () => setStatusFilter('connected') },
        ]}
      >
        <>
          <DataTable
            headers={['名称', '传输协议', '状态', '工具数', '最近连接']}
            rows={serverRows}
            selectedRowIndex={selected ? filtered.findIndex((server) => server.name === selected.name) : null}
            onRowClick={(index) => {
              const server = filtered[index];
              if (server) setSelectedName(server.name);
            }}
          />
          {pageStatus ? <p className="empty-hint">{pageStatus}</p> : null}
        </>
      </ManagementPage>
      {showAdd ? (
        <ModalDialog title="新增 MCP" status="连接后其工具自动注册" icon={<Plus />} onClose={() => setShowAdd(false)}>
          <form className="settings-form" onSubmit={(event) => void submitAdd(event)}>
            <label>名称
              <Input value={form.name} placeholder="如 filesystem" onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label>传输协议
              <Select value={form.transport} onValueChange={(value) => setForm({ ...form, transport: value as McpTransport })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="stdio">stdio（本地进程）</SelectItem>
                    <SelectItem value="sse">SSE</SelectItem>
                    <SelectItem value="http">Streamable HTTP</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            {form.transport === 'stdio' ? (
              <>
                <label>命令
                  <Input value={form.command} placeholder="如 npx" onChange={(event) => setForm({ ...form, command: event.target.value })} />
                </label>
                <label>参数（空格分隔）
                  <Input value={form.args} placeholder="如 -y @modelcontextprotocol/server-filesystem /tmp" onChange={(event) => setForm({ ...form, args: event.target.value })} />
                </label>
              </>
            ) : (
              <>
                <label>URL
                  <Input value={form.url} placeholder="如 https://mcp.example.com/sse" onChange={(event) => setForm({ ...form, url: event.target.value })} />
                </label>
                <label>Headers（JSON，可选）
                  <Textarea value={form.headers} rows={3} spellCheck={false} placeholder='{"Authorization": "Bearer xxx"}' onChange={(event) => setForm({ ...form, headers: event.target.value })} />
                </label>
              </>
            )}
            {pageStatus ? <p className="empty-hint">{pageStatus}</p> : null}
            <div className="skill-detail-actions">
              <Button type="submit" disabled={busy}>{busy ? '正在连接...' : '连接并保存'}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setShowAdd(false)}>取消</Button>
            </div>
          </form>
        </ModalDialog>
      ) : null}
      {selected ? (
        <ModalDialog title={selected.name} status={mcpStatusText(selected.status)} icon={<Link2 />} onClose={() => setSelectedName('')}>
          <div className="detail-panel">
            <h3>连接配置</h3>
            <div className="kv">
              <span>传输协议</span><strong>{selected.transport}</strong>
              {selected.transport === 'stdio'
                ? <><span>命令</span><strong>{[selected.command, ...(selected.args ?? [])].filter(Boolean).join(' ') || '-'}</strong></>
                : <><span>URL</span><strong>{selected.url || '-'}</strong></>}
              <span>最近连接</span><strong>{formatTime(selected.connectedAt)}</strong>
            </div>
            {selected.error ? <p className="empty-hint">连接错误：{selected.error}</p> : null}
            <div className="skill-detail-actions">
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void reconnectSelected()}>
                <RefreshCcw data-icon="inline-start" />
                重连
              </Button>
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={requestDeleteSelected}>
                <Trash2 data-icon="inline-start" />
                删除
              </Button>
            </div>
            <h3>测试调用</h3>
            {!hasTools ? <p className="empty-hint">暂无已连接的 MCP 工具</p> : null}
            <Select value={testToolName} onValueChange={setTestToolName} disabled={!hasTools}>
              <SelectTrigger><SelectValue placeholder="选择工具" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {selectedTools.map((name) => <SelectItem key={name} value={name}>{toolDisplayName(name)}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            {testToolName && toolDescription(testToolName) ? <p className="empty-hint">{toolDescription(testToolName)}</p> : null}
            <Textarea id="tool-test-args" value={testArgs} onChange={(event) => setTestArgs(event.target.value)} rows={5} spellCheck={false} disabled={!hasTools} />
            <Button type="button" disabled={!hasTools} onClick={() => onTest(testToolName, testArgs)}>测试工具</Button>
            {output ? <pre className="tool-output">{output}</pre> : null}
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
}

interface ManagementFilter {
  key: string;
  label: string;
  active: boolean;
  onClick: () => void;
}

function ManagementPage({ title, desc, actionLabel, onAction, search, onSearchChange, filters, children }: {
  title: string;
  desc?: string;
  actionLabel: string;
  onAction?: () => void;
  search?: string;
  onSearchChange?: (value: string) => void;
  filters?: ManagementFilter[];
  children: React.ReactNode;
}) {
  const content = Array.isArray(children) ? children : [children];
  const detail = content[1];
  return (
    <>
      <PageTitle title={title} desc={desc} />
      <div className="toolbar">
        <label className="search-box">
          <Search />
          <Input placeholder={`搜索${title}`} value={search ?? ''} onChange={(event) => onSearchChange?.(event.target.value)} />
        </label>
        {(filters ?? []).map((filter) => (
          <Button key={filter.key} variant={filter.active ? 'secondary' : 'outline'} type="button" onClick={filter.onClick}>{filter.label}</Button>
        ))}
        <Button type="button" onClick={onAction}>{actionLabel}</Button>
      </div>
      <div className={cn('two-pane', !detail && 'single-pane')}>
        <section className="list-card">{content[0]}</section>
        {detail ? <aside className="detail-card">{detail}</aside> : null}
      </div>
    </>
  );
}

function DetailPanel({ title, status, icon, children }: { title: string; status: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="detail-panel">
      <div className="detail-title">
        <div className="large-icon">{icon}</div>
        <div>
          <h2>{title}</h2>
          <Badge variant="secondary">{status}</Badge>
        </div>
      </div>
      {children}
    </div>
  );
}

const RUNS_PAGE_SIZE = 5;

const CRON_PRESETS = [
  { label: '每天 02:00', value: '0 2 * * *' },
  { label: '每天 01:00', value: '0 1 * * *' },
  { label: '每小时', value: '0 * * * *' },
  { label: '每 5 分钟', value: '*/5 * * * *' },
  { label: '每周一 09:00', value: '0 9 * * 1' },
];

function SchedulePage({ tasks, api, onChanged, onRequestConfirm }: {
  tasks: ScheduledTask[];
  api: ReturnType<typeof createApi>;
  onChanged: () => void;
  onRequestConfirm: (request: ConfirmDialogRequest) => void;
}) {
  // 默认展示任务列表；点击“创建”进入表单，点击某行进入执行详情页
  const [view, setView] = useState<'list' | 'create' | 'detail'>('list');
  const [selectedTaskId, setSelectedTaskId] = useState<number | undefined>();
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | undefined>();
  const [runsPage, setRunsPage] = useState(1);
  const [runsStatus, setRunsStatus] = useState('');
  const [newTask, setNewTask] = useState('');
  const [newCron, setNewCron] = useState('0 2 * * *');
  const [newPreApproved, setNewPreApproved] = useState(false);
  const [pageStatus, setPageStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTask, setEditTask] = useState('');
  const [editCron, setEditCron] = useState('');
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const selectedRun = runs.find((run) => run.id === selectedRunId) || runs[0];
  // 执行记录客户端分页：默认每页 5 条
  const runsPageCount = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  const pagedRuns = runs.slice((runsPage - 1) * RUNS_PAGE_SIZE, runsPage * RUNS_PAGE_SIZE);

  // 记录数变化（刷新 / 切任务）后把页码收敛到有效范围
  useEffect(() => {
    setRunsPage((current) => Math.min(current, Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE))));
  }, [runs.length]);

  // 详情页对应的任务被删除（或列表刷新后不存在）时回到列表
  useEffect(() => {
    if (selectedTaskId === undefined) return;
    if (tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(undefined);
    setView('list');
  }, [selectedTaskId, tasks]);

  const loadRuns = useCallback(async (): Promise<TaskRun[]> => {
    if (!selectedTask || selectedTask.id === undefined) {
      setRuns([]);
      setSelectedRunId(undefined);
      setRunsStatus('暂无执行结果');
      return [];
    }
    try {
      const body = await api.get<ScheduleRunsBody>(`/v1/schedule/${selectedTask.id}/runs`);
      const next = body.runs || [];
      setRuns(next);
      setSelectedRunId((current) => (current !== undefined && next.some((run) => run.id === current) ? current : next[0]?.id));
      setRunsStatus(next.length ? '' : '暂无执行结果');
      return next;
    } catch (err) {
      setRuns([]);
      setSelectedRunId(undefined);
      setRunsStatus(`加载执行结果失败：${formatError(err)}`);
      return [];
    }
  }, [api, selectedTask]);

  useEffect(() => {
    setRunsStatus('正在加载执行结果...');
    setRunsPage(1);
    void loadRuns();
    // 切换任务 / 卸载时停止“立即执行”的结果轮询
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = undefined;
    };
  }, [loadRuns]);

  async function createTask() {
    if (!newTask.trim()) {
      setPageStatus('请填写任务描述');
      return;
    }
    if (!newCron.trim()) {
      setPageStatus('请填写 cron 表达式');
      return;
    }
    setBusy(true);
    try {
      const body = await api.post<{ task: ScheduledTask }>('/v1/schedule', {
        task: newTask.trim(),
        cron: newCron.trim(),
        preApproved: newPreApproved,
      });
      setPageStatus(`已创建定时任务 #${body.task.id}，下次执行 ${formatDateTime(body.task.nextRunAt)}`);
      setNewTask('');
      setNewPreApproved(false);
      setView('list');
      onChanged();
    } catch (err) {
      setPageStatus(`创建失败：${formatError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(task: ScheduledTask) {
    if (task.id === undefined || busy) return;
    setBusy(true);
    try {
      await api.post(`/v1/schedule/${task.id}/${task.enabled ? 'disable' : 'enable'}`);
      setPageStatus(`已${task.enabled ? '暂停' : '启用'}任务 #${task.id}`);
      onChanged();
    } catch (err) {
      setPageStatus(`操作失败：${formatError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runNow(task: ScheduledTask) {
    if (task.id === undefined || busy) return;
    setBusy(true);
    try {
      await api.post(`/v1/schedule/${task.id}/run`);
      setRunsStatus('已触发立即执行，等待结果...');
      const before = runs[0]?.id;
      let attempts = 0;
      const poll = async () => {
        const next = await loadRuns();
        const latest = next[0]?.id;
        if ((latest !== undefined && latest !== before) || attempts++ >= 40) {
          if (latest !== undefined && latest !== before) onChanged(); // 刷新 lastRunAt / 下次执行
          return;
        }
        setRunsStatus('已触发立即执行，等待结果...');
        pollTimer.current = setTimeout(() => void poll(), 3000);
      };
      pollTimer.current = setTimeout(() => void poll(), 2000);
    } catch (err) {
      setPageStatus(`触发失败：${formatError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function requestDelete(task: ScheduledTask) {
    if (task.id === undefined) return;
    const id = task.id;
    onRequestConfirm({
      title: '删除定时任务',
      description: `将删除「${task.task}」及其全部执行记录，不可恢复。若只想暂停请用“暂停”。`,
      confirmLabel: '确认删除',
      busyLabel: '正在删除...',
      tone: 'danger',
      onConfirm: async () => {
        await api.delete(`/v1/schedule/${id}`);
        setPageStatus(`已删除任务 #${id}`);
        setSelectedTaskId(undefined);
        setView('list');
        onChanged();
      },
    });
  }

  function startEdit(task: ScheduledTask) {
    setEditTask(task.task);
    setEditCron(task.cron);
    setEditing(true);
  }

  async function saveEdit(task: ScheduledTask) {
    if (task.id === undefined || busy) return;
    if (!editTask.trim() || !editCron.trim()) {
      setPageStatus('任务描述与 cron 均不能为空');
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/v1/schedule/${task.id}`, { task: editTask.trim(), cron: editCron.trim() });
      setPageStatus(`已更新任务 #${task.id}`);
      setEditing(false);
      onChanged();
    } catch (err) {
      setPageStatus(`更新失败：${formatError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (view === 'create') {
    return (
      <>
        <PageTitle title="创建定时任务" desc="按 cron 周期自动执行的运维任务（cron 以 UTC 时区解释）" />
        <div className="toolbar">
          <Button variant="outline" type="button" onClick={() => { setPageStatus(''); setView('list'); }}>
            <ChevronLeft data-icon="inline-start" />
            返回列表
          </Button>
        </div>
        <Card className="schedule-form-card">
          <CardContent className="settings-form">
            <Label>任务描述<Textarea placeholder="描述你要定时执行的任务..." value={newTask} onChange={(event) => setNewTask(event.target.value)} /></Label>
            <Label>执行计划（cron，UTC）
              <Select value={CRON_PRESETS.some((p) => p.value === newCron) ? newCron : 'custom'} onValueChange={(value) => { if (value !== 'custom') setNewCron(value); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CRON_PRESETS.map((preset) => <SelectItem key={preset.value} value={preset.value}>{preset.label}</SelectItem>)}
                    <SelectItem value="custom">自定义</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Input value={newCron} spellCheck={false} placeholder='如 "0 2 * * *"' onChange={(event) => setNewCron(event.target.value)} />
            </Label>
            <label className="schedule-preapproved">
              <input type="checkbox" checked={newPreApproved} onChange={(event) => setNewPreApproved(event.target.checked)} />
              预批准（无人值守自动通过生产审批，需管理员）
            </label>
            {pageStatus ? <p className="empty-hint">{pageStatus}</p> : null}
            <div className="form-actions">
              <Button type="button" disabled={busy} onClick={() => void createTask()}>{busy ? '处理中...' : '创建任务'}</Button>
              <Button variant="outline" type="button" disabled={busy} onClick={() => { setPageStatus(''); setView('list'); }}>取消</Button>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  if (view === 'detail' && selectedTask) {
    return (
      <>
        <PageTitle title="定时任务详情" desc={`#${selectedTask.id} · ${humanizeCron(selectedTask.cron)}（UTC）`} />
        <div className="toolbar">
          <Button variant="outline" type="button" onClick={() => { setPageStatus(''); setEditing(false); setView('list'); }}>
            <ChevronLeft data-icon="inline-start" />
            返回列表
          </Button>
        </div>
        {pageStatus ? <p className="empty-hint schedule-page-status">{pageStatus}</p> : null}
        <Card className="schedule-detail-card">
          <CardHeader>
            <CardTitle>{selectedTask.task}</CardTitle>
            <CardDescription>
              {humanizeCron(selectedTask.cron)} · 下次执行 {formatDateTime(selectedTask.nextRunAt)}
              {selectedTask.preApproved ? ' · 预批准' : ''}
              {` · ${selectedTask.enabled ? '启用中' : '已暂停'}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="skill-detail-actions schedule-actions">
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void runNow(selectedTask)}>
                <Play data-icon="inline-start" />
                立即执行
              </Button>
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void toggleEnabled(selectedTask)}>
                {selectedTask.enabled ? <CircleStop data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                {selectedTask.enabled ? '暂停' : '启用'}
              </Button>
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => (editing ? setEditing(false) : startEdit(selectedTask))}>
                <SquarePen data-icon="inline-start" />
                {editing ? '取消编辑' : '编辑'}
              </Button>
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => requestDelete(selectedTask)}>
                <Trash2 data-icon="inline-start" />
                删除
              </Button>
              <Button variant="outline" size="sm" type="button" onClick={() => void loadRuns()}>
                <RefreshCcw data-icon="inline-start" />
                刷新
              </Button>
            </div>
            {editing ? (
              <div className="schedule-edit-form">
                <Label>任务描述<Textarea value={editTask} onChange={(event) => setEditTask(event.target.value)} /></Label>
                <Label>cron（UTC）<Input value={editCron} spellCheck={false} onChange={(event) => setEditCron(event.target.value)} /></Label>
                <Button type="button" size="sm" disabled={busy} onClick={() => void saveEdit(selectedTask)}>保存</Button>
              </div>
            ) : null}
            <h3 className="schedule-runs-title">执行记录</h3>
            <Table>
              <TableHeader>
                <TableRow>{['时间', '状态', '步骤'].map((header) => <TableHead key={header}>{header}</TableHead>)}</TableRow>
              </TableHeader>
              <TableBody>
                {pagedRuns.map((run, index) => (
                  <TableRow key={run.id ?? `${run.taskId}-${index}`} data-state={run === selectedRun ? 'selected' : undefined}>
                    <TableCell>
                      <button
                        className="schedule-run-button"
                        type="button"
                        onClick={() => {
                          if (run.id === undefined) return;
                          setSelectedRunId(run.id);
                        }}
                      >
                        {formatDateTime(run.createdAt)}
                      </button>
                    </TableCell>
                    <TableCell>{formatCell(run.status === 'success' ? '成功' : '异常')}</TableCell>
                    <TableCell>{run.steps === undefined ? '-' : String(run.steps)}</TableCell>
                  </TableRow>
                ))}
                {!runs.length ? (
                  <TableRow><TableCell colSpan={3}>{runsStatus || '暂无执行结果'}</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
            {runs.length ? (
              <div className="schedule-runs-pagination">
                <span>第 {runsPage}/{runsPageCount} 页 · 共 {runs.length} 条</span>
                <div>
                  <Button variant="outline" size="sm" type="button" disabled={runsPage <= 1} onClick={() => setRunsPage((current) => Math.max(1, current - 1))}>上一页</Button>
                  <Button variant="outline" size="sm" type="button" disabled={runsPage >= runsPageCount} onClick={() => setRunsPage((current) => Math.min(runsPageCount, current + 1))}>下一页</Button>
                </div>
              </div>
            ) : null}
            <div className="schedule-run-detail">
              <h3>执行结果</h3>
              <pre>{selectedRun?.detail || runsStatus || '暂无执行结果'}</pre>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageTitle title="定时任务" desc="按 cron 周期自动执行的运维任务（cron 以 UTC 时区解释）" />
      <div className="toolbar">
        <Button type="button" onClick={() => { setPageStatus(''); setView('create'); }}>
          <Plus data-icon="inline-start" />
          创建定时任务
        </Button>
      </div>
      {pageStatus ? <p className="empty-hint schedule-page-status">{pageStatus}</p> : null}
      <section className="schedule-list-panel">
        <Table>
          <TableHeader>
            <TableRow>
              {['任务', '计划', '下次执行', '状态', '最近执行'].map((header) => <TableHead key={header}>{header}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task, index) => (
              <TableRow
                key={task.id ?? `${task.task}-${index}`}
                className={task.id === undefined ? undefined : 'clickable-row'}
                role={task.id === undefined ? undefined : 'button'}
                tabIndex={task.id === undefined ? undefined : 0}
                onClick={() => {
                  if (task.id === undefined) return;
                  setSelectedTaskId(task.id);
                  setPageStatus('');
                  setEditing(false);
                  setView('detail');
                }}
                onKeyDown={(event) => {
                  if (task.id === undefined) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedTaskId(task.id);
                    setPageStatus('');
                    setEditing(false);
                    setView('detail');
                  }
                }}
              >
                <TableCell>
                  <span className="schedule-task-cell">
                    <strong>{task.task}</strong>
                    <span>#{task.id} {task.preApproved ? '· 预批准' : ''}</span>
                  </span>
                </TableCell>
                <TableCell>{humanizeCron(task.cron)}</TableCell>
                <TableCell>{formatDateTime(task.nextRunAt)}</TableCell>
                <TableCell>{formatCell(task.enabled ? '启用' : '暂停')}</TableCell>
                <TableCell>{task.lastRunAt ? formatDateTime(task.lastRunAt) : '待执行'}</TableCell>
              </TableRow>
            ))}
            {!tasks.length ? (
              <TableRow><TableCell colSpan={5}>暂无定时任务，点击上方“创建定时任务”，或在聊天里让 AI 帮你创建（schedule_task）。</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </section>
    </>
  );
}

function SandboxPage({ sandboxes, profiles }: { sandboxes: SandboxSummary[]; profiles: SandboxProfileSummary[] }) {
  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(null);
  const selectedIndex = sandboxes.findIndex((sandbox) => sandbox.id === selectedSandboxId);
  const selected = selectedIndex >= 0 ? sandboxes[selectedIndex] : undefined;

  useEffect(() => {
    if (selectedSandboxId && !sandboxes.some((sandbox) => sandbox.id === selectedSandboxId)) {
      setSelectedSandboxId(null);
    }
  }, [sandboxes, selectedSandboxId]);

  return (
    <>
      <PageTitle title="沙箱环境" desc="隔离的代码 / 命令执行环境" />
      <Tabs defaultValue="list" className="sandbox-page-tabs">
        <TabsList>
          <TabsTrigger value="list">沙箱列表（{sandboxes.length}）</TabsTrigger>
          <TabsTrigger value="profiles">沙箱模板（{profiles.length}）</TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <div className="two-pane single-pane">
            <section className="list-card">
              <div className="section-head compact">
                <h2>运行中的沙箱</h2>
                <span>点击某行查看详情</span>
              </div>
              <DataTable
                headers={['沙箱 ID', '状态', 'Profile', '镜像/模板', '绑定会话', 'Key', '活跃时间']}
                rows={sandboxes.map((sandbox) => [
                  sandbox.id,
                  sandbox.status,
                  sandbox.profile || sandbox.type || 'session',
                  sandbox.image || sandbox.type || '-',
                  sandbox.sessionId || '未绑定',
                  sandbox.key || '-',
                  formatDateTime(sandbox.lastUsedAt || sandbox.createdAt),
                ])}
                selectedRowIndex={selectedIndex >= 0 ? selectedIndex : null}
                onRowClick={(rowIndex) => setSelectedSandboxId(sandboxes[rowIndex]?.id ?? null)}
              />
              {!sandboxes.length ? <div className="empty-inline">当前没有运行中的沙箱。</div> : null}
            </section>
          </div>
        </TabsContent>
        <TabsContent value="profiles">
          <section className="list-card sandbox-profile-card">
            <div className="section-head compact">
              <h2>支持的沙箱模板</h2>
              <span>AI 会按任务能力选择 profile</span>
            </div>
            {profiles.length ? (
              <div className="sandbox-profile-grid">
                {profiles.map((profile) => (
                  <div key={profile.name} className="sandbox-profile-item">
                    <div>
                      <strong>{profile.name}</strong>
                      {profile.privileged ? <Badge className="badge-privileged" variant="outline">特权</Badge> : null}
                      {profile.desktop ? <Badge variant="secondary">浏览器</Badge> : null}
                    </div>
                    <p>{profile.description}</p>
                    <code>{profile.image || profile.domain || '-'}</code>
                    <span>{listSummary(profile.capabilities)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-inline">暂无可用沙箱模板。</div>
            )}
          </section>
        </TabsContent>
      </Tabs>
      {selected ? (
        <ModalDialog title={selected.id} status={selected.status} icon={<Cuboid />} onClose={() => setSelectedSandboxId(null)}>
          <div className="detail-panel">
            <h3>基本信息</h3>
            <div className="kv">
              <span>Profile</span><strong>{selected.profile || selected.type || 'session'}</strong>
              <span>镜像/模板</span><strong>{selected.image || '-'}</strong>
              <span>绑定会话</span><strong>{selected.sessionId || '未绑定'}</strong>
              <span>Key</span><strong>{selected.key || '-'}</strong>
              <span>Domain</span><strong>{selected.domain || '-'}</strong>
              <span>权限</span><strong>{selected.privileged ? '特权' : '普通'}</strong>
              <span>能力</span><strong>{listSummary(selected.capabilities)}</strong>
              <span>资源</span><strong>{resourceSummary(selected.resources)}</strong>
            </div>
            <h3>连接信息</h3>
            <div className="file-list"><span>Terminal /sandbox/{selected.id}/terminal</span><span>Browser /sandbox/{selected.id}/browser</span></div>
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
}

function SettingsPage({ llm, status, api, onLlmChange, onStatus }: {
  llm: RuntimeModelConfig;
  status: string;
  api: ReturnType<typeof createApi>;
  onLlmChange: (next: RuntimeModelConfig) => void;
  onStatus: (next: string) => void;
}) {
  const [form, setForm] = useState(() => ({ protocol: llm.protocol, base_url: llm.base_url, model: llm.model, api_key: llm.api_key || '', effort: llm.effort || 'medium', context_window_tokens: String(llm.context_window_tokens || 200000) }));

  useEffect(() => {
    setForm({ protocol: llm.protocol, base_url: llm.base_url, model: llm.model, api_key: llm.api_key || '', effort: llm.effort || 'medium', context_window_tokens: String(llm.context_window_tokens || 200000) });
  }, [llm.api_key, llm.base_url, llm.model, llm.protocol, llm.effort, llm.context_window_tokens]);

  // 上下文窗口仅在填了合法正整数时提交，避免编辑中间态触发后端 400。
  function formPayload() {
    const { context_window_tokens, ...rest } = form;
    const n = Number(context_window_tokens);
    return Number.isFinite(n) && n > 0 ? { ...rest, context_window_tokens: Math.floor(n) } : rest;
  }

  async function save() {
    onStatus('正在保存配置...');
    try {
      const body = await api.post<ModelSettingsBody>('/v1/settings/llm', formPayload());
      onLlmChange({ ...body.config, options: body.options || llm.options || [] });
      onStatus('配置已保存，新的聊天请求会使用该模型。');
    } catch (err) {
      onStatus(`保存失败：${formatError(err)}`);
    }
  }

  async function test() {
    onStatus('正在测试模型连接...');
    try {
      const body = await api.post<ModelSettingsBody & { text?: string }>('/v1/settings/llm/test', formPayload());
      onLlmChange({ ...body.config, options: body.options || llm.options || [] });
      onStatus(`测试成功：${body.text || '模型已响应'}`);
    } catch (err) {
      onStatus(`测试失败：${formatError(err)}`);
    }
  }

  return (
    <>
      <PageTitle title="设置" desc="模型与运行时配置" />
      <div className="settings-layout">
        <Card>
          <CardHeader>
            <CardTitle>LLM 配置</CardTitle>
            <CardDescription>当前模型会用于新的聊天请求。</CardDescription>
          </CardHeader>
          <CardContent className="settings-form">
            <Label>协议<Select value={form.protocol} onValueChange={(protocol) => setForm((current) => ({ ...current, protocol: protocol as RuntimeModelConfig['protocol'] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="anthropic">Anthropic</SelectItem><SelectItem value="openai">OpenAI Compatible</SelectItem></SelectGroup></SelectContent></Select></Label>
            <Label>Base URL<Input value={form.base_url} onChange={(event) => setForm((current) => ({ ...current, base_url: event.target.value }))} /></Label>
            <Label>API Key<Input placeholder="输入 API Key" value={form.api_key} onChange={(event) => setForm((current) => ({ ...current, api_key: event.target.value }))} /></Label>
            <Label>Model<Input value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} /></Label>
            <Label>上下文窗口（tokens）<Input type="number" min={20000} step={1000} placeholder="200000" value={form.context_window_tokens} onChange={(event) => setForm((current) => ({ ...current, context_window_tokens: event.target.value }))} /></Label>
            <Label>推理深度<Select value={form.effort} onValueChange={(effort) => setForm((current) => ({ ...current, effort: effort as ReasoningEffort }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="none">none（关闭思考）</SelectItem><SelectItem value="low">low</SelectItem><SelectItem value="medium">medium</SelectItem><SelectItem value="high">high</SelectItem><SelectItem value="xhigh">xhigh</SelectItem><SelectItem value="max">max</SelectItem></SelectGroup></SelectContent></Select></Label>
            {form.protocol === 'openai' ? <div className="settings-hint">推理深度仅对 Anthropic 协议生效</div> : null}
            {status ? <div className="settings-status">{status}</div> : null}
            <div className="form-actions">
              <Button variant="outline" type="button" onClick={() => void test()}>测试连接</Button>
              <Button type="button" onClick={() => void save()}>保存配置</Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="detail-title">
              <div className="large-icon"><KeyRound /></div>
              <div>
                <CardTitle>{llm.model || '未配置'}</CardTitle>
                <CardDescription>{llm.api_key_set ? '密钥已配置' : '密钥未配置'}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="kv">
            <span>协议</span><strong>{llm.protocol}</strong>
            <span>Base URL</span><strong>{llm.base_url || '-'}</strong>
            <span>Model</span><strong>{llm.model || '-'}</strong>
            <span>API Key</span><strong>{llm.api_key || '-'}</strong>
            <span>上下文窗口</span><strong>{llm.context_window_tokens ? `${llm.context_window_tokens.toLocaleString()} tokens` : '-'}</strong>
          </CardContent>
        </Card>
        <SchedulerSettingsCard api={api} onStatus={onStatus} />
      </div>
    </>
  );
}

function SchedulerSettingsCard({ api, onStatus }: {
  api: ReturnType<typeof createApi>;
  onStatus: (next: string) => void;
}) {
  const [minutes, setMinutes] = useState('240');

  useEffect(() => {
    let cancelled = false;
    api.get<{ settings?: { max_run_minutes?: number } }>('/v1/settings/scheduler')
      .then((body) => {
        if (!cancelled && typeof body.settings?.max_run_minutes === 'number') {
          setMinutes(String(body.settings.max_run_minutes));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [api]);

  async function save() {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 1) {
      onStatus('保存失败：最长运行时长必须是不小于 1 的分钟数');
      return;
    }
    onStatus('正在保存定时任务配置...');
    try {
      const body = await api.post<{ settings: { max_run_minutes: number } }>('/v1/settings/scheduler', { max_run_minutes: Math.floor(n) });
      setMinutes(String(body.settings.max_run_minutes));
      onStatus(`定时任务配置已保存：单次运行最长 ${formatRunDuration(body.settings.max_run_minutes)}。`);
    } catch (err) {
      onStatus(`保存失败：${formatError(err)}`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>定时任务</CardTitle>
        <CardDescription>无人值守运行的安全兜底：超时自动中止并记录失败。</CardDescription>
      </CardHeader>
      <CardContent className="settings-form">
        <Label>单次运行最长时长（分钟）
          <Input type="number" min={1} step={10} placeholder="240" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        </Label>
        <div className="settings-hint">默认 240 分钟（4 小时）；当前值折合 {formatRunDuration(Number(minutes) || 0)}</div>
        <div className="form-actions">
          <Button type="button" onClick={() => void save()}>保存配置</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function formatRunDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '-';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} 小时` : `${hours.toFixed(1)} 小时`;
}

function DataTable({ headers, rows, selectedRowIndex, onRowClick }: {
  headers: string[];
  rows: Array<Array<string>>;
  selectedRowIndex?: number | null;
  onRowClick?: (rowIndex: number) => void;
}) {
  const effectiveSelectedRowIndex = selectedRowIndex === undefined ? 0 : selectedRowIndex;
  return (
    <Table>
      <TableHeader>
        <TableRow>{headers.map((header) => <TableHead key={header}>{header}</TableHead>)}</TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, rowIndex) => (
          <TableRow
            key={row.join('-')}
            className={onRowClick ? 'clickable-row' : undefined}
            data-state={rowIndex === effectiveSelectedRowIndex ? 'selected' : undefined}
            role={onRowClick ? 'button' : undefined}
            tabIndex={onRowClick ? 0 : undefined}
            onClick={onRowClick ? () => onRowClick(rowIndex) : undefined}
            onKeyDown={onRowClick ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onRowClick(rowIndex);
              }
            } : undefined}
          >
            {row.map((cell, cellIndex) => <TableCell key={`${cell}-${cellIndex}`}>{formatCell(cell)}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function formatCell(cell: string) {
  if (['已启用', '已连接', '启用', '成功', 'ready'].includes(cell)) return <span><span className="green-dot" />{cell}</span>;
  if (['异常', '待审批', 'starting'].includes(cell)) return <span><span className="orange-dot" />{cell}</span>;
  if (['已禁用', '暂停', 'idle'].includes(cell)) return <span><span className="muted-dot" />{cell}</span>;
  return cell;
}

function PageTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
      {desc ? <p className="page-subtitle">{desc}</p> : null}
    </div>
  );
}

function LoginPage({ authStatus, onSubmit }: { authStatus: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand">
          <BrandLogo className="brand-logo-login" />
          <div>
            <h1>AIOP</h1>
            <p>登录后进入 AI 运维工作台</p>
          </div>
        </div>
        <form id="login-form" className="login-form" onSubmit={onSubmit}>
          <Label>租户<Input name="tenantId" defaultValue="default" autoComplete="organization" /></Label>
          <Label>用户名<Input name="username" defaultValue="admin" autoComplete="username" /></Label>
          <Label>密码<Input name="password" type="password" autoComplete="current-password" autoFocus /></Label>
          {authStatus ? <div className="settings-status">{authStatus}</div> : null}
          <Button className="login-submit" type="submit">登录</Button>
        </form>
      </section>
    </main>
  );
}
