import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/server/http.js';
import { MemoryStore } from '../src/db/memory.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { ChatModel, StreamEvent } from '../src/model/types.js';

describe('React frontend stack', () => {
  it('uses the AIOP logo as the browser tab icon', async () => {
    const html = await readFile('web/index.html', 'utf8');

    expect(html).toContain('<link rel="icon" type="image/jpeg" href="/assets/logo.jpg" />');
  });

  it('uses React, Vite, Tailwind, and shadcn project wiring under web/', async () => {
    const pkg = JSON.parse(await readFile('web/package.json', 'utf8')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const vite = await readFile('web/vite.config.ts', 'utf8');
    const components = await readFile('web/components.json', 'utf8');
    const main = await readFile('web/src/main.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(pkg.scripts).toMatchObject({ dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' });
    expect(pkg.dependencies).toHaveProperty('react');
    expect(pkg.dependencies).toHaveProperty('react-dom');
    expect(pkg.dependencies).toHaveProperty('lucide-react');
    expect(pkg.dependencies).toHaveProperty('class-variance-authority');
    expect(pkg.devDependencies).toHaveProperty('@vitejs/plugin-react');
    expect(pkg.devDependencies).toHaveProperty('tailwindcss');
    expect(vite).toContain('@vitejs/plugin-react');
    expect(components).toContain('"tsx": true');
    expect(components).toContain('"ui": "@/components/ui"');
    expect(main).toContain('createRoot');
    expect(css).toContain('@tailwind base');
  });

  it('keeps the approved navigation model in React source', async () => {
    const data = await readFile('web/src/app-data.ts', 'utf8');

    expect(data).toContain("label: '聊天'");
    expect(data).toContain("label: '技能'");
    expect(data).toContain("label: 'MCP'");
    expect(data).toContain("label: '定时任务'");
    expect(data).toContain("label: '沙箱环境'");
    expect(data).toContain("label: '设置'");
    expect(data).not.toContain('会话记录');
    expect(data).toContain('hasSessionHistoryDrawer: true');
    expect(data).toContain('hasSandboxWorkspace: true');
    expect(data).toContain('hasSandboxWorkspace: false');
  });
});

