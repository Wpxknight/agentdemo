import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/server/http.js';
import { MemoryStore } from '../src/db/memory.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { ChatModel, StreamEvent } from '../src/model/types.js';
import { SkillRegistry } from '../src/skill/registry.js';

/** 纯文本回答的 mock 模型（不发起工具调用）。 */
const model: ChatModel = {
  id: 'mock',
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', text: 'hello' };
    yield { type: 'stop', reason: 'end_turn' };
  },
};

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centralParts.reduce((n, part) => n + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

let server: Server;
let base: string;
let store: MemoryStore;
let token: string;

beforeAll(async () => {
  store = new MemoryStore();
  await store.createTenant({ id: 'default', name: 'Default' });
  const auth = new LocalAuthProvider({ store, secret: 'test-secret' });
  await auth.createUser('default', 'admin', 'pw', 'platform_admin');

  let activeModel = model;
  let activeModelConfig: NonNullable<Runtime['modelConfig']> = {
    id: 'mock',
    protocol: 'anthropic',
    baseURL: 'http://localhost:8000/v1',
    apiKey: 'initial-key',
    model: 'mock-model',
  };
  const rt = {
    get model() {
      return activeModel;
    },
    set model(next: ChatModel) {
      activeModel = next;
    },
    get modelConfig() {
      return activeModelConfig;
    },
    set modelConfig(next: NonNullable<Runtime['modelConfig']>) {
      activeModelConfig = next;
    },
    updateModel(next: NonNullable<Runtime['modelConfig']>) {
      activeModelConfig = next;
      activeModel = {
        id: next.id,
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: 'text_delta', text: `model:${next.model}` };
          yield { type: 'stop', reason: 'end_turn' };
        },
      };
    },
    modelOptions: [
      {
        id: 'mock',
        protocol: 'anthropic',
        baseURL: 'http://localhost:8000/v1',
        apiKey: 'initial-key',
        model: 'mock-model',
      },
      {
        id: 'glm-5',
        protocol: 'anthropic',
        baseURL: 'http://192.168.10.108:18317',
        apiKey: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
        model: 'glm-5',
      },
    ],
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

  it('streams thinking deltas over SSE and persists them separately', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'thinking-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const localToken = (await auth.login('default', 'admin', 'pw'))!;
    const thinkingModel: ChatModel = {
      id: 'thinking',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'thinking_delta', text: '先分析上下文。' };
        yield { type: 'text_delta', text: '最终回答。' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const rt = {
      model: thinkingModel,
      tools: new ToolRegistry(),
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'thinking-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const thinkingServer = createHttpServer(rt);
    await new Promise<void>((resolve) => thinkingServer.listen(0, '127.0.0.1', resolve));
    const thinkingBase = `http://127.0.0.1:${(thinkingServer.address() as AddressInfo).port}`;

    try {
      const r = await fetch(`${thinkingBase}/v1/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${localToken}` },
        body: JSON.stringify({ task: 'hi', sessionId: 'think-sess' }),
      });
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain('event: thinking_delta');
      expect(body).toContain('event: text_delta');

      const ctx = { tenantId: 'default', userId: 'admin', role: 'platform_admin' as const };
      const msgs = await localStore.listMessages(ctx, 'think-sess');
      const assistant = msgs.find((m) => m.role === 'assistant');
      expect(assistant?.thinking).toBe('先分析上下文。');
      expect(assistant?.text).toBe('最终回答。');
    } finally {
      await new Promise<void>((resolve) => thinkingServer.close(() => resolve()));
    }
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

  it('paginates and deletes chat sessions', async () => {
    const ctx = { tenantId: 'default', userId: 'admin', role: 'platform_admin' as const };
    for (let i = 0; i < 3; i++) {
      await store.appendMessage(ctx, `paged-${i}`, { role: 'user', text: `分页会话 ${i}` });
      await store.appendMessage(ctx, `paged-${i}`, { role: 'assistant', text: `回答 ${i}` });
    }

    const first = await fetch(`${base}/v1/sessions?limit=2&offset=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      sessions: Array<{ sessionId: string }>;
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
    expect(firstBody.sessions).toHaveLength(2);
    expect(firstBody.limit).toBe(2);
    expect(firstBody.offset).toBe(0);
    expect(firstBody.total).toBeGreaterThanOrEqual(3);
    expect(firstBody.hasMore).toBe(true);

    const second = await fetch(`${base}/v1/sessions?limit=2&offset=2`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const secondBody = await second.json() as { sessions: Array<{ sessionId: string }>; offset: number };
    expect(secondBody.offset).toBe(2);
    expect(secondBody.sessions.map((session) => session.sessionId)).not.toContain(firstBody.sessions[0]!.sessionId);

    const deleted = await fetch(`${base}/v1/sessions/paged-1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    await expect(store.listMessages(ctx, 'paged-1')).resolves.toEqual([]);

    const missing = await fetch(`${base}/v1/sessions/paged-1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });

  it('passes uploaded attachment metadata into the agent task', async () => {
    const r = await fetch(`${base}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        task: '分析上传的日志',
        sessionId: 'sess-upload',
        attachments: [{
          name: 'error.log',
          type: 'text/plain',
          size: 12,
          data: 'data:text/plain;base64,ZXJyb3IgbGluZQ==',
        }],
      }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('event: done');

    const ctx = { tenantId: 'default', userId: 'admin', role: 'platform_admin' as const };
    const msgs = await store.listMessages(ctx, 'sess-upload');
    expect(msgs.find((m) => m.role === 'user')?.text).toContain('[上传附件]');
    expect(msgs.find((m) => m.role === 'user')?.text).toContain('error.log');
    expect(msgs.find((m) => m.role === 'user')?.text).toContain('data:text/plain;base64,ZXJyb3IgbGluZQ==');
  });

  it('admin can list tenants; unknown route 404s', async () => {
    const r = await fetch(`${base}/v1/admin/tenants`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { tenants: unknown[] }).tenants.length).toBeGreaterThan(0);

    const nf = await fetch(`${base}/nope`);
    expect(nf.status).toBe(404);
  });

  it('serves the frontend shell for the login page route', async () => {
    const r = await fetch(`${base}/login`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('/app.js');
  });

  it('reads, updates, and tests runtime LLM settings', async () => {
    const initial = await fetch(`${base}/v1/settings/llm`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      config: {
        id: 'mock',
        protocol: 'anthropic',
        base_url: 'http://localhost:8000/v1',
        model: 'mock-model',
        api_key: 'initial-key',
        api_key_set: true,
        api_key_preview: 'ini...key',
      },
      options: [
        {
          id: 'mock',
          protocol: 'anthropic',
          base_url: 'http://localhost:8000/v1',
          model: 'mock-model',
          api_key: 'initial-key',
          api_key_set: true,
          api_key_preview: 'ini...key',
        },
        {
          id: 'glm-5',
          protocol: 'anthropic',
          base_url: 'http://192.168.10.108:18317',
          model: 'glm-5',
          api_key: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
          api_key_set: true,
          api_key_preview: 'tes...aZ3',
        },
      ],
    });

    const updated = await fetch(`${base}/v1/settings/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        base_url: 'http://192.168.10.108:18317',
        api_key: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
        model: 'glm-5',
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      config: {
        id: 'glm-5',
        protocol: 'anthropic',
        base_url: 'http://192.168.10.108:18317',
        model: 'glm-5',
        api_key: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
        api_key_set: true,
        api_key_preview: 'tes...aZ3',
      },
    });
    expect(await store.getLlmSettings({ tenantId: 'default' })).toMatchObject({
      id: 'glm-5',
      protocol: 'anthropic',
      baseURL: 'http://192.168.10.108:18317',
      apiKey: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
      model: 'glm-5',
    });

    const probe = await fetch(`${base}/v1/settings/llm/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ ok: true, text: 'model:glm-5' });

    const switched = await fetch(`${base}/v1/settings/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        protocol: 'openai',
        base_url: 'http://192.168.10.108:18317',
        api_key: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
        model: 'glm-5',
      }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({
      config: {
        protocol: 'openai',
        base_url: 'http://192.168.10.108:18317',
        model: 'glm-5',
        api_key: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
      },
    });

    const optionSwitch = await fetch(`${base}/v1/settings/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: 'mock' }),
    });
    expect(optionSwitch.status).toBe(200);
    expect(await optionSwitch.json()).toMatchObject({
      config: {
        id: 'mock',
        protocol: 'anthropic',
        base_url: 'http://localhost:8000/v1',
        model: 'mock-model',
        api_key: 'initial-key',
      },
    });

    const keepKey = await fetch(`${base}/v1/settings/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        protocol: 'openai',
        base_url: 'http://example.test/v1',
        model: 'new-model-without-key',
      }),
    });
    expect(keepKey.status).toBe(200);
    expect(await keepKey.json()).toMatchObject({
      config: {
        protocol: 'openai',
        base_url: 'http://example.test/v1',
        model: 'new-model-without-key',
        api_key: 'initial-key',
      },
    });
  });

  it('dispatches sandbox code and browser operations over HTTP', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'sandbox-http-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const calls: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'sbx__run_code', description: 'run code', inputSchema: { type: 'object' } },
      run: async (args) => ({ id: '', content: `code:${(args as { code: string }).code}` }),
    });
    tools.register({
      def: { name: 'browser_navigate', description: 'navigate', inputSchema: { type: 'object' } },
      run: async (args) => {
        calls.push(`navigate:${(args as { url: string }).url}`);
        return { id: '', content: 'navigated' };
      },
    });
    tools.register({
      def: { name: 'desktop_stream_url', description: 'stream', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: '桌面流地址：http://stream.local/session' }),
    });
    tools.register({
      def: { name: 'browser_click', description: 'click', inputSchema: { type: 'object' } },
      run: async (args) => {
        calls.push(`click:${(args as { x: number; y: number }).x},${(args as { x: number; y: number }).y}`);
        return { id: '', content: 'clicked' };
      },
    });
    tools.register({
      def: { name: 'browser_type', description: 'type', inputSchema: { type: 'object' } },
      run: async (args) => {
        calls.push(`type:${(args as { text: string }).text}`);
        return { id: '', content: 'typed' };
      },
    });
    tools.register({
      def: { name: 'browser_screenshot', description: 'screenshot', inputSchema: { type: 'object' } },
      run: async () => ({
        id: '',
        content: 'screenshot',
        contentBlocks: [{ type: 'image', mimeType: 'image/png', data: 'AQID' }],
      }),
    });

    const rt = {
      model,
      tools,
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'sandbox-http-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const sandboxServer = createHttpServer(rt);
    await new Promise<void>((resolve) => sandboxServer.listen(0, '127.0.0.1', resolve));
    const sandboxBase = `http://127.0.0.1:${(sandboxServer.address() as AddressInfo).port}`;
    const authed = { authorization: `Bearer ${adminToken}` };

    try {
      const runCode = await fetch(`${sandboxBase}/v1/sandbox/run-code`, {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', code: 'print(1)', language: 'python' }),
      });
      expect(runCode.status).toBe(200);
      expect(await runCode.json()).toMatchObject({ ok: true, result: { content: 'code:print(1)' } });

      const nav = await fetch(`${sandboxBase}/v1/browser/navigate`, {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', url: 'https://example.com' }),
      });
      expect(nav.status).toBe(200);
      expect(await nav.json()).toMatchObject({ ok: true, result: { content: 'navigated' } });
      expect(calls).toEqual(['navigate:https://example.com']);

      const stream = await fetch(`${sandboxBase}/v1/browser/stream`, {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1' }),
      });
      expect(stream.status).toBe(200);
      expect(await stream.json()).toMatchObject({
        ok: true,
        result: { content: '桌面流地址：http://stream.local/session' },
      });

      const click = await fetch(`${sandboxBase}/v1/browser/click`, {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', x: 12, y: 34 }),
      });
      expect(click.status).toBe(200);
      expect(await click.json()).toMatchObject({ ok: true, result: { content: 'clicked' } });

      const type = await fetch(`${sandboxBase}/v1/browser/type`, {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', text: 'hello' }),
      });
      expect(type.status).toBe(200);
      expect(await type.json()).toMatchObject({ ok: true, result: { content: 'typed' } });
      expect(calls).toEqual(['navigate:https://example.com', 'click:12,34', 'type:hello']);

      const shot = await fetch(`${sandboxBase}/v1/browser/screenshot`, {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1' }),
      });
      expect(shot.status).toBe(200);
      expect(await shot.json()).toMatchObject({
        ok: true,
        result: { content: 'screenshot', contentBlocks: [{ type: 'image', mimeType: 'image/png', data: 'AQID' }] },
      });
    } finally {
      await new Promise<void>((resolve) => sandboxServer.close(() => resolve()));
    }
  });

  it('wraps local data-url browser streams in a same-origin live preview page', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'stream-view-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'desktop_stream_url', description: 'stream', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: '桌面流地址：data:text/html;charset=utf-8,%3Chtml%3E%3C%2Fhtml%3E' }),
    });

    const rt = {
      model,
      tools,
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'stream-view-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const streamServer = createHttpServer(rt);
    await new Promise<void>((resolve) => streamServer.listen(0, '127.0.0.1', resolve));
    const streamBase = `http://127.0.0.1:${(streamServer.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };

    try {
      const stream = await fetch(`${streamBase}/v1/browser/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'live-s1' }),
      });
      expect(stream.status).toBe(200);
      expect(await stream.json()).toMatchObject({
        ok: true,
        result: { content: '桌面流地址：/v1/browser/stream-view?sessionId=live-s1' },
      });

      const view = await fetch(`${streamBase}/v1/browser/stream-view?sessionId=live-s1`);
      expect(view.status).toBe(200);
      const html = await view.text();
      expect(html).toContain('/v1/browser/screenshot');
      expect(html).toContain("localStorage.getItem('aiop_token')");
      expect(html).toContain('live-s1');
    } finally {
      await new Promise<void>((resolve) => streamServer.close(() => resolve()));
    }
  });

  it('dispatches any registered tool through the generic tool-call endpoint', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'tool-call-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'load_skill', description: '加载技能', inputSchema: { type: 'object' } },
      run: async (args) => ({ id: '', content: `skill:${(args as { name: string }).name}` }),
    });
    tools.register({
      def: { name: 'mcp__fs__read_file', description: '读取文件', inputSchema: { type: 'object' } },
      run: async (args) => ({ id: '', content: `file:${(args as { path: string }).path}` }),
    });

    const rt = {
      model,
      tools,
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'tool-call-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const toolServer = createHttpServer(rt);
    await new Promise<void>((resolve) => toolServer.listen(0, '127.0.0.1', resolve));
    const toolBase = `http://127.0.0.1:${(toolServer.address() as AddressInfo).port}`;
    const authed = { authorization: `Bearer ${adminToken}` };

    try {
      const skill = await fetch(`${toolBase}/v1/tools/call`, {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', name: 'load_skill', args: { name: 'inspect' } }),
      });
      expect(skill.status).toBe(200);
      expect(await skill.json()).toMatchObject({ ok: true, result: { content: 'skill:inspect' } });

      const mcp = await fetch(`${toolBase}/v1/tools/call`, {
        method: 'POST',
        headers: { ...authed, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', name: 'mcp__fs__read_file', args: { path: '/tmp/a.txt' } }),
      });
      expect(mcp.status).toBe(200);
      expect(await mcp.json()).toMatchObject({ ok: true, result: { content: 'file:/tmp/a.txt' } });
    } finally {
      await new Promise<void>((resolve) => toolServer.close(() => resolve()));
    }
  });

  it('imports a zipped skill and exposes it in the tools list', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'skill-import-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const skillRoot = await mkdtemp(join(tmpdir(), 'aiop-http-skill-import-'));
    await mkdir(skillRoot, { recursive: true });
    const skills = new SkillRegistry(skillRoot);
    await skills.scan();
    const tools = new ToolRegistry();
    tools.register(skills.tool());
    const rt = {
      model,
      tools,
      skillRegistry: skills,
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'skill-import-secret',
      systemExtra: skills.summaries(),
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const importServer = createHttpServer(rt);
    await new Promise<void>((resolve) => importServer.listen(0, '127.0.0.1', resolve));
    const importBase = `http://127.0.0.1:${(importServer.address() as AddressInfo).port}`;
    const data = storedZip({
      'SKILL.md': '---\nname: imported\ndescription: Imported skill\n---\n# Imported',
      'scripts/run.sh': 'echo imported',
    }).toString('base64');

    try {
      const imported = await fetch(`${importBase}/v1/skills/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'imported.zip', data: `data:application/zip;base64,${data}` }),
      });
      expect(imported.status).toBe(201);
      expect(await imported.json()).toMatchObject({
        skill: {
          name: 'imported',
          description: 'Imported skill',
          enabled: true,
          status: '已启用',
          fileEntries: expect.arrayContaining([
            expect.objectContaining({ path: 'SKILL.md', isDirectory: false, size: expect.any(Number), updatedAt: expect.any(String) }),
            expect.objectContaining({ path: 'scripts', isDirectory: true }),
            expect.objectContaining({ path: 'scripts/run.sh', isDirectory: false, size: expect.any(Number), updatedAt: expect.any(String) }),
          ]),
        },
      });

      const listed = await fetch(`${importBase}/v1/tools`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(listed.status).toBe(200);
      const body = await listed.json() as {
        tools: Array<{
          name: string;
          description: string;
          category: string;
          enabled?: boolean;
          status?: string;
          fileEntries?: Array<{ path: string; isDirectory: boolean; size: number; updatedAt: string }>;
        }>;
      };
      expect(body.tools).toContainEqual(expect.objectContaining({
        name: 'imported',
        description: 'Imported skill',
        category: 'skill',
        enabled: true,
        status: '已启用',
        fileEntries: expect.arrayContaining([
          expect.objectContaining({ path: 'SKILL.md', isDirectory: false }),
          expect.objectContaining({ path: 'scripts', isDirectory: true }),
          expect.objectContaining({ path: 'scripts/run.sh', isDirectory: false }),
        ]),
      }));

      const rootFiles = await fetch(`${importBase}/v1/skills/imported/files`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(rootFiles.status).toBe(200);
      expect(await rootFiles.json()).toMatchObject({
        path: '',
        parentPath: null,
        entries: [
          expect.objectContaining({ path: 'scripts', isDirectory: true }),
          expect.objectContaining({ path: 'SKILL.md', isDirectory: false }),
        ],
      });

      const skillMd = await fetch(`${importBase}/v1/skills/imported/files?path=SKILL.md`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(skillMd.status).toBe(200);
      expect(await skillMd.json()).toMatchObject({
        path: 'SKILL.md',
        entry: expect.objectContaining({ path: 'SKILL.md', isDirectory: false }),
        content: expect.stringContaining('# Imported'),
      });

      const disabled = await fetch(`${importBase}/v1/skills/imported/disable`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toMatchObject({ skill: { name: 'imported', enabled: false, status: '已禁用' } });

      const disabledLoad = await fetch(`${importBase}/v1/tools/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', name: 'load_skill', args: { name: 'imported' } }),
      });
      expect(disabledLoad.status).toBe(200);
      expect(await disabledLoad.json()).toMatchObject({ ok: false, result: { isError: true } });

      const enabled = await fetch(`${importBase}/v1/skills/imported/enable`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({ skill: { name: 'imported', enabled: true, status: '已启用' } });

      const rejectedDelete = await fetch(`${importBase}/v1/skills/imported`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: false }),
      });
      expect(rejectedDelete.status).toBe(400);

      const deleted = await fetch(`${importBase}/v1/skills/imported`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });

      const afterDelete = await fetch(`${importBase}/v1/tools`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(afterDelete.status).toBe(200);
      const afterDeleteBody = await afterDelete.json() as { tools: Array<{ name: string }> };
      expect(afterDeleteBody.tools.map((tool) => tool.name)).not.toContain('imported');
    } finally {
      await new Promise<void>((resolve) => importServer.close(() => resolve()));
    }
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
