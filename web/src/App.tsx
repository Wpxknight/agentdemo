import { Fragment, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  Activity,
  Bot,
  Boxes,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Code2,
  Cuboid,
  Cpu,
  Database,
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
  ShieldCheck,
  Terminal,
  TerminalSquare,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { NAV_ITEMS, defaultLlmConfig, fallbackSandboxes, fallbackSessions, fallbackTasks, fallbackTools } from './app-data';
import { createApi, randomId, readStorage, writeStorage } from './api';
import type {
  Attachment,
  ChatMessage,
  ModelSettingsBody,
  PageId,
  ReasoningEffort,
  Role,
  RuntimeModelConfig,
  SandboxSummary,
  SandboxesBody,
  ScheduleBody,
  ScheduledTask,
  SkillActionBody,
  SkillFileBody,
  SkillFileEntry,
  SkillsImportBody,
  SessionMessagesBody,
  SessionSummary,
  SessionsBody,
  TaskStep,
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
const SESSION_PAGE_SIZE = 20;

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

function toolCategory(name: string): string {
  if (name === 'load_skill' || name.startsWith('skill__')) return 'skill';
  if (name.startsWith('mcp__')) return 'mcp';
  if (name.startsWith('sbx__') || name.startsWith('browser_') || name === 'desktop_stream_url') return 'sandbox';
  return 'builtin';
}

function toolDisplayName(name = ''): string {
  return name.replace(/^mcp__/, '').replace(/^skill__/, '').replace(/^sbx__/, '');
}

function mcpServerName(name = ''): string {
  const parts = name.split('__');
  return parts.length >= 3 ? parts[1] || name : name;
}

function humanizeCron(cron: string): string {
  const map: Record<string, string> = {
    '0 2 * * *': '每天 02:00',
    '0 1 * * *': '每天 01:00',
    '0 * * * *': '每小时',
    '0 9 * * 1': '每周一 09:00',
  };
  return map[cron] || cron || '-';
}

function resourceSummary(resources?: Record<string, string>): string {
  if (!resources) return '-';
  return [resources.cpu, resources.memory, resources.storage].filter(Boolean).join(' / ') || '-';
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

/** 把沙箱 / kubectl 工具调用还原成可读的命令行；非这类工具返回 null。 */
function sandboxCommandLine(call: unknown): string | null {
  if (!call || typeof call !== 'object') return null;
  const { name, args } = call as { name?: string; args?: Record<string, unknown> };
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (name === 'sbx__run_command') return typeof a.command === 'string' ? a.command : null;
  if (name === 'sbx__run_code') {
    const lang = typeof a.language === 'string' ? a.language : 'python';
    return typeof a.code === 'string' ? `[${lang}]\n${a.code}` : null;
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

function sessionMessagesToChatMessages(body: SessionMessagesBody): ChatMessage[] {
  const messages = body.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message, index) => ({
      id: `history-${index}`,
      role: message.role as Role,
      text: message.text || '',
      thinking: message.thinking,
      time: '',
    }));
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

function ThinkingBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const trimmed = content.trim();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  if (!trimmed) return null;
  return (
    <details className="thinking-block" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Cpu />
        模型 thinking
      </summary>
      <div className="thinking-content">{renderTextLines(trimmed, 'thinking')}</div>
    </details>
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

const markdownComponents: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const language = /language-([\w-]+)/.exec(className || '')?.[1];
    const codeText = String(children ?? '').replace(/\n$/, '');
    const isBlock = Boolean(language) || codeText.includes('\n');
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
  return (
    <>
      {thinkingSegments.map((segment, index) => (
        <ThinkingBlock key={`thinking-${index}`} content={segment.content} streaming={segment.streaming} />
      ))}
      {message.steps?.length ? <TaskProgress steps={message.steps} /> : null}
      {textSegments.map((segment, index) => (
        <Fragment key={`text-${index}`}>
          {message.role === 'assistant'
            ? <MarkdownMessage content={segment.content} />
            : renderTextLines(segment.content, `text-${index}`)}
        </Fragment>
      ))}
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
  const [sessionId, setSessionId] = useState(() => readStorage('aiop_session_id') || randomId());
  const [sessions, setSessions] = useState<SessionSummary[]>(fallbackSessions);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [llm, setLlm] = useState<RuntimeModelConfig>(defaultLlmConfig);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [authStatus, setAuthStatus] = useState('');
  const [historyOpen, setHistoryOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewWidth, setPreviewWidth] = useState(() => clampPreviewWidth(readStorage('aiop_sandbox_width') || 440));
  const [sandboxOutput, setSandboxOutput] = useState('沙箱输出会显示在这里。');
  const [browserStreamUrl, setBrowserStreamUrl] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [toolTestOutput, setToolTestOutput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [composerValue, setComposerValue] = useState('');
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [runningAgentCount, setRunningAgentCount] = useState(0);
  const [skillShortcutDraft, setSkillShortcutDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    writeStorage('aiop_session_id', sessionId);
  }, [sessionId]);

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

  const fetchSessionsPage = useCallback(async (sessionOffset = 0, append = false) => {
    const body = await api.get<SessionsBody>(`/v1/sessions?limit=${SESSION_PAGE_SIZE}&offset=${sessionOffset}`);
    const next = body.sessions?.map(mapSessionSummary) || [];
    setSessions((current) => {
      if (!append) return next.length ? next : [];
      const seen = new Set(current.map((session) => session.sessionId).filter(Boolean));
      return [...current, ...next.filter((session) => !session.sessionId || !seen.has(session.sessionId))];
    });
    setSessionOffset(sessionOffset);
    setSessionTotal(body.total ?? next.length);
    setSessionHasMore(Boolean(body.hasMore));
  }, [api]);

  const loadPageData = useCallback(async (target: PageId | 'login' = page) => {
    if (!token || target === 'login') return;
    try {
      if (target === 'chat') {
        await loadLlmSettings();
        await fetchSessionsPage(0, false);
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
      const body = await api.get<SessionMessagesBody>(`/v1/sessions/${encodeURIComponent(session.sessionId)}/messages`);
      setSessionId(session.sessionId);
      writeStorage('aiop_session_id', session.sessionId);
      setMessages(sessionMessagesToChatMessages(body));
      setAttachments([]);
    } catch (err) {
      setMessages([{
        id: randomId(),
        role: 'assistant',
        text: `加载会话失败：${formatError(err)}`,
        time: new Date().toLocaleTimeString(),
      }]);
    }
  }

  function startNewSession() {
    const id = randomId();
    setSessionId(id);
    writeStorage('aiop_session_id', id);
    setMessages(initialMessages.slice(0, 1));
    setAttachments([]);
  }

  async function loadNextSessionsPage() {
    if (!sessionHasMore) return;
    await fetchSessionsPage(sessionOffset + SESSION_PAGE_SIZE, true);
  }

  async function deleteSession(session: SessionSummary) {
    if (!session.sessionId) return;
    if (!window.confirm(`确定删除会话“${session.title}”？`)) return;
    try {
      await api.delete<{ ok: boolean }>(`/v1/sessions/${encodeURIComponent(session.sessionId)}`);
      setSessions((current) => current.filter((item) => item.sessionId !== session.sessionId));
      setSessionTotal((current) => Math.max(0, current - 1));
      if (session.sessionId === sessionId) startNewSession();
    } catch (err) {
      setMessages((current) => [...current, {
        id: randomId(),
        role: 'assistant',
        text: `删除会话失败：${formatError(err)}`,
        time: new Date().toLocaleTimeString(),
      }]);
    }
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
      setMessages((current) => [...current, { id: randomId(), role: 'assistant', text: `请求失败：${response.status}`, time: new Date().toLocaleTimeString() }]);
      return;
    }
    const assistantId = randomId();
    const assistant: ChatMessage = { id: assistantId, role: 'assistant', text: '', time: new Date().toLocaleTimeString(), running: true };
    const publishAssistant = () => {
      setMessages((current) => current.map((message) => (message.id === assistantId ? { ...assistant } : message)));
    };
    setMessages((current) => [...current, assistant]);
    setRunningAgentCount((current) => current + 1);
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
          if (event?.event === 'thinking_delta' && typeof event.data?.text === 'string') {
            assistant.thinking = `${assistant.thinking || ''}${event.data.text}`;
            publishAssistant();
          }
          if (event?.event === 'text_delta' && typeof event.data?.text === 'string') {
            assistant.text += event.data.text;
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
          if (event?.event === 'tool_output' && typeof event.data?.text === 'string') {
            pushTerminal(event.data.text);
          }
          if (event?.event === 'tool_result' && typeof event.data?.toolId === 'string') {
            const toolId = event.data.toolId;
            const status: TaskStep['status'] = event.data.isError === true ? 'error' : 'done';
            assistant.steps = (assistant.steps || []).map((s) => (s.id === toolId ? { ...s, status } : s));
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
            setSessionId(event.data.sessionId);
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
      Object.assign(assistant, { running: false });
      publishAssistant();
      setRunningAgentCount((current) => Math.max(0, current - 1));
      await fetchSessionsPage(0, false);
    }
  }

  function sendComposer() {
    const task = composerValue.trim();
    const files = attachments.map(publicAttachment);
    if (!task && !files.length) return;
    const taskForAgent = applySkillShortcut(task, skillTools);
    const sentAttachments = attachments;
    setMessages((current) => [...current, {
      id: randomId(),
      role: 'user',
      text: task || '请分析上传附件。',
      time: new Date().toLocaleTimeString(),
      attachments: sentAttachments,
    }]);
    setComposerValue('');
    setSkillShortcutDraft('');
    setAttachments([]);
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
    setSandboxOutput('正在沙箱中运行代码...');
    try {
      const body = await api.post<ToolCallBody>('/v1/sandbox/run-code', { sessionId, code, language });
      setSandboxOutput(formatToolResponse(body));
    } catch (err) {
      setSandboxOutput(`运行失败：${formatError(err)}`);
    }
  }

  async function openBrowserStream() {
    setSandboxOutput('正在获取浏览器预览...');
    try {
      const body = await api.post<ToolCallBody>('/v1/browser/stream', { sessionId });
      const text = formatToolResponse(body);
      const url = extractUrl(text);
      if (url) setBrowserStreamUrl(url);
      setSandboxOutput(url ? `${text}\n已加载到右侧预览。` : text);
    } catch (err) {
      setSandboxOutput(`预览获取失败：${formatError(err)}`);
    }
  }

  async function captureBrowserScreenshot() {
    setSandboxOutput('正在刷新浏览器截图...');
    try {
      const body = await api.post<ToolCallBody>('/v1/browser/screenshot', { sessionId });
      setSandboxOutput(formatToolResponse(body));
    } catch (err) {
      setSandboxOutput(`截图失败：${formatError(err)}`);
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
          sessionHasMore={sessionHasMore}
          selectedSessionId={sessionId}
          messages={messages}
          attachments={attachments}
          composerValue={composerValue}
          skillSuggestions={skillSuggestions}
          skillShortcutDraft={skillShortcutDraft}
          llm={llm}
          settingsStatus={settingsStatus}
          runningAgentCount={runningAgentCount}
          sandboxOutput={sandboxOutput}
          browserStreamUrl={browserStreamUrl}
          composerRef={composerRef}
          fileInputRef={fileInputRef}
          onNavigate={navigate}
          onLogout={redirectToLogin}
          onToggleHistory={() => setHistoryOpen((value) => !value)}
          onTogglePreview={() => setPreviewOpen((value) => !value)}
          onNewSession={startNewSession}
          onSelectSession={selectSession}
          onDeleteSession={(session) => void deleteSession(session)}
          onLoadMoreSessions={() => void loadNextSessionsPage()}
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
              />
            )}
            {activePage === 'mcp' && <McpPage tools={mcpTools} output={toolTestOutput} onTest={testMcpTool} />}
            {activePage === 'schedule' && <SchedulePage tasks={tasks.length ? tasks : fallbackTasks} />}
            {activePage === 'sandbox' && <SandboxPage sandboxes={sandboxes.length ? sandboxes : fallbackSandboxes} />}
            {activePage === 'settings' && <SettingsPage llm={llm} status={settingsStatus} api={api} onLlmChange={setLlm} onStatus={setSettingsStatus} />}
          </section>
          </main>
        </div>
      </div>
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
  sessionHasMore: boolean;
  selectedSessionId: string;
  messages: ChatMessage[];
  attachments: Attachment[];
  composerValue: string;
  skillSuggestions: ToolSummary[];
  skillShortcutDraft: string;
  llm: RuntimeModelConfig;
  settingsStatus: string;
  runningAgentCount: number;
  sandboxOutput: string;
  browserStreamUrl: string;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onNavigate: (page: PageId) => void;
  onLogout: () => void;
  onToggleHistory: () => void;
  onTogglePreview: () => void;
  onNewSession: () => void;
  onSelectSession: (session: SessionSummary) => void;
  onDeleteSession: (session: SessionSummary) => void;
  onLoadMoreSessions: () => void;
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
            hasMore={props.sessionHasMore}
            selectedSessionId={props.selectedSessionId}
            onToggle={props.onToggleHistory}
            onSelect={props.onSelectSession}
            onDelete={props.onDeleteSession}
            onLoadMore={props.onLoadMoreSessions}
          />
        ) : null}
        <main className="prototype-chat-center">
          <PrototypeChatHeader
            runningAgentCount={props.runningAgentCount}
            onNewSession={props.onNewSession}
            onToggleHistory={props.onToggleHistory}
            onTogglePreview={props.onTogglePreview}
          />
          <PrototypeMessages messages={props.messages} />
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

function PrototypeSessionPanel({ sessions, total, hasMore, selectedSessionId, onToggle, onSelect, onDelete, onLoadMore }: {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
  selectedSessionId: string;
  onToggle: () => void;
  onSelect: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onLoadMore: () => void;
}) {
  const [query, setQuery] = useState('');
  const items = (sessions.length ? sessions : fallbackSessions).filter((session) => {
    const value = `${session.title} ${session.desc}`.toLowerCase();
    return value.includes(query.trim().toLowerCase());
  });

  return (
    <aside className="prototype-session-panel">
      <div className="prototype-session-head">
        <h2>最近会话</h2>
        <button type="button" onClick={onToggle} aria-label="收起最近会话">
          <ChevronLeft />
        </button>
      </div>
      <label className="prototype-session-search">
        <Search />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" />
      </label>
      <ScrollArea className="prototype-session-scroll">
        <div className="prototype-session-group">
          <span>今天</span>
          {items.map((session, index) => {
            const category = sessionCategoryFor(session);
            const SessionIcon = category.Icon;
            const isActive = Boolean(session.sessionId && session.sessionId === selectedSessionId);
            return (
              <div
                key={`${session.sessionId || session.title}-${index}`}
                className={cn('prototype-session-item', isActive && 'active')}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(session)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(session);
                  }
                }}
              >
                <span className={cn('prototype-session-icon', category.tone)}>
                  <SessionIcon />
                </span>
                <strong>{session.title}</strong>
                <time>{session.time}</time>
                {session.sessionId ? (
                  <button
                    className="prototype-session-delete"
                    type="button"
                    aria-label={`删除会话 ${session.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(session);
                    }}
                  >
                    <Trash2 />
                  </button>
                ) : null}
                <p>{session.desc}</p>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <div className="prototype-session-pagination">
        <span>{items.length} / {total || items.length}</span>
        <button type="button" disabled={!hasMore} onClick={onLoadMore}>加载更多</button>
      </div>
    </aside>
  );
}

function PrototypeChatHeader(props: { runningAgentCount: number; onNewSession: () => void; onToggleHistory: () => void; onTogglePreview: () => void }) {
  return (
    <div className="prototype-chat-header">
      <div>
        <h1>AI 助手</h1>
        <span>
          <i />
          {props.runningAgentCount ? `${props.runningAgentCount} 个任务运行中` : '就绪'}
        </span>
      </div>
      <div className="prototype-chat-actions">
        <button type="button" onClick={props.onToggleHistory} aria-label="切换会话列表">
          <PanelLeftClose />
        </button>
        <button type="button" onClick={props.onTogglePreview} aria-label="切换沙箱">
          <PanelRightClose />
        </button>
        <button type="button" className="primary" onClick={props.onNewSession}>
          <Plus />
          新建会话
        </button>
      </div>
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
  const [activeTab, setActiveTab] = useState<'terminal' | 'vnc' | 'browser'>('terminal');
  const [code, setCode] = useState('print("hello from sandbox")');
  const [language, setLanguage] = useState('python');

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
          { key: 'vnc' as const, label: 'VNC', icon: Monitor },
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
            <div className="prototype-code-card">
              <div>
                <span>
                  <Code2 />
                  运行代码
                </span>
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
              <button type="button" onClick={() => props.onRunSandbox(code, language)}>
                <Play />
                运行代码
              </button>
            </div>
            <PrototypeTerminal output={props.sandboxOutput} />
          </>
        )}
        {activeTab === 'vnc' && (
          <div className="prototype-empty-preview">
            <Monitor />
            <strong>VNC 桌面预览</strong>
            <span>连接到远程桌面。</span>
          </div>
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
  const preRef = useRef<HTMLPreElement>(null);
  // 实时输出时自动滚到底部，像终端一样跟随最新内容。
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);
  return (
    <div className="prototype-terminal">
      <div>
        <span>
          <Check />
          输出
        </span>
      </div>
      <pre ref={preRef}>{output || '沙箱输出会显示在这里。'}</pre>
    </div>
  );
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
          {(sessions.length ? sessions : fallbackSessions).slice(0, 10).map((session, index) => {
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
          })}
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
            <iframe className="vnc-preview-frame" src={props.browserStreamUrl} title="浏览器预览" />
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
        {props.sandboxOutput.split('\n').map((line, index) => <div key={index}>{line || '\u00a0'}</div>)}
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
  if (text.includes('pdf') || text.includes('doc')) return Code2;
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

function SkillsPage({ tools, api, onImported }: {
  tools: ToolSummary[];
  api: ReturnType<typeof createApi>;
  onImported: () => Promise<void>;
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

  async function deleteSelectedSkill() {
    if (!selectedName) return;
    if (!window.confirm(`确认删除技能 ${toolDisplayName(selectedName)}？此操作不可恢复。`)) return;
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
                  {entry.isDirectory ? <Boxes /> : <Code2 />}
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
                <Boxes data-icon="inline-start" />
                {showSkillFiles ? '隐藏目录' : '目录'}
              </Button>
              <Button variant="outline" size="sm" type="button" onClick={() => void toggleSkillEnabled()}>
                {isSkillEnabled(selected) ? <X data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                {isSkillEnabled(selected) ? '禁用' : '启用'}
              </Button>
              <Button variant="outline" size="sm" type="button" onClick={() => void deleteSelectedSkill()}>
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
          <pre className="skill-preview">{fileBody?.content || skillPreview(selected, selectedFile)}</pre>
        </main>
      </div>
    </section>
  );
}

function McpPage({ tools, output, onTest }: { tools: ToolSummary[]; output: string; onTest: (tool: string, args: string) => void }) {
  const servers = buildMcpServers(tools);
  const selected = servers[0] || { name: '-', transport: '-', status: '未连接', tools: [] as ToolSummary[] };
  const [tool, setTool] = useState(selected.tools[0]?.name || '');
  const [args, setArgs] = useState('{}');
  const hasTools = selected.tools.length > 0;
  const serverRows = servers.length
    ? servers.map((server) => [server.name, server.transport, server.status, String(server.tools.length), formatTime(new Date().toISOString())])
    : [['-', '-', '未连接', '0', '-']];

  useEffect(() => {
    if (!selected.tools.some((item) => item.name === tool)) {
      setTool(selected.tools[0]?.name || '');
    }
  }, [selected.tools, tool]);

  return (
    <ManagementPage title="MCP" desc="接入 MCP Server，扩展 AI 可用的工具" actionLabel="新增 MCP">
      <DataTable headers={['名称', '传输协议', '状态', '工具数', '最近心跳']} rows={serverRows} />
      <DetailPanel title={selected.name} status={selected.status} icon={<Boxes />}>
        <h3>连接配置</h3>
        <div className="kv"><span>传输协议</span><strong>{selected.transport}</strong><span>命令</span><strong>registry</strong></div>
        <h3>测试调用</h3>
        {!hasTools ? <p className="empty-hint">暂无已连接的 MCP 工具</p> : null}
        <Select value={tool} onValueChange={setTool} disabled={!hasTools}>
          <SelectTrigger><SelectValue placeholder="选择工具" /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {selected.tools.map((item) => <SelectItem key={item.name} value={item.name}>{toolDisplayName(item.name)}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Textarea id="tool-test-args" value={args} onChange={(event) => setArgs(event.target.value)} rows={5} spellCheck={false} disabled={!hasTools} />
        <Button type="button" disabled={!hasTools} onClick={() => onTest(tool, args)}>测试工具</Button>
        {output ? <pre className="tool-output">{output}</pre> : null}
      </DetailPanel>
    </ManagementPage>
  );
}

function buildMcpServers(tools: ToolSummary[]) {
  const servers = new Map<string, { name: string; transport: string; status: string; tools: ToolSummary[] }>();
  for (const tool of tools) {
    const name = mcpServerName(tool.name);
    const server = servers.get(name) || { name, transport: tool.transport || 'stdio', status: tool.status || '已连接', tools: [] };
    server.tools.push(tool);
    servers.set(name, server);
  }
  return [...servers.values()];
}

function ManagementPage({ title, desc, actionLabel, children }: { title: string; desc?: string; actionLabel: string; children: React.ReactNode }) {
  const content = Array.isArray(children) ? children : [children];
  return (
    <>
      <PageTitle title={title} desc={desc} />
      <div className="toolbar">
        <label className="search-box"><Search /><Input placeholder={`搜索${title}`} /></label>
        <Button variant="outline">全部</Button>
        <Button variant="outline">已启用</Button>
        <Button>{actionLabel}</Button>
      </div>
      <div className="two-pane">
        <section className="list-card">{content[0]}</section>
        <aside className="detail-card">{content[1]}</aside>
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

function SchedulePage({ tasks }: { tasks: ScheduledTask[] }) {
  const selected = tasks[0] || fallbackTasks[0];
  return (
    <>
      <PageTitle title="定时任务" desc="按 cron 周期自动执行的运维任务" />
      <Card className="create-task">
        <CardContent className="task-create-grid">
          <Label>创建任务<Textarea placeholder="描述你要定时执行的任务..." /></Label>
          <Label>执行计划<Input defaultValue="每天 02:00" /></Label>
          <Button>创建任务</Button>
        </CardContent>
      </Card>
      <div className="task-layout">
        <DataTable headers={['任务', '计划', '下次执行', '状态', '最近结果']} rows={tasks.map((task) => [task.task, humanizeCron(task.cron), formatDateTime(task.nextRunAt), task.enabled ? '启用' : '暂停', task.lastRunAt ? '成功' : '待执行'])} />
        <Card className="detail-card compact">
          <CardHeader>
            <CardTitle>{selected.task}</CardTitle>
            <CardDescription>{humanizeCron(selected.cron)} · 下次执行 {formatDateTime(selected.nextRunAt)}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable headers={['时间', '状态', '耗时']} rows={[[formatDateTime(selected.lastRunAt), selected.lastRunAt ? '成功' : '待执行', selected.lastRunAt ? '18.42s' : '-']]} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function SandboxPage({ sandboxes }: { sandboxes: SandboxSummary[] }) {
  const selected = sandboxes[0] || fallbackSandboxes[0];
  return (
    <>
      <PageTitle title="沙箱环境" desc="隔离的代码 / 命令执行环境" />
      <div className="toolbar">
        <Badge variant="secondary"><CheckCircle2 />运行中</Badge>
        <label className="search-box"><Search /><Input placeholder="搜索沙箱" /></label>
        <Button>新建沙箱</Button>
      </div>
      <div className="two-pane">
        <section className="list-card">
          <DataTable headers={['名称', '状态', '类型', '资源', '绑定会话', '创建时间']} rows={sandboxes.map((sandbox) => [sandbox.id, sandbox.status, sandbox.type || 'session', resourceSummary(sandbox.resources), sandbox.sessionId || '未绑定', formatDateTime(sandbox.createdAt)])} />
        </section>
        <aside className="detail-card">
          <DetailPanel title={selected.id} status={selected.status} icon={<Cuboid />}>
            <h3>基本信息</h3>
            <div className="kv"><span>模板</span><strong>{selected.type || 'session'}</strong><span>资源</span><strong>{resourceSummary(selected.resources)}</strong></div>
            <h3>连接信息</h3>
            <div className="file-list"><span>Terminal /sandbox/{selected.id}/terminal</span><span>Browser /sandbox/{selected.id}/browser</span></div>
          </DetailPanel>
        </aside>
      </div>
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
  const [form, setForm] = useState(() => ({ protocol: llm.protocol, base_url: llm.base_url, model: llm.model, api_key: llm.api_key || '', effort: llm.effort || 'medium' }));

  useEffect(() => {
    setForm({ protocol: llm.protocol, base_url: llm.base_url, model: llm.model, api_key: llm.api_key || '', effort: llm.effort || 'medium' });
  }, [llm.api_key, llm.base_url, llm.model, llm.protocol, llm.effort]);

  async function save() {
    onStatus('正在保存配置...');
    try {
      const body = await api.post<ModelSettingsBody>('/v1/settings/llm', form);
      onLlmChange({ ...body.config, options: body.options || llm.options || [] });
      onStatus('配置已保存，新的聊天请求会使用该模型。');
    } catch (err) {
      onStatus(`保存失败：${formatError(err)}`);
    }
  }

  async function test() {
    onStatus('正在测试模型连接...');
    try {
      const body = await api.post<ModelSettingsBody & { text?: string }>('/v1/settings/llm/test', form);
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
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: Array<Array<string>> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>{headers.map((header) => <TableHead key={header}>{header}</TableHead>)}</TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, rowIndex) => (
          <TableRow key={row.join('-')} data-state={rowIndex === 0 ? 'selected' : undefined}>
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