describe('frontend container proxy', () => {
  it('proxies browser API requests to the backend container on localhost', async () => {
    const nginx = await readFile('web/nginx.conf', 'utf8');

    expect(nginx).toContain('proxy_pass http://127.0.0.1:8081');
    expect(nginx).toMatch(/location\s+\^~\s+\/auth\//);
    expect(nginx).toMatch(/location\s+\^~\s+\/v1\//);
    expect(nginx).toMatch(/location\s+=\s+\/healthz/);
    expect(nginx).toMatch(/location\s+=\s+\/readyz/);
    expect(nginx).toContain('proxy_buffering off');
  });

  it('builds React assets in the frontend container before nginx serves them', async () => {
    const dockerfile = await readFile('web/Dockerfile', 'utf8');

    expect(dockerfile).toContain('FROM node:24-slim AS build');
    expect(dockerfile).toContain('npm run build');
    expect(dockerfile).toContain('COPY --from=build /app/dist /usr/share/nginx/html');
  });

  it('keeps the bundled skills directory writable for runtime zip imports', async () => {
    const dockerfile = await readFile('Dockerfile', 'utf8');

    expect(dockerfile).toContain('COPY --chown=node:node skills ./skills');
    expect(dockerfile).toContain('USER node');
  });
});

describe('frontend API wiring', () => {
  it('loads every menu page from backend endpoints', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain('api.get<SessionsBody>(`/v1/sessions?limit=${SESSION_PAGE_SIZE}&offset=${sessionOffset}`');
    expect(app).toContain("api.get<ToolsBody>('/v1/tools");
    expect(app).toContain("api.get<ScheduleBody>('/v1/schedule");
    expect(app).toContain('api.get<ScheduleRunsBody>(`/v1/schedule/${selectedTask.id}/runs`)');
    expect(app).toContain("api.get<SandboxesBody>('/v1/sandboxes");
    expect(app).toContain("api.get<ModelSettingsBody>('/v1/settings/llm");
  });

  it('lets operators select scheduled tasks and inspect retained run results', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');

    expect(types).toContain('export interface TaskRun');
    expect(types).toContain('export interface ScheduleRunsBody');
    expect(app).toContain('useState<TaskRun[]>([])');
    expect(app).toContain('<SchedulePage tasks={tasks.length ? tasks : fallbackTasks} api={api} />');
    expect(app).toContain('selectedTaskId');
    expect(app).toContain('selectedRunId');
    expect(app).toContain('setSelectedTaskId(task.id)');
    expect(app).toContain('setSelectedRunId(run.id)');
    expect(app).toContain('className="schedule-task-button"');
    expect(app).toContain('className="schedule-run-button"');
    expect(app).toContain('className="schedule-run-detail"');
    expect(app).toContain('执行结果');
    expect(css).toContain('.schedule-task-button');
    expect(css).toContain('.schedule-run-button');
    expect(css).toContain('.schedule-run-detail');
  });

  it('keeps the chat browser area as preview-only UI', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain("api.post<ToolCallBody>('/v1/sandbox/run-code");
    expect(app).toContain("api.post<ToolCallBody>('/v1/browser/stream");
    expect(app).toContain("api.post<ToolCallBody>('/v1/browser/screenshot");
    expect(app).toContain('runSandboxCode');
    expect(app).toContain('openBrowserStream');
    expect(app).toContain('浏览器预览');
    expect(app).not.toContain("api.post('/v1/browser/navigate");
    expect(app).not.toContain("api.post('/v1/browser/click");
    expect(app).not.toContain("api.post('/v1/browser/type");
    expect(app).not.toContain('browserNavigate');
    expect(app).not.toContain('browserClick');
    expect(app).not.toContain('browserType');
    expect(app).not.toContain('id="browser-control-form"');
  });

  it('keeps chat composer focused on input without model footer details', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).not.toContain('模型</button>');
    expect(app).not.toContain('ComposerModelFooter');
    expect(app).not.toContain('model_id');
    expect(app).not.toContain('模型信息');
    expect(app).not.toContain('prototype-composer-meta');
    expect(app).not.toContain('composer-meta');
    expect(css).not.toContain('.prototype-composer-meta');
    expect(css).not.toContain('.composer-meta');
    expect(css).not.toContain('.model-picker');
  });

  it('redirects unauthenticated users to a login page instead of rendering login buttons', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain('LoginPage');
    expect(app).toContain('redirectToLogin');
    expect(app).toContain("window.location.pathname !== '/login'");
    expect(app).toContain('id="login-form"');
    expect(app).not.toContain('data-action="login"');
  });

  it('supports dragging the right preview panel wider', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('previewWidth');
    expect(app).toContain('startPreviewResize');
    expect(app).toContain("writeStorage('aiop_sandbox_width'");
    expect(app).toContain('resize-handle');
    expect(css).toContain('--sandbox-width');
    expect(css).toContain('.resize-handle');
    expect(css).toContain('grid-template-columns: 280px minmax(520px, 1fr) var(--sandbox-width)');
  });

  it('uses a refined visual system for the chat workbench', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('BrowserPreviewPanel');
    expect(app).toContain('PrototypeChatShell');
    expect(app).toContain('prototype-chat-page');
    expect(app).toContain('prototype-sidebar-nav');
    expect(app).toContain('<PrototypeSidebarNav page="chat"');
    expect(app).toContain('<div className="prototype-chat-page management-page">');
    expect(app).toContain('<div className="prototype-main-content management-main-content">');
    expect(app).toContain('<PrototypeSidebarNav page={activePage}');
    expect(app).toContain('SidebarAccountMenu');
    expect(app).toContain('account-popover');
    expect(app).toContain('prototype-session-panel');
    expect(app).toContain('prototype-sandbox-panel');
    expect(app).toContain('prototype-message-end');
    expect(app).toContain("scrollIntoView({ block: 'end' })");
    expect(app).toContain('BrandLogo');
    expect(app).toContain('MessageAvatar');
    expect(app).toContain('sessionCategoryFor');
    expect(app).toContain("activePage === 'chat'");
    expect(css).toContain('--surface-raised');
    expect(css).toContain('--surface-muted');
    expect(css).toContain('--brand-soft');
    expect(css).toContain('--focus-ring');
    expect(css).toContain('.prototype-chat-page');
    expect(css).toContain('.management-page');
    expect(css).toContain('.management-main-content');
    expect(css).not.toContain('.prototype-topbar');
    expect(css).not.toContain('.topbar');
    expect(css).toContain('.sidebar-account');
    expect(css).toContain('.account-popover');
    expect(css).toContain('.prototype-main-content');
    expect(css).toContain('.prototype-message-end');
    expect(css).toContain('.brand-logo');
    expect(css).toContain('.session-row-icon');
    expect(css).toContain('.message-avatar-image');
    expect(css).toContain('.composer-action-row');
    expect(css).toContain('.messages-grid::before');
    expect(css).toContain('.composer-shell::before');
    expect(css).toContain('.browser-preview-panel');
    expect(css).toContain('linear-gradient(180deg, hsl(var(--background)) 0%, hsl(var(--muted)) 100%)');
  });

  it('supports composer attachments and enter-key submission ergonomics', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain('useState<Attachment[]>([])');
    expect(app).toContain('type="file"');
    expect(app).toContain('id="attachment-input"');
    expect(app).toContain('readFileAsDataUrl');
    expect(app).toContain('attachments');
    expect(app).toContain('handleComposerKeydown');
    expect(app).toContain("event.key !== 'Enter'");
    expect(app).toContain('event.shiftKey');
    expect(app).toContain('event.altKey');
    expect(app).toContain('insertComposerNewline');
    expect(app).toContain("setRangeText('\\n'");
  });

  it('loads persisted messages when a history session is selected', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain('SessionMessagesBody');
    expect(app).toContain('sessionMessagesToChatMessages');
    expect(app).toContain('selectSession');
    expect(app).toContain("api.get<SessionMessagesBody>(`/v1/sessions/${encodeURIComponent(session.sessionId)}/messages`)");
    expect(app).toContain('onSelectSession={selectSession}');
    expect(app).toContain('onClick={() => onSelect(session)}');
  });

  it('confirms before stopping the active chat run', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('CircleStop');
    expect(app).toContain('ConfirmDialog');
    expect(app).toContain('confirmDialog');
    expect(app).toContain('requestStopCurrentSession');
    expect(app).toContain('terminateCurrentSession');
    expect(app).toContain('onRequestStopSession={requestStopCurrentSession}');
    expect(app).toContain('onConfirm={() => void runConfirmDialogAction()}');
    expect(app).toContain('onCancel={cancelConfirmDialog}');
    expect(app).toContain('onRequestStopSession: () => void');
    expect(app).toContain('aria-label="停止"');
    expect(app).toContain("'停止中'");
    expect(app).toContain("'停止'");
    expect(app).toContain('确认停止当前任务？');
    expect(app).toContain('停止后，当前会话正在执行的模型响应和工具调用会被中断。');
    expect(app).toContain('className="confirm-dialog-alert"');
    expect(app).not.toContain('className="confirm-dialog-icon"');
    expect(app).not.toContain('className="confirm-dialog-kicker"');
    expect(app).not.toContain('className="confirm-dialog-meta"');
    expect(app).toContain('中断执行');
    expect(app).not.toContain('终止会话');
    expect(app).toContain('`/v1/sessions/${encodeURIComponent(sessionId)}/terminate`');
    const confirmBackdropRule = css.match(/\.confirm-dialog-backdrop\s*\{[\s\S]*?\n  \}/)?.[0] || '';
    expect(css).toContain('.confirm-dialog-backdrop');
    expect(css).toContain('.confirm-dialog-panel');
    expect(css).toContain('background: rgba(15, 23, 42, .18);');
    expect(confirmBackdropRule).not.toContain('backdrop-filter');
    expect(css).toContain('.confirm-dialog-alert');
    expect(css).not.toContain('.confirm-dialog-panel::before');
    expect(css).not.toContain('.confirm-dialog-kicker');
    expect(css).not.toContain('.confirm-dialog-meta');
    expect(css).not.toContain('.confirm-dialog-icon');
    expect(css).toContain('.confirm-dialog-actions button.primary');
    expect(css).toContain('.prototype-chat-actions button.danger');
    expect(css).toContain('font-size: 0;');
    expect(css).toContain('.confirm-dialog-actions');
  });

  it('uses page-styled confirmation dialogs instead of browser-native prompts', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).not.toMatch(/window\.(confirm|alert|prompt)/);
    expect(app).toContain('requestDeleteSession');
    expect(app).toContain('requestDeleteSelectedSkill');
    expect(app).toContain("confirmLabel: '确认删除'");
    expect(app).toContain('onRequestConfirm={requestConfirmDialog}');
    expect(app).toContain('title: `删除会话“${sessionLabel}”？`');
    expect(app).toContain('删除后，这条会话记录和历史消息将从列表中移除。');
    expect(app).toContain('此操作不可恢复，请确认不再需要这条会话记录。');
    expect(app).toContain('删除技能');
    expect(app).not.toContain("kicker: '删除确认'");
    expect(app).not.toContain("icon: 'delete'");
  });

  it('shows sandbox output as structured terminal entries and keeps the code runner collapsed', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');
    const sandboxOutput = await readFile('web/src/sandbox-output.ts', 'utf8');

    expect(app).toContain('<details className="prototype-code-card"');
    expect(app).toContain('<summary>');
    expect(app).toContain('parseSandboxOutput');
    expect(app).toContain('formatSandboxOutputChunk');
    expect(sandboxOutput).toContain("'command' | 'stdout' | 'stderr' | 'error'");
    expect(sandboxOutput).toContain("push('command'");
    expect(sandboxOutput).toContain('sandbox-output-line command');
    expect(sandboxOutput).toContain('[stdout]');
    expect(sandboxOutput).toContain('[stderr]');
    expect(app).toContain('sandboxOutputCommand');
    expect(app).toContain('terminalStats');
    expect(app).toContain('renderSandboxOutputSegments');
    expect(app).toContain('entry.segments');
    expect(app).toContain('sandbox-output-label');
    expect(app).toContain('prototype-terminal-empty');
    expect(css).toContain('.sandbox-output-line.command');
    expect(css).toContain('.sandbox-output-line.stderr');
    expect(css).toContain('.sandbox-output-line.error');
    expect(css).toContain('.sandbox-output-line .sandbox-output-label');
    expect(css).toContain('.sandbox-output-line code .ansi-segment');
    expect(css).toContain('.sandbox-output-line code .ansi-fg-red');
    expect(css).toContain('.sandbox-output-line code .ansi-bg-blue');
    expect(css).toContain('.prototype-terminal-head');
    expect(css).toContain('display: block;');
    expect(css).toContain('white-space: pre');
    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('.prototype-code-card summary');
  });

  it('supports paginated and deletable session history without blocking chat input during runs', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');

    expect(app).toContain('SESSION_PAGE_SIZE');
    expect(app).toContain('sessionOffset');
    expect(app).toContain('sessionTotal');
    expect(app).toContain("`/v1/sessions?limit=${SESSION_PAGE_SIZE}&offset=${sessionOffset}`");
    expect(app).toContain('hasMore');
    expect(app).toContain('loadNextSessionsPage');
    expect(app).toContain('deleteSession');
    expect(app).toContain('api.delete<{ ok: boolean }>(`/v1/sessions/${encodeURIComponent(session.sessionId)}`');
    expect(app).toContain('onDeleteSession');
    expect(app).toContain('event.stopPropagation()');
    expect(app).toContain('aria-label={`删除会话 ${session.title}`}');
    expect(app).toContain('runningAgentCount');
    expect(app).toContain('running: true');
    expect(app).toContain('running: false');
    expect(app).toContain('message.running');
    expect(app).toContain('prototype-running-indicator');
    expect(css).toContain('.prototype-running-indicator');
    expect(css).toContain('@keyframes aiop-thinking-pulse');
    expect(types).toContain('running?: boolean');
    expect(types).toContain('total?: number;');
    expect(types).toContain('offset?: number;');
    expect(types).toContain('hasMore?: boolean;');
    expect(app).not.toContain('disabled={runningAgentCount');
  });

  it('does not show sample sessions when the backend returns an empty history list', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('useState<SessionSummary[]>([])');
    expect(app).not.toContain('useState<SessionSummary[]>(fallbackSessions)');
    expect(app).not.toContain('(sessions.length ? sessions : fallbackSessions)');
    expect(app).toContain('prototype-session-empty');
    expect(app).toContain('暂无会话记录');
    expect(css).toContain('.prototype-session-empty');
    expect(css).toContain('.session-empty');
  });

  it('supports slash skill shortcuts in the chat composer', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('parseSkillShortcut');
    expect(app).toContain('applySkillShortcut');
    expect(app).toContain('skillShortcutDraft');
    expect(app).toContain('slash-skill-menu');
    expect(app).toContain('slash-skill-option');
    expect(app).toContain('使用技能');
    expect(app).toContain("api.get<ToolsBody>('/v1/tools')");
    expect(app).toContain("请先使用技能 ${shortcut.skill.name}");
    expect(app).toContain('skillSuggestions');
    expect(css).toContain('.slash-skill-menu');
    expect(css).toContain('.slash-skill-option');
  });

  it('keeps message time outside bubbles and renders model thinking as collapsible content', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('function splitThinkingSegments');
    expect(app).toContain('function MessageContent');
    expect(app).toContain('function ThinkingBlock');
    expect(app).toContain('<details className="thinking-block"');
    expect(app).toContain('const [open, setOpen] = useState(true)');
    expect(app).toContain('const thinkingSegments');
    expect(app).toContain('const textSegments');
    expect(app).toContain("event?.event === 'thinking_delta'");
    expect(app).toContain('assistant.thinking');
    expect(app).toContain('message.id === assistantId');
    expect(app).not.toContain('message === assistant');
    expect(app).toContain('<time className="prototype-message-time">{message.time}</time>');
    expect(app).toContain('<time className="message-time">{message.time}</time>');
    expect(app).not.toContain('<time>{message.time}</time>');
    expect(css).toContain('.prototype-message-stack');
    expect(css).toContain('.prototype-message-time');
    expect(css).toContain('.message-time');
    expect(css).toContain('.thinking-block');
    expect(css).not.toContain('.prototype-bubble time');
    expect(css).not.toContain('.bubble time');
  });

  it('uses the refreshed AIOP logo for assistant identity and concise running copy', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain("const logoUrl = '/assets/logo.jpg'");
    expect(app).toContain('const aiAvatarUrl = logoUrl');
    expect(app).toContain('<em>执行中</em>');
    expect(app).toContain('aria-label="执行中"');
    expect(app).not.toContain("const aiAvatarUrl = '/assets/ai-avatar.jpg'");
    expect(app).not.toContain('AI 正在执行');
  });

  it('renders assistant replies with Markdown, GFM, and syntax highlighting only for assistant messages', async () => {
    const pkg = JSON.parse(await readFile('web/package.json', 'utf8')) as { dependencies: Record<string, string> };
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(pkg.dependencies).toHaveProperty('react-markdown');
    expect(pkg.dependencies).toHaveProperty('remark-gfm');
    expect(pkg.dependencies).toHaveProperty('rehype-highlight');
    expect(pkg.dependencies).toHaveProperty('highlight.js');
    expect(app).toContain("import ReactMarkdown, { type Components } from 'react-markdown'");
    expect(app).toContain("import remarkGfm from 'remark-gfm'");
    expect(app).toContain("import rehypeHighlight from 'rehype-highlight'");
    expect(app).toContain('function MarkdownMessage');
    expect(app).toContain('remarkPlugins={[remarkGfm]}');
    expect(app).toContain('rehypePlugins={[rehypeHighlight]}');
    expect(app).toContain("skipHtml");
    expect(app).toContain("message.role === 'assistant'");
    expect(app).toContain('<MarkdownMessage content={segment.content} />');
    expect(app).toContain("renderTextLines(segment.content, `text-${index}`)");
  });

  it('styles Markdown output and code blocks without breaking message bubbles', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('className="markdown-code-block"');
    expect(app).toContain('className="markdown-inline-code"');
    expect(app).toContain('className="markdown-link"');
    expect(css).toContain('.markdown-body');
    expect(css).toContain('.markdown-code-block');
    expect(css).toContain('.markdown-inline-code');
    expect(css).toContain('.markdown-body table');
    expect(css).toContain('.markdown-body blockquote');
    expect(css).toContain('.markdown-body pre');
    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('word-break: break-word');
  });

  it('keeps the skills page focused on browsing and import without test-call controls', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('SkillFileEntry');
    expect(app).toContain('SkillFileBody');
    expect(app).toContain('SkillActionBody');
    expect(app).toContain('showSkillFiles');
    expect(app).toContain('skill-file-tree-panel');
    expect(app).toContain('skill-tree-node');
    expect(app).toContain('skill-tree-up-button');
    expect(app).toContain('skill-import-button');
    expect(app).toContain("accept=\".zip,application/zip,application/x-zip-compressed\"");
    expect(app).toContain("api.post<SkillsImportBody>('/v1/skills/import");
    expect(app).toContain('api.get<SkillFileBody>(`/v1/skills/${encodeURIComponent(selectedName)}/files');
    expect(app).toContain('api.post<SkillActionBody>(`/v1/skills/${encodeURIComponent(selectedName)}/disable`');
    expect(app).toContain('api.post<SkillActionBody>(`/v1/skills/${encodeURIComponent(selectedName)}/enable`');
    expect(app).toContain('api.delete<SkillActionBody>(`/v1/skills/${encodeURIComponent(selectedName)}`');
    expect(app).toContain('requestDeleteSelectedSkill');
    expect(app).not.toContain('window.confirm');
    expect(app).toContain('readFileAsDataUrl(file)');
    expect(app).toContain('await onImported()');
    expect(app).toContain("setSelectedFile('SKILL.md')");
    expect(app).toContain('导入技能');
    expect(app).toContain('文件大小');
    expect(app).toContain('更新时间');
    expect(app).not.toContain('来源 <strong>');
    expect(app).not.toContain('最近使用');
    expect(app).not.toContain('管理 AI 助手可调用的技能包和附带文件');
    expect(app).not.toContain('testSkillTool');
    expect(app).not.toContain(`<SkillsPage tools={skillTools.length ? skillTools : fallbackTools.filter((tool) => tool.category === 'skill')} output=`);
    expect(app).not.toContain('测试加载');
    expect(css).toContain('.skills-workbench');
    expect(css).toContain('.skill-file-tree-panel');
    expect(css).toContain('.skill-tree-node');
    expect(css).toContain('.skill-tree-up-button');
  });

  it('shows a one-line description beside each page title', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    // PageTitle 支持标题同行展示简要描述
    expect(app).toContain('function PageTitle({ title, desc }');
    expect(app).toContain('className="page-subtitle"');
    expect(app).toContain('className="page-heading"');
    // 各页描述文案
    expect(app).toContain('接入 MCP Server，扩展 AI 可用的工具');
    expect(app).toContain('按 cron 周期自动执行的运维任务');
    expect(app).toContain('隔离的代码 / 命令执行环境');
    expect(app).toContain('模型与运行时配置');
    expect(app).toContain('管理本地与导入的 Skill，供 AI 调用');
    // 标题与描述同一行（横向基线对齐）
    expect(css).toContain('.page-subtitle');
    expect(css).toContain('.page-heading');
    expect(css).toContain('flex-direction: row');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('.page-title h1,\n  .skills-page-header h1 {\n    font-size: 18px');
  });

  it('keeps non-chat pages full-screen with a fixed shell and internal scrolling', async () => {
    const css = await readFile('web/src/index.css', 'utf8');

    expect(css).toContain('.management-page {\n    height: 100vh;');
    expect(css).toContain('overflow: hidden;');
    expect(css).toContain('.management-main-content {\n    width: 100%;\n    height: 100%;');
    expect(css).toContain('.management-main-content .main-shell {\n    flex: 1 1 auto;');
    expect(css).toContain('.management-main-content .content-shell {\n    width: 100%;\n    height: 100vh;\n    overflow: auto;');
  });

  it('keeps chat panel toggles only in the header controls', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('PrototypeChatHeader');
    expect(app).toContain('onToggleHistory={props.onToggleHistory}');
    expect(app).toContain('onTogglePreview={props.onTogglePreview}');
    expect(app).not.toContain('prototype-collapsed-left');
    expect(app).not.toContain('prototype-collapsed-right');
    expect(app).not.toContain('aria-label="展开最近会话"');
    expect(app).not.toContain('aria-label="展开当前沙箱"');
    expect(css).not.toContain('.prototype-collapsed-panel');
  });

  it('wires MCP test calls to the generic tool-call API', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain("api.post<ToolCallBody>('/v1/tools/call");
    expect(app).toContain('testMcpTool');
    expect(app).toContain('tool-test-args');
    expect(app).toContain('toolTestOutput');
  });

  it('does not show fallback MCP tools when the backend has none registered', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain("activePage === 'mcp' && <McpPage tools={mcpTools}");
    expect(app).not.toContain("fallbackTools.filter((tool) => tool.category === 'mcp')");
    expect(app).toContain('const hasTools = selected.tools.length > 0');
    expect(app).toContain('selected.tools.some((item) => item.name === tool)');
    expect(app).toContain('暂无已连接的 MCP 工具');
    expect(app).toContain('disabled={!hasTools}');
  });
});

