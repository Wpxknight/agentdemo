import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/server/http.js';
import { MemoryStore } from '../src/db/memory.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { ChatModel, StreamEvent } from '../src/model/types.js';

async function importWebApp(): Promise<{
  NAV_ITEMS: Array<{ id: string; label: string }>;
  PAGES: Record<string, { hasSandboxWorkspace: boolean; hasSessionHistoryDrawer?: boolean }>;
}> {
  return import(pathToFileURL(path.resolve('web/app.js')).href);
}

describe('frontend shell model', () => {
  it('uses the approved collapsed menu and keeps session history inside chat', async () => {
    const { NAV_ITEMS, PAGES } = await importWebApp();

    expect(NAV_ITEMS.map((item) => item.label)).toEqual(['聊天', '技能', 'MCP', '定时任务', '沙箱环境', '设置']);
    expect(NAV_ITEMS.map((item) => item.label)).not.toContain('会话记录');
    expect(PAGES.chat.hasSessionHistoryDrawer).toBe(true);
  });

  it('shows the sandbox terminal and VNC only on the chat page', async () => {
    const { PAGES } = await importWebApp();

    expect(PAGES.chat.hasSandboxWorkspace).toBe(true);
    expect(PAGES.skills.hasSandboxWorkspace).toBe(false);
    expect(PAGES.mcp.hasSandboxWorkspace).toBe(false);
    expect(PAGES.schedule.hasSandboxWorkspace).toBe(false);
    expect(PAGES.sandbox.hasSandboxWorkspace).toBe(false);
    expect(PAGES.settings.hasSandboxWorkspace).toBe(false);
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
});

describe('frontend API wiring', () => {
  it('loads every menu page from backend endpoints', async () => {
    const app = await readFile('web/app.js', 'utf8');

    expect(app).toContain("apiGet('/v1/sessions");
    expect(app).toContain("apiGet('/v1/tools");
    expect(app).toContain("apiGet('/v1/schedule");
    expect(app).toContain("apiGet('/v1/sandboxes");
    expect(app).toContain("apiGet('/v1/settings/llm");
  });

  it('renders backend-loaded state and refreshes it on page changes', async () => {
    const app = await readFile('web/app.js', 'utf8');

    expect(app).toContain('state.sessions.length ? state.sessions');
    expect(app).not.toContain('${sessions.slice');
    expect(app).toContain("toolsForCategory('skill')");
    expect(app).toContain("toolsForCategory('mcp')");
    expect(app).toContain('state.tasks.length');
    expect(app).toContain('state.sandboxes.length');
    expect(app).toContain('loadPageData(nav)');
    expect(app).toContain('await loadPageData(state.page)');
  });

  it('fully removes collapsed chat side panels so the chat column can expand', async () => {
    const app = await readFile('web/app.js', 'utf8');
    const css = await readFile('web/styles.css', 'utf8');

    expect(app).toContain('history-closed');
    expect(app).toContain('sandbox-closed');
    expect(app).not.toContain('history-collapsed');
    expect(app).not.toContain('sandbox-collapsed');
    expect(css).toContain('.chat-layout.history-closed.sandbox-closed');
  });

  it('keeps the chat page usable on phone-width screens', async () => {
    const css = await readFile('web/styles.css', 'utf8');

    expect(css).toContain('@media (max-width: 760px)');
    expect(css).toContain('.session-drawer { display: none; }');
    expect(css).toContain('.chat-layout { grid-template-columns: minmax(0, 1fr);');
    expect(css).toContain('.app-shell { grid-template-columns: 56px minmax(0, 1fr);');
  });

  it('only shows nav menu tips while hovering, not because a nav item is active', async () => {
    const app = await readFile('web/app.js', 'utf8');
    const css = await readFile('web/styles.css', 'utf8');

    expect(css).toContain('.nav-btn:hover .nav-tip');
    expect(css).toContain('.nav-btn.hide-tip .nav-tip');
    expect(css).not.toContain('.nav-btn.active .nav-tip');
    expect(app).toContain('hiddenNavTip');
    expect(app).toContain("state.hiddenNavTip === item.id ? 'hide-tip' : ''");
    expect(app).toContain('state.hiddenNavTip = nav');
    expect(app).toContain("state.hiddenNavTip = ''");
    expect(app).toContain("document.addEventListener('pointermove'");
  });

  it('wires chat sandbox and browser controls to backend APIs', async () => {
    const app = await readFile('web/app.js', 'utf8');

    expect(app).toContain("apiPost('/v1/sandbox/run-code");
    expect(app).toContain("apiPost('/v1/browser/stream");
    expect(app).toContain("apiPost('/v1/browser/navigate");
    expect(app).toContain("apiPost('/v1/browser/click");
    expect(app).toContain("apiPost('/v1/browser/type");
    expect(app).toContain("apiPost('/v1/browser/screenshot");
    expect(app).toContain("data-action=\"run-sandbox-code\"");
    expect(app).toContain("data-action=\"browser-stream\"");
    expect(app).toContain("data-action=\"browser-navigate\"");
    expect(app).toContain("data-action=\"browser-click\"");
    expect(app).toContain("data-action=\"browser-type\"");
  });

  it('supports composer attachments and enter-key submission ergonomics', async () => {
    const app = await readFile('web/app.js', 'utf8');

    expect(app).toContain('attachments: []');
    expect(app).toContain('type="file"');
    expect(app).toContain('id="attachment-input"');
    expect(app).toContain('data-action="choose-attachment"');
    expect(app).toContain('readFileAsDataUrl');
    expect(app).toContain('attachments: state.attachments');
    expect(app).toContain('handleComposerKeydown');
    expect(app).toContain("event.key !== 'Enter'");
    expect(app).toContain('event.shiftKey');
    expect(app).toContain('event.altKey');
    expect(app).toContain('insertComposerNewline');
    expect(app).toContain("setRangeText('\\n'");
  });

  it('wires Skills and MCP test calls to the generic tool-call API', async () => {
    const app = await readFile('web/app.js', 'utf8');

    expect(app).toContain("apiPost('/v1/tools/call");
    expect(app).toContain("data-action=\"test-skill\"");
    expect(app).toContain("data-action=\"test-mcp\"");
    expect(app).toContain('id="tool-test-args"');
    expect(app).toContain('state.toolTestOutput');
  });
});

describe('frontend data APIs', () => {
  it('serves frontend assets from the backend server for local use', async () => {
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
      expect(await html.text()).toContain('/app.js');

      const js = await fetch(`${base}/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toContain('text/javascript');
      expect(await js.text()).toContain('NAV_ITEMS');

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

      const schedule = await getJson<{ tasks: unknown[] }>(`${base}/v1/schedule`, authed);
      expect(schedule.tasks).toHaveLength(1);

      const sandboxes = await getJson<{ sandboxes: Array<{ id: string; status: string; actions: string[] }> }>(
        `${base}/v1/sandboxes`,
        authed,
      );
      expect(sandboxes.sandboxes).toEqual([
        expect.objectContaining({ id: 'sandbox-prod', status: 'ready', actions: ['打开终端', '打开 VNC', '打开浏览器'] }),
      ]);

      const settings = await getJson<{ config: { protocol: string; base_url: string; model: string; api_key_set: boolean } }>(
        `${base}/v1/settings/llm`,
        authed,
      );
      expect(settings.config).toMatchObject({
        protocol: 'anthropic',
        base_url: 'http://localhost:8000/v1',
        model: 'ui-model',
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
