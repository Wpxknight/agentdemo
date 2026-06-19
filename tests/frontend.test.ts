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

    expect(NAV_ITEMS.map((item) => item.label)).toEqual(['聊天', '技能', 'MCP', '定时任务', '沙箱环境']);
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
});

describe('frontend data APIs', () => {
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