describe('frontend data APIs', () => {
  it('serves frontend assets from the backend server for local use', async () => {
    await mkdir('web/dist/assets', { recursive: true });
    await writeFile('web/dist/index.html', '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
    await writeFile('web/dist/assets/app.js', 'console.log("AIOP React asset placeholder");');

    const store = new MemoryStore();
    await store.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store, secret: 'static-secret' });
    const rt = {
      model: {
        id: 'static-model',
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: 'stop', reason: 'end_turn' };
        },
      },
      tools: new ToolRegistry(),
      store,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'static-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const server = createHttpServer(rt);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const html = await fetch(`${base}/`);
      expect(html.status).toBe(200);
      expect(html.headers.get('content-type')).toContain('text/html');
      expect(await html.text()).toContain('id="root"');

      const js = await fetch(`${base}/assets/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toContain('text/javascript');
      expect(await js.text()).toContain('AIOP React asset placeholder');

      const favicon = await fetch(`${base}/favicon.ico`);
      expect(favicon.status).toBe(204);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serves sessions, tools, schedule, and sandbox data for the UI', async () => {
    const store = new MemoryStore();
    await store.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store, secret: 'ui-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const token = (await auth.login('default', 'admin', 'pw'))!;
    const ctx = { tenantId: 'default', userId: 'u1', role: 'platform_admin' as const };
    await store.appendMessage(ctx, 'sess-a', { role: 'user', text: '检查 Pod 异常' });
    await store.appendMessage(ctx, 'sess-a', { role: 'assistant', text: '发现 OOMKilled' });
    await store.createScheduledTask(ctx, {
      sessionId: 'sess-a',
      cron: '0 2 * * *',
      task: '每日巡检 aiop 命名空间',
      enabled: true,
    });
    await store.recordTaskRun({
      taskId: 1,
      status: 'success',
      detail: '巡检完成：所有 Pod 正常',
      steps: 3,
    });

    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'load_skill', description: '加载技能', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });
    tools.register({
      def: { name: 'mcp__filesystem__read_file', description: '读取文件', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });
    tools.register({
      def: { name: 'sbx__run_command', description: '执行命令', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });

    const model: ChatModel = {
      id: 'ui-model',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const rt = {
      model,
      tools,
      store,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'ui-secret',
      systemExtra: '',
      modelConfig: {
        id: 'ui',
        protocol: 'anthropic',
        baseURL: 'http://localhost:8000/v1',
        apiKey: 'ui-key',
        model: 'ui-model',
      },
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const server = createHttpServer(rt);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const authed = { authorization: `Bearer ${token}` };

    try {
      const sessions = await getJson<{ sessions: Array<{ sessionId: string; title: string; messageCount: number }> }>(
        `${base}/v1/sessions`,
        authed,
      );
      expect(sessions.sessions).toEqual([
        expect.objectContaining({ sessionId: 'sess-a', title: '检查 Pod 异常', messageCount: 2 }),
      ]);

      const toolsBody = await getJson<{ tools: Array<{ name: string; category: string }>; groups: Record<string, number> }>(
        `${base}/v1/tools`,
        authed,
      );
      expect(toolsBody.groups).toMatchObject({ skill: 1, mcp: 1, sandbox: 1 });
      expect(toolsBody.tools.map((t) => t.name)).toContain('mcp__filesystem__read_file');

      const schedule = await getJson<{ tasks: Array<{ id: number }> }>(`${base}/v1/schedule`, authed);
      expect(schedule.tasks).toHaveLength(1);

      const runs = await getJson<{ runs: Array<{ id: number; taskId: number; status: string; detail: string; steps: number; createdAt: string }> }>(
        `${base}/v1/schedule/${schedule.tasks[0]!.id}/runs`,
        authed,
      );
      expect(runs.runs).toEqual([
        expect.objectContaining({
          id: 1,
          taskId: schedule.tasks[0]!.id,
          status: 'success',
          detail: '巡检完成：所有 Pod 正常',
          steps: 3,
        }),
      ]);
      expect(new Date(runs.runs[0]!.createdAt).getTime()).not.toBeNaN();

      const sandboxes = await getJson<{ sandboxes: Array<{ id: string; status: string; actions: string[] }> }>(
        `${base}/v1/sandboxes`,
        authed,
      );
      expect(sandboxes.sandboxes).toEqual([]);

      const settings = await getJson<{ config: { protocol: string; base_url: string; model: string; api_key_set: boolean } }>(
        `${base}/v1/settings/llm`,
        authed,
      );
      expect(settings.config).toMatchObject({
        protocol: 'anthropic',
        base_url: 'http://localhost:8000/v1',
        model: 'ui-model',
        api_key: 'ui-key',
        api_key_set: true,
      });
    } finally {
      await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    }
  });
});

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

describe('kubernetes frontend deployment', () => {
  it('runs frontend and backend containers in the same server pod', async () => {
    const deployment = await readFile('deploy/k8s/deployment-server.yaml', 'utf8');

    expect(deployment).toMatch(/name:\s+aiop-web/);
    expect(deployment).toMatch(/image:\s+aiop-web:latest/);
    expect(deployment).toMatch(/name:\s+aiop\s*\n\s+image:\s+aiop:latest/);
    expect(deployment).toMatch(/name:\s+PORT\s*\n\s+value:\s+"8081"/);
    expect(deployment).toContain('containerPort: 8080');
    expect(deployment).toContain('containerPort: 8081');
  });

  it('keeps the Kubernetes Service pointed at the frontend container', async () => {
    const service = await readFile('deploy/k8s/service.yaml', 'utf8');

    expect(service).toMatch(/port:\s+80/);
    expect(service).toMatch(/targetPort:\s+8080/);
  });

  it('applies the same sidecar layout to the dev deployment', async () => {
    const deployment = await readFile('deploy/dev-k8s/aiop-deployment.yaml', 'utf8');

    expect(deployment).toMatch(/name:\s+aiop-web/);
    expect(deployment).toMatch(/image:\s+aiop-web:dev/);
    expect(deployment).toMatch(/name:\s+PORT\s*\n\s+value:\s+"8081"/);
    expect(deployment).toContain('containerPort: 8080');
    expect(deployment).toContain('containerPort: 8081');
  });
});
