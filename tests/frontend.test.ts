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

    expect(app).toContain('api.get<SessionsBody>(`/v1/sessions?limit=${SESSION_PAGE_SIZE}&offset=${offset}`');
    expect(app).toContain("api.get<ToolsBody>('/v1/tools");
    expect(app).toContain("api.get<ScheduleBody>('/v1/schedule");
    expect(app).toContain('api.get<ScheduleRunsBody>(`/v1/schedule/${selectedTask.id}/runs`)');
    expect(app).toContain("api.get<SandboxesBody>('/v1/sandboxes");
    expect(app).toContain('setSandboxProfiles(body.profiles || [])');
    expect(app).toContain("api.get<ModelSettingsBody>('/v1/settings/llm");
  });

  it('lets operators select scheduled tasks and inspect retained run results', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');

    expect(types).toContain('export interface TaskRun');
    expect(types).toContain('export interface ScheduleRunsBody');
    expect(app).toContain('useState<TaskRun[]>([])');
    expect(app).toContain('<SchedulePage tasks={tasks} api={api} onChanged={() => void loadPageData(\'schedule\')} onRequestConfirm={requestConfirmDialog} />');
    expect(app).toContain('selectedTaskId');
    expect(app).toContain('selectedRunId');
    expect(app).toContain('setSelectedTaskId(task.id)');
    expect(app).toContain('setSelectedRunId(run.id)');
    expect(app).toContain('className="schedule-task-cell"');
    expect(app).toContain('<TabsTrigger value="runs">执行记录</TabsTrigger>');
    expect(app).toContain('title="执行记录详情"');
    expect(app).toContain('执行结果');
    expect(css).toContain('.schedule-task-cell');
    expect(css).toContain('.schedule-detail-tabs');
    expect(css).toContain('.schedule-run-modal');
  });

  it('keeps the chat browser area as preview-only UI', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain("api.post<ToolCallBody>('/v1/sandbox/run-code");
    expect(app).toContain("name.startsWith('sandbox_')");
    expect(app).toContain("api.post<ToolCallBody>('/v1/browser/stream");
    expect(app).toContain("api.post<ToolCallBody>('/v1/browser/screenshot");
    expect(app).toContain('runSandboxCode');
    expect(app).toContain('openBrowserStream');
    expect(app).toContain('浏览器预览');
    expect(app).toContain("useState<'terminal' | 'browser'>('terminal')");
    expect(app).not.toContain("{ key: 'vnc'");
    expect(app).not.toContain('VNC 桌面预览');
    expect(app).not.toContain('vnc-preview-frame');
    expect(app).not.toContain("api.post('/v1/browser/navigate");
    expect(app).not.toContain("api.post('/v1/browser/click");
    expect(app).not.toContain("api.post('/v1/browser/type");
    expect(app).not.toContain('browserNavigate');
    expect(app).not.toContain('browserClick');
    expect(app).not.toContain('browserType');
    expect(app).not.toContain('id="browser-control-form"');
  });

  it('uses viewport-adaptive browser preview heights in chat panels', async () => {
    const css = await readFile('web/src/index.css', 'utf8');

    const prototypeFrameRule = css.match(/\.prototype-browser-card iframe\s*\{[\s\S]*?\n  \}/)?.[0] || '';
    const prototypeEmptyRule = css.match(/\.prototype-empty-preview\s*\{[\s\S]*?\n  \}/)?.[0] || '';
    const legacyFrameRule = css.match(/\.browser-preview-frame\s*\{[\s\S]*?\n  \}/)?.[0] || '';
    const legacyEmptyRule = css.match(/\.preview-empty\s*\{[\s\S]*?\n  \}/)?.[0] || '';

    expect(prototypeFrameRule).toContain('height: clamp(420px, calc(100vh - 260px), 760px);');
    expect(prototypeEmptyRule).toContain('min-height: clamp(360px, calc(100vh - 360px), 620px);');
    expect(legacyFrameRule).toContain('height: clamp(420px, calc(100vh - 260px), 760px);');
    expect(legacyEmptyRule).toContain('min-height: clamp(360px, calc(100vh - 360px), 620px);');
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
    expect(app).toContain('prototype-session-id');
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
    expect(css).toContain('.browser-preview-panel');
    // AIOS 设计系统（ui-design/）：主色 #5882FC、扁平工作台、50px 模块栏、Element 风格表格，无渐变/玻璃模糊装饰
    expect(css).toContain('--primary: 225 96% 67%');
    expect(css).toContain('--background: 218 40% 96%');
    expect(css).toContain('grid-template-columns: 50px minmax(0, 1fr)');
    expect(css).toContain('.aios-table');
    expect(css).toContain('background: #f1f5fe');
    expect(css).toContain('SimSun');
    expect(css).not.toContain('linear-gradient');
    expect(css).not.toContain('backdrop-filter');
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
    expect(app).toContain('onClick={activate}');
    expect(app).toContain('onSelect(session);');
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
    expect(app).toContain('requestDeleteSessions');
    expect(app).toContain('requestDeleteSelectedSkill');
    expect(app).toContain("confirmLabel: '确认删除'");
    expect(app).toContain('onRequestConfirm={requestConfirmDialog}');
    expect(app).toContain('title: `删除选中的 ${targets.length} 条会话？`');
    expect(app).toContain('删除后，这些会话记录和历史消息将从列表中移除。');
    expect(app).toContain('此操作不可恢复，请确认不再需要这些会话记录。');
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

  it('isolates terminal output by session and clears deleted session caches', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain('SessionTerminalCache');
    expect(app).toContain('const [terminalCache, setTerminalCache] = useState<SessionTerminalCache>({})');
    expect(app).toContain('sessionTerminalOutput(terminalCache, sessionId)');
    expect(app).toContain('appendTerminalOutput(activeSessionId, chunk)');
    expect(app).toContain('replaceTerminalOutput(targetSessionId');
    expect(app).toContain('removeSessionTerminals(current, deletedIds)');
    expect(app).toContain('touchSessionTerminal(current, nextSessionId)');
    expect(app).not.toContain("const [sandboxOutput, setSandboxOutput] = useState('')");
  });

  it('supports paginated and deletable session history without blocking chat input during runs', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');

    expect(app).toContain('SESSION_PAGE_SIZE');
    expect(app).toContain('sessionOffset');
    expect(app).toContain('sessionTotal');
    expect(app).toContain("`/v1/sessions?limit=${SESSION_PAGE_SIZE}&offset=${offset}`");
    expect(app).toContain('const SESSION_PAGE_SIZE = 8;');
    expect(app).toContain('goToPrevSessionsPage');
    expect(app).toContain('goToNextSessionsPage');
    expect(app).toContain('上一页');
    expect(app).toContain('下一页');
    expect(app).toContain('ID: {session.sessionId}');
    expect(app).toContain('全选');
    expect(app).toContain('onDeleteMany');
    expect(app).toContain('deleteSessions');
    expect(app).toContain('api.delete<{ ok: boolean }>(`/v1/sessions/${encodeURIComponent(id)}`');
    expect(app).toContain('onDeleteSessions');
    expect(app).toContain('event.stopPropagation()');
    expect(app).toContain('批量删除');
    expect(app).not.toContain('prototype-session-delete');
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

  it('uses immediate sessions, active append, and context usage in chat runtime UI', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');
    const data = await readFile('web/src/app-data.ts', 'utf8');

    expect(types).toContain('export interface ContextUsageBody');
    expect(types).toContain('context_window_tokens: number;');
    expect(data).toContain('context_window_tokens: 200000');
    expect(app).toContain('useState<Record<string, ContextUsageBody>>');
    expect(app).toContain('activeRunSessionIds');
    expect(app).toContain("api.post<{ session: SessionsBody['sessions'][number] }>('/v1/sessions'");
    expect(app).toContain('await fetchSessionsPage(0);');
    expect(app).toContain('api.get<ContextUsageBody>(`/v1/sessions/${encodeURIComponent(nextSessionId)}/context`)');
    expect(app).toContain('api.post<{ ok: boolean; sessionId: string; queued: boolean }>(`/v1/sessions/${encodeURIComponent(sessionId)}/append`');
    expect(app).toContain('activeRunSessionIds.has(sessionId)');
    expect(app).toContain('event.data?.context');
    expect(app).toContain('event.data?.usage?.context');
    expect(app).toContain('formatTokenCount');
  });

  it('shows current session cumulative token usage and elapsed run time in the smart assistant header', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');

    expect(types).toContain('export interface SessionTokenUsageBody');
    expect(types).toContain('totalTokens: number;');
    expect(app).toContain('useState<Record<string, number>>({})');
    expect(app).toContain('runStartedAt');
    expect(app).toContain('formatElapsedTime');
    expect(app).toContain('api.get<SessionTokenUsageBody>(`/v1/sessions/${encodeURIComponent(nextSessionId)}/usage`)');
    expect(app).toContain("event?.event === 'usage'");
    expect(app).toContain('event.data?.inputTokens');
    expect(app).toContain('event.data?.outputTokens');
    expect(app).toContain('<h1>智能助手</h1>');
    expect(app).toContain('contextUsage={contextUsage[sessionId]}');
    expect(app).toContain('contextUsage?: ContextUsageBody;');
    expect(app).toContain("props.runStartedAt ? '运行中' : '就绪'");
    expect(app).toContain('className="prototype-run-time"');
    expect(app).toContain('{formatElapsedTime(now - props.runStartedAt)}');
    expect(app).toContain('上下文 {formatContextUsage(props.contextUsage)}');
    expect(app).toContain('总消耗</em>');
    expect(app).toContain('formatTokenCount(props.totalTokens)');
    expect(app).toContain('className="prototype-status-mobile"');
    expect(app).not.toContain('累计 Token');
    expect(app).not.toContain('成本 {formatCostUsd(props.sessionCostUsd)}');
  });

  it('uses a compact smart assistant header and controls', async () => {
    const css = await readFile('web/src/index.css', 'utf8');

    expect(css).toMatch(/\.prototype-chat-header\s*\{[\s\S]*?min-height:\s*50px;[\s\S]*?padding:\s*8px 14px;/);
    expect(css).toMatch(/\.prototype-chat-header h1\s*\{[\s\S]*?font-size:\s*16px;/);
    expect(css).toMatch(/\.prototype-chat-actions\s*\{[\s\S]*?gap:\s*6px;/);
    expect(css).toMatch(/\.prototype-chat-actions button\s*\{[\s\S]*?min-width:\s*30px;[\s\S]*?height:\s*30px;/);
    expect(css).toContain('.prototype-chat-actions button svg');
    expect(css).toContain('.prototype-status-mobile');
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.prototype-chat-header span\s*\{[\s\S]*?display:\s*inline-flex;/);
  });

  it('uses smaller regular-weight chat metrics', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('className="prototype-chat-metric"');
    expect(css).toMatch(/\.prototype-chat-header span b\.prototype-chat-metric\s*\{[\s\S]*?font-size:\s*10px;[\s\S]*?font-weight:\s*400;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.prototype-chat-header span b\.prototype-chat-metric\s*\{[\s\S]*?font-size:\s*9px;/);
  });

  it('renders interactive sandbox template cards', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('const [selectedProfileId, setSelectedProfileId]');
    expect(app).toContain('className="sandbox-profile-item"');
    expect(app).toContain('className="sandbox-profile-row"');
    expect(app).toContain('title="沙箱模板详情"');
    expect(app).toContain('onClick={() => setSelectedProfileId(profile.id)}');
    expect(app).not.toContain('className="badge-privileged" variant="destructive"');
    expect(app).toContain('className="badge-privileged" variant="outline"');
    expect(css).toMatch(/\.sandbox-profile-item:hover[\s\S]*?border-color:/);
    expect(css).toMatch(/span\.badge-privileged\s*\{[\s\S]*?background:\s*hsl\(43 92% 94%\);/);
  });

  it('shows image attachment filenames below thumbnails', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('const files = attachments.filter');
    expect(app).toContain('<figure className="attachment-image-card"');
    expect(app).toContain('<figcaption>{file.name}</figcaption>');
    expect(app).toContain('className="attachment-image-remove"');
    expect(app).toContain('{files.map((file) => (');
    expect(css).toMatch(/\.attachment-image-card figcaption\s*\{[\s\S]*?font-size:\s*11px;/);
  });

  it('shares scheduled task create and edit form layout', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('function ScheduleTaskForm(');
    expect(app.match(/<ScheduleTaskForm/g)).toHaveLength(2);
    expect(app).toContain('const [editPreApproved, setEditPreApproved]');
    expect(app).toContain('preApproved: editPreApproved');
    expect(app).toContain('className="schedule-preapproved"');
    expect(css).toMatch(/\.schedule-preapproved\s*\{[\s\S]*?width:\s*100%;[\s\S]*?white-space:\s*normal;/);
    expect(css).toMatch(/\.schedule-preapproved input\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  });

  it('uses task detail and execution record tabs', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('<TabsTrigger value="task">任务详情</TabsTrigger>');
    expect(app).toContain('<TabsTrigger value="runs">执行记录</TabsTrigger>');
    expect(app).toContain('<TabsContent value="task">');
    expect(app).toContain('<TabsContent value="runs">');
    expect(app).toContain('title="执行记录详情"');
    expect(app).toContain('onClose={() => setSelectedRunId(undefined)}');
    expect(app).not.toContain('className="schedule-run-detail"');
    expect(css).toMatch(/\.schedule-run-modal pre\s*\{[\s\S]*?max-height:/);
  });

  it('aligns the sandbox enable checkbox with its label', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('className="settings-checkbox-row"');
    expect(app).toContain('<span>启用沙箱能力</span>');
    expect(css).toMatch(/\.settings-form label\.settings-checkbox-row\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;/);
    expect(css).toMatch(/\.settings-checkbox-row input\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;/);
  });

  it('shows state-aware sidebar toggle help', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain('historyOpen={props.historyOpen}');
    expect(app).toContain('previewOpen={props.previewOpen}');
    expect(app).toContain("const historyToggleLabel = props.historyOpen ? '收起左侧会话栏' : '展开左侧会话栏';");
    expect(app).toContain("const previewToggleLabel = props.previewOpen ? '收起右侧沙箱栏' : '展开右侧沙箱栏';");
    expect(app).toContain('aria-label={historyToggleLabel}');
    expect(app).toContain('aria-label={previewToggleLabel}');
    expect(app).toContain('<TooltipContent side="bottom">{historyToggleLabel}</TooltipContent>');
    expect(app).toContain('<TooltipContent side="bottom">{previewToggleLabel}</TooltipContent>');
  });

  it('preserves running chat state when returning to an active session', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain('useState<Record<string, ChatMessage[]>>({})');
    expect(app).toContain('const sessionIdRef = useRef(sessionId)');
    expect(app).toContain('const messagesRef = useRef(messages)');
    expect(app).toContain('function showSessionMessages(nextSessionId: string, nextMessages: ChatMessage[])');
    expect(app).toContain('function updateSessionMessages(targetSessionId: string, updater: (current: ChatMessage[]) => ChatMessage[])');
    expect(app).toContain('const cachedMessages = sessionMessageCache[session.sessionId]');
    expect(app).toContain('activeRunSessionIds.has(session.sessionId) && cachedMessages?.length');
    expect(app).toContain('showSessionMessages(session.sessionId, cachedMessages)');
    expect(app).toContain('updateSessionMessages(requestSessionId, (current) => [...current, assistant])');
    expect(app).toContain('updateSessionMessages(activeSessionId, (current) => current.map((message) => (message.id === assistantId ? { ...assistant } : message)))');
  });

  it('does not show sample sessions when the backend returns an empty history list', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');
    const api = await readFile('web/src/api.ts', 'utf8');

    expect(app).toContain('useState<SessionSummary[]>([])');
    expect(app).not.toContain('useState<SessionSummary[]>(fallbackSessions)');
    expect(app).not.toContain('(sessions.length ? sessions : fallbackSessions)');
    expect(api).toContain('export function numericSessionId()');
    expect(api).toContain('Date.now() * 1000');
    expect(app).toContain("readStorage('aiop_session_id') || numericSessionId()");
    expect(app).toContain('const id = numericSessionId();');
    expect(app).toContain('prototype-session-empty');
    expect(app).toContain('暂无会话记录');
    expect(css).toContain('.prototype-session-empty');
    expect(css).toContain('.session-empty');
  });

  it('shows sandbox profiles and live sandbox-session bindings without fallback rows', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');

    const sandboxProfileType = types.match(/export interface SandboxProfileSummary \{[\s\S]*?\n\}/)?.[0] || '';
    expect(sandboxProfileType).toContain('id: string;');
    expect(sandboxProfileType).toContain('template?: string;');
    expect(sandboxProfileType).toContain("envType: 'code' | 'browser';");
    expect(sandboxProfileType).toContain("runtimeRole: 'sandbox-reader' | 'sandbox-diag';");
    expect(types).toContain('profiles?: SandboxProfileSummary[]');
    expect(types).toContain('profile?: string;');
    expect(types).toContain('capabilities?: string[];');
    expect(app).toContain('const [sandboxProfiles, setSandboxProfiles] = useState<SandboxProfileSummary[]>([])');
    expect(app).toContain('<SandboxPage sandboxes={sandboxes} profiles={sandboxProfiles} />');
    expect(app).not.toContain('sandboxes.length ? sandboxes : fallbackSandboxes');
    expect(app).toContain('支持的沙箱模板');
    expect(app).toContain('AI 会按任务能力选择 profile');
    expect(app).toContain('key={profile.id}');
    expect(app).toContain('profile.template');
    expect(app).toContain('profile.envType');
    expect(app).toContain('profile.runtimeRole');
    expect(app).toContain('特权诊断');
    expect(app).toContain("headers={['沙箱 ID', '状态', 'Profile', '镜像/模板', '绑定会话', 'Key', '活跃时间']}");
    expect(app).toContain('sandbox.sessionId ||');
    expect(app).toContain('const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(null)');
    expect(app).toContain('selectedRowIndex={selectedIndex >= 0 ? selectedIndex : null}');
    expect(app).toContain('onRowClick={(rowIndex) => setSelectedSandboxId(sandboxes[rowIndex]?.id ?? null)}');
    expect(app).toContain('<ModalDialog title={selected.id} status={selected.status} icon={<Cuboid />}');
    expect(app).toContain('当前没有运行中的沙箱。');
    expect(app).not.toContain('选择沙箱查看详情');
    expect(app).not.toContain('暂无运行中沙箱');
    expect(app).toContain('onKeyDown={onRowClick ? (event) =>');
    expect(css).toContain('.sandbox-profile-grid');
    expect(css).toContain('.sandbox-profile-item');
    expect(css).toContain('.clickable-row');
    expect(css).toContain('.sandbox-detail-card');
    expect(css).toContain('.two-pane > .list-card');
    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('.prototype-session-id');
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

  it('shows live and final assistant execution duration beside the message time', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(types).toContain('startedAt?: number;');
    expect(types).toContain('durationMs?: number;');
    expect(app).toContain('function MessageMeta({ message }: { message: ChatMessage })');
    expect(app).toContain('message.running && message.startedAt');
    expect(app).toContain('message.durationMs');
    expect(app).toContain("assistant.durationMs = Math.max(0, Date.now() - startedAt);");
    expect(app).toContain('<MessageMeta message={message} />');
    expect(css).toContain('.prototype-message-meta');
    expect(css).toContain('.prototype-message-duration');
  });

  it('uses the AIOS light-primary surface for user message bubbles', async () => {
    const css = await readFile('web/src/index.css', 'utf8');

    expect(css).toMatch(/\.prototype-message\.user \.prototype-bubble\s*\{[\s\S]*?background:\s*rgba\(88, 130, 252, \.1\);/);
    expect(css).toMatch(/\.message-user \.bubble\s*\{[\s\S]*?background:\s*rgba\(88, 130, 252, \.1\);/);
  });

  it('keeps sandbox template fields regular-weight while preserving bold card titles', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('className="sandbox-profile-title"');
    expect(app).toContain('className="sandbox-profile-value"');
    expect(app).not.toContain('<Badge className="badge-privileged" variant="outline"><strong>特权诊断</strong></Badge>');
    expect(css).toMatch(/\.sandbox-profile-title\s*\{[\s\S]*?font-weight:\s*700;/);
    expect(css).toMatch(/\.sandbox-profile-value,[\s\S]*?\.sandbox-profile-detail \.kv span\s*\{[\s\S]*?font-weight:\s*400;/);
  });

  it('lets the skill search wrapper exclusively own border and focus styling', async () => {
    const css = await readFile('web/src/index.css', 'utf8');

    expect(css).toMatch(/\.skill-search-box:focus-within\s*\{[\s\S]*?border-color:\s*hsl\(var\(--primary\)\);[\s\S]*?box-shadow:\s*0 0 0 2px var\(--focus-ring\);/);
    expect(css).toMatch(/\.skill-search-box input,[\s\S]*?\.skill-search-box input:focus-visible\s*\{[\s\S]*?border:\s*0;[\s\S]*?outline:\s*0;[\s\S]*?box-shadow:\s*none;/);
  });

  it('removes the inactive chat code-mode placeholder button', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).not.toContain('aria-label="代码模式"');
    expect(css).not.toContain('.prototype-input-box button[aria-label="代码模式"]');
  });

  it('lets the management search wrapper exclusively own MCP focus styling', async () => {
    const css = await readFile('web/src/index.css', 'utf8');

    expect(css).toMatch(/\.management-page \.search-box:focus-within\s*\{[\s\S]*?border-color:\s*hsl\(var\(--primary\)\);[\s\S]*?box-shadow:\s*0 0 0 2px var\(--focus-ring\);/);
    expect(css).toMatch(/\.management-page \.search-box input,[\s\S]*?\.management-page \.search-box input:focus-visible\s*\{[\s\S]*?border:\s*0;[\s\S]*?outline:\s*0;[\s\S]*?box-shadow:\s*none;/);
  });

  it('shows the current session sandbox identity with ready or unbound status', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('const currentSandbox = sandboxes.find((sandbox) => sandbox.sessionId === sessionId);');
    expect(app).toContain('currentSandbox={currentSandbox}');
    expect(app).toContain("props.currentSandbox ? props.currentSandbox.id : '未绑定'");
    expect(app).toContain("props.currentSandbox ? 'ready' : 'muted'");
    expect(app).not.toContain('sandbox-prod · ready');
    expect(css).toContain('.prototype-sandbox-identity');
    expect(css).toContain('.prototype-sandbox-indicator.muted');
  });

  it('uses one blue tooltip system for navigation and icon-only controls', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const tooltip = await readFile('web/src/components/ui/tooltip.tsx', 'utf8');

    expect(app).toContain('function IconTooltip({ label, children }');
    expect(app).toContain('<IconTooltip label="添加附件">');
    expect(app).toContain('<IconTooltip label="发送消息">');
    expect(app).toContain('<IconTooltip label="收起当前沙箱">');
    expect(app).toContain('<IconTooltip label="关闭">');
    expect(app).not.toContain('className={cn(\'prototype-nav-btn\', item.id === page && \'active\')}\n                title={item.label}');
    expect(tooltip).toContain('bg-primary text-primary-foreground');
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
    expect(app).toContain('模型、沙箱与定时任务配置');
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
    expect(app).toContain('const hasTools = selectedTools.length > 0');
    expect(app).toContain('selectedTools.includes(testToolName)');
    expect(app).toContain('暂无已连接的 MCP 工具');
    expect(app).toContain('disabled={!hasTools}');
  });

  it('configures all sandbox modes without exposing persisted keys', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const types = await readFile('web/src/types.ts', 'utf8');

    expect(types).toContain("export type SandboxSettingsMode = 'standard_e2b' | 'aios_lifecycle' | 'opensandbox' | 'local'");
    const sandboxSettingsType = types.match(/export interface SandboxSettingsInfo \{[\s\S]*?\n\}/)?.[0] || '';
    const sandboxSettingsBodyType = types.match(/export interface SandboxSettingsBody \{[\s\S]*?\n\}/)?.[0] || '';
    expect(sandboxSettingsType).toContain('api_key_set: boolean;');
    expect(sandboxSettingsType).not.toContain('api_key_preview');
    expect(sandboxSettingsBodyType).toContain("status?: 'disabled' | 'active' | 'catalog_unavailable' | 'refreshing' | string;");
    expect(sandboxSettingsBodyType).toContain('template_count?: number;');
    expect(sandboxSettingsBodyType).toContain('last_successful_refresh_at?: string;');
    expect(app).toContain("api.get<SandboxSettingsBody>('/v1/settings/sandbox')");
    expect(app).toContain("api.post<SandboxSettingsBody>('/v1/settings/sandbox'");
    expect(app).toContain('<SelectItem value="standard_e2b">标准 E2B</SelectItem>');
    expect(app).toContain('<SelectItem value="aios_lifecycle">AIOS Lifecycle</SelectItem>');
    expect(app).toContain('<SelectItem value="opensandbox">OpenSandbox（k8s）</SelectItem>');
    expect(app).toContain('<SelectItem value="local">Local（本地开发）</SelectItem>');
    expect(app).toContain('Lifecycle URL');
    expect(app).toContain('Cluster ID');
    expect(app).toContain('Namespace');
    expect(app).toContain('模板由 AIOS 目录动态加载；browser 模板接入现有截图预览，sandbox-diag 仅平台管理员可见可用。');
    expect(app).not.toContain('固定使用 code-interpreter');
    expect(app).toContain('template_count');
    expect(app).toContain('last_successful_refresh_at');
    expect(app).toContain('catalog_unavailable');
    expect(app).toContain("'/v1/settings/sandbox/refresh-templates'");
    expect(app).toContain('刷新模板');
    expect(app).toContain('refreshBusy');
    expect(app).toContain('refreshBusyRef.current');
    expect(app).toContain('type="password"');
    expect(app).toContain('autoComplete="new-password"');
    expect(app).toContain("info?.api_key_set ? '已配置' : '未配置'");
    expect(app).not.toContain('api_key_preview');
  });

  it('requires explicit confirmation before clearing a sandbox key', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain('requestClearApiKey');
    expect(app).toContain("title: '清除沙箱 API Key？'");
    expect(app).toContain("confirmLabel: '确认清除'");
    expect(app).toContain('clear_api_key: true');
    expect(app).toContain('function sandboxClearPayload(form: SandboxSettingsForm)');
    expect(app).toContain('const { api_key: _apiKey, ...payload } = sandboxSettingsPayload(form);');
    expect(app).toContain('onRequestConfirm={requestConfirmDialog}');
    expect(app).toContain('disabled={busy || !info}');
  });

  it('guards platform sandbox credentials when the binding target changes', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');

    expect(app).toContain("const isPlatformAdmin = me?.role === 'platform_admin'");
    expect(app).toContain('{isPlatformAdmin ? <TabsTrigger value="sandbox">沙箱</TabsTrigger> : null}');
    expect(app).toContain('sandboxCredentialTarget');
    expect(app).toContain('凭据目标已变更，请重新输入 API Key 或先明确清除旧 Key');
    expect(app).toContain('sandboxClearPayload(form)');
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
    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
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

      const sandboxes = await getJson<{ sandboxes: Array<{ id: string; status: string; actions: string[] }>; profiles: unknown[] }>(
        `${base}/v1/sandboxes`,
        authed,
      );
      expect(sandboxes.sandboxes).toEqual([]);
      expect(sandboxes.profiles).toEqual([]);

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

describe('AIOS design-system first pass', () => {
  it('applies one shared visual contract to navigation, management, chat, login, and mobile surfaces', async () => {
    const app = await readFile('web/src/App.tsx', 'utf8');
    const css = await readFile('web/src/index.css', 'utf8');

    expect(app).toContain('prototype-chat-page management-page');
    expect(app).toContain('className="login-page"');
    expect(css).toContain('/* AIOS first-pass global alignment */');
    expect(css).toContain('--aios-control-height: 32px;');
    expect(css).toContain('--aios-panel-radius: 10px;');
    expect(css).toMatch(/\.prototype-nav-btn\.active\s*\{[\s\S]*?border-left:\s*2px solid hsl\(var\(--primary\)\);/);
    expect(css).toMatch(/\.page-title h1,[\s\S]*?\.skills-page-header h1\s*\{[\s\S]*?color:\s*#606266;/);
    expect(css).toMatch(/\.management-page :is\(\.list-card, \.schedule-list-panel, \.skills-workbench\)\s*\{[\s\S]*?border-radius:\s*var\(--aios-panel-radius\);/);
    expect(css).toMatch(/\.prototype-input-box\s*\{[\s\S]*?border-radius:\s*4px;/);
    expect(css).toMatch(/\.login-card\s*\{[\s\S]*?border-radius:\s*var\(--aios-panel-radius\);/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.management-main-content \.content-shell\s*\{[\s\S]*?padding:\s*16px;/);
  });
});
