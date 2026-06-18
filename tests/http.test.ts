import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/server/http.js';
import { MemoryStore } from '../src/db/memory.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { ChatModel, StreamEvent } from '../src/model/types.js';

/** 纯文本回答的 mock 模型（不发起工具调用）。 */
const model: ChatModel = {
  id: 'mock',
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', text: 'hello' };
    yield { type: 'stop', reason: 'end_turn' };
  },
};

let server: Server;
let base: string;
let store: MemoryStore;
let token: string;

beforeAll(async () => {
  store = new MemoryStore();
  await store.createTenant({ id: 'default', name: 'Default' });
  const auth = new LocalAuthProvider({ store, secret: 'test-secret' });
  await auth.createUser('default', 'admin', 'pw', 'platform_admin');

  const rt = {
    model,
    tools: new ToolRegistry(),
    store,
    policy: new AllowAllPolicy(),
    policyPreApproved: new AllowAllPolicy(),
    authProvider: auth,
    jwtSecret: 'test-secret',
    systemExtra: '',
    defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
  } as unknown as Runtime;

  server = createHttpServer(rt);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('HTTP server', () => {
  it('healthz is open', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('login returns a token', async () => {
    const r = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'default', username: 'admin', password: 'pw' }),
    });
    expect(r.status).toBe(200);
    token = ((await r.json()) as { token: string }).token;
    expect(token).toBeTruthy();
  });

  it('rejects bad credentials', async () => {
    const r = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'default', username: 'admin', password: 'wrong' }),
    });
    expect(r.status).toBe(401);
  });

  it('rejects unauthenticated agent run', async () => {
    const r = await fetch(`${base}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'hi' }),
    });
    expect(r.status).toBe(401);
  });

  it('runs an agent over SSE and persists the session', async () => {
    const r = await fetch(`${base}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'hi', sessionId: 'sess-1' }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const body = await r.text();
    expect(body).toContain('event: text_delta');
    expect(body).toContain('event: done');

    // 消息已落库（user + assistant）
    const ctx = { tenantId: 'default', userId: 'admin', role: 'platform_admin' as const };
    const msgs = await store.listMessages(ctx, 'sess-1');
    expect(msgs.map((m) => m.role)).toContain('assistant');
  });

  it('continues a session (history is loaded)', async () => {
    await fetch(`${base}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'again', sessionId: 'sess-1' }),
    }).then((r) => r.text());
    const ctx = { tenantId: 'default', userId: 'admin', role: 'platform_admin' as const };
    const msgs = await store.listMessages(ctx, 'sess-1');
    // 两轮：user/assistant ×2
    expect(msgs.filter((m) => m.role === 'user').length).toBe(2);
  });

  it('admin can list tenants; unknown route 404s', async () => {
    const r = await fetch(`${base}/v1/admin/tenants`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { tenants: unknown[] }).tenants.length).toBeGreaterThan(0);

    const nf = await fetch(`${base}/nope`);
    expect(nf.status).toBe(404);
  });

  it('pauses an SSE agent run for approval and resumes after approve', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'approval-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    await auth.createUser('default', 'user', 'pw', 'user');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const userToken = (await auth.login('default', 'user', 'pw'))!;

    const run = vi.fn(async () => ({ id: '', content: 'approved tool result' }));
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'act', description: 'act', inputSchema: { type: 'object' } },
      run,
    });

    let turn = 0;
    const approvalModel: ChatModel = {
      id: 'approval-model',
      async *stream(): AsyncIterable<StreamEvent> {
        turn++;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: 'c1', name: 'act', args: {} } };
          yield { type: 'stop', reason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'finished after approval' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };

    const rt = {
      model: approvalModel,
      tools,
      store: localStore,
      policy: { check: async () => ({ blocked: false, needApproval: true, reason: 'prod write' }) },
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'approval-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const approvalServer = createHttpServer(rt);
    await new Promise<void>((resolve) => approvalServer.listen(0, '127.0.0.1', resolve));
    const approvalBase = `http://127.0.0.1:${(approvalServer.address() as AddressInfo).port}`;

    try {
      const r = await fetch(`${approvalBase}/v1/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ task: 'needs approval', sessionId: 'approval-sess' }),
      });
      expect(r.status).toBe(200);
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let stream = '';
      let approvalId = '';

      while (!approvalId) {
        const next = await reader.read();
        expect(next.done).toBe(false);
        stream += decoder.decode(next.value, { stream: true });
        const m = /event: approval_required\ndata: ([^\n]+)/.exec(stream);
        if (m) approvalId = (JSON.parse(m[1]!) as { id: string }).id;
      }

      expect(run).not.toHaveBeenCalled();
      const deniedByRbac = await fetch(`${approvalBase}/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(deniedByRbac.status).toBe(403);

      const approved = await fetch(`${approvalBase}/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(approved.status).toBe(200);

      while (!stream.includes('event: done')) {
        const next = await reader.read();
        if (next.done) break;
        stream += decoder.decode(next.value, { stream: true });
      }

      expect(run).toHaveBeenCalledOnce();
      expect(stream).toContain('event: done');
      expect(stream).toContain('finished after approval');
    } finally {
      await new Promise<void>((resolve) => approvalServer.close(() => resolve()));
    }
  });
});
