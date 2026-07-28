import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/server/http.js';
import { MemoryStore } from '../src/db/memory.js';
import type { SandboxSettings } from '../src/db/store.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { ChatModel, Msg, StreamEvent } from '../src/model/types.js';
import { SkillRegistry, type SkillProductRecord } from '../src/skill/registry.js';
import type { ProductSkillLoader } from '../src/skill/service.js';
import { McpManager } from '../src/mcp/manager.js';
import type { McpClientLike } from '../src/mcp/types.js';
import { SandboxManager } from '../src/sandbox/lifecycle.js';
import { buildSandboxTools } from '../src/tools/builtin.js';
import { buildSandboxProfileTools } from '../src/tools/sandbox-profiles.js';
import type { ExecResult, SandboxHandle, SandboxProvider, SandboxSpec } from '../src/sandbox/types.js';
import type { AppendRunMessageInput, DurableRunRuntime } from '@aiop/control-contracts';
import { loadSourcedSkills } from '@earendil-works/pi-agent-core';
import { EventCodec } from '../packages/pi-runtime/src/index.js';

/** 纯文本回答的 mock 模型（不发起工具调用）。 */
const model: ChatModel = {
  id: 'mock',
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', text: 'hello' };
    yield { type: 'stop', reason: 'end_turn' };
  },
};

function mockSandboxProvider() {
  let seq = 0;
  const makeHandle = (id: string): SandboxHandle => ({
    sandboxId: id,
    runCode: vi.fn(async (code: string): Promise<ExecResult> => ({ stdout: `code:${code}`, stderr: '', exitCode: 0 })),
    runCommand: vi.fn(async (command: string): Promise<ExecResult> => ({ stdout: `cmd:${command}`, stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => new Uint8Array()),
    setTimeout: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
  });
  const provider: SandboxProvider = {
    create: vi.fn(async (_spec: SandboxSpec) => makeHandle(`sandbox-${++seq}`)),
    connect: vi.fn(async (sandboxId: string) => makeHandle(sandboxId)),
  };
  return { provider };
}

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
  await auth.createUser('default', 'bob', 'pw', 'user');

  // MCP：mock connect（server 名以 down 开头则连接失败），暴露一个 echo 工具
  const mcpConnect = async (name: string): Promise<McpClientLike> => {
    if (name.startsWith('down')) throw new Error('connect refused');
    return {
      listTools: async () => ({ tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object' } }] }),
      callTool: async (p) => ({ content: [{ type: 'text', text: `echo:${JSON.stringify(p.arguments ?? {})}` }] }),
      close: async () => {},
    };
  };
  const mcp = new McpManager({ fs: { transport: 'stdio', command: 'fake' } }, mcpConnect);
  await mcp.start();

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
    mcp,
    store,
    audit: { record: async () => {} },
    policy: new AllowAllPolicy(),
    policyPreApproved: new AllowAllPolicy(),
    authProvider: auth,
    jwtSecret: 'test-secret',
    systemExtra: '',
    defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
  } as unknown as Runtime;

  for (const t of mcp.tools()) rt.tools.register(t);

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
    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    const msgs = await store.listMessages(ctx, 'sess-1');
    expect(msgs.map((m) => m.role)).toContain('assistant');
  });

  it('persists agent duration in successful assistant history', async () => {
    const sessionId = 'duration-success';
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'default', username: 'admin', password: 'pw' }),
    });
    const durationToken = (await login.json() as { token: string }).token;
    const run = await fetch(`${base}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${durationToken}` },
      body: JSON.stringify({ task: 'measure this run', sessionId }),
    });
    expect(run.status).toBe(200);
    expect(await run.text()).toContain('event: done');

    const history = await fetch(`${base}/v1/sessions/${sessionId}/messages`, {
      headers: { authorization: `Bearer ${durationToken}` },
    });
    expect(history.status).toBe(200);
    const body = await history.json() as { messages: Msg[] };
    const assistant = body.messages.findLast((message) => message.role === 'assistant');
    expect(assistant?.text).toBe('hello');
    expect(assistant?.durationMs).toEqual(expect.any(Number));
    expect(assistant!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses numeric session ids when the client omits or sends a numeric sessionId', async () => {
    const generated = await fetch(`${base}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'numeric session please' }),
    });
    expect(generated.status).toBe(200);
    const generatedBody = await generated.text();
    const generatedSessionId = /event: session\ndata: (.+)\n/.exec(generatedBody)?.[1];
    expect(generatedSessionId).toBeTruthy();
    expect(JSON.parse(generatedSessionId!).sessionId).toMatch(/^\d+$/);

    const numericInput = await fetch(`${base}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'numeric input', sessionId: 123456 }),
    });
    expect(numericInput.status).toBe(200);
    const numericBody = await numericInput.text();
    const numericSessionId = /event: session\ndata: (.+)\n/.exec(numericBody)?.[1];
    expect(JSON.parse(numericSessionId!).sessionId).toBe('123456');
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

      const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
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
    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    const msgs = await store.listMessages(ctx, 'sess-1');
    // 两轮：user/assistant ×2
    expect(msgs.filter((m) => m.role === 'user').length).toBe(2);
  });

  it('passes prior session messages into the model context', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'context-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    await localStore.appendMessage(ctx, 'ctx-sess', { role: 'user', text: '上一轮问题' });
    await localStore.appendMessage(ctx, 'ctx-sess', { role: 'assistant', text: '上一轮回答' });

    const seenMessages: Msg[][] = [];
    const contextModel: ChatModel = {
      id: 'context',
      async *stream(input): AsyncIterable<StreamEvent> {
        seenMessages.push(input.messages.map((message) => ({ ...message })));
        yield { type: 'text_delta', text: `seen:${input.messages.length}` };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const rt = {
      model: contextModel,
      tools: new ToolRegistry(),
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'context-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const contextServer = createHttpServer(rt);
    await new Promise<void>((resolve) => contextServer.listen(0, '127.0.0.1', resolve));
    const contextBase = `http://127.0.0.1:${(contextServer.address() as AddressInfo).port}`;

    try {
      const r = await fetch(`${contextBase}/v1/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ task: '本轮问题', sessionId: 'ctx-sess' }),
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('event: done');
      expect(seenMessages).toHaveLength(1);
      expect(seenMessages[0]!.map((m) => [m.role, m.text])).toEqual([
        ['user', '上一轮问题'],
        ['assistant', '上一轮回答'],
        ['user', '本轮问题'],
      ]);
    } finally {
      await new Promise<void>((resolve) => contextServer.close(() => resolve()));
    }
  });

  it('terminates an active agent run without deleting the session history', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'terminate-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    await localStore.appendMessage(ctx, 'term-sess', { role: 'user', text: '保留的问题' });
    await localStore.appendMessage(ctx, 'term-sess', { role: 'assistant', text: '保留的回答' });

    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => { streamStarted = resolve; });
    let aborted = false;
    const slowModel: ChatModel = {
      id: 'slow',
      async *stream(input): AsyncIterable<StreamEvent> {
        streamStarted();
        yield { type: 'text_delta', text: '开始执行' };
        const signal = (input as { signal?: AbortSignal }).signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => {
            aborted = true;
            resolve();
          }, { once: true });
          setTimeout(resolve, 300);
        });
        if (!aborted) yield { type: 'text_delta', text: '未终止' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const rt = {
      model: slowModel,
      tools: new ToolRegistry(),
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'terminate-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const terminateServer = createHttpServer(rt);
    await new Promise<void>((resolve) => terminateServer.listen(0, '127.0.0.1', resolve));
    const terminateBase = `http://127.0.0.1:${(terminateServer.address() as AddressInfo).port}`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` };

    try {
      const run = fetch(`${terminateBase}/v1/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: '长任务', sessionId: 'term-sess' }),
      });
      await started;
      const stopped = await fetch(`${terminateBase}/v1/sessions/term-sess/terminate`, {
        method: 'POST',
        headers,
      });

      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toMatchObject({ ok: true, sessionId: 'term-sess', aborted: 1 });

      const runResponse = await run;
      expect(runResponse.status).toBe(200);
      const body = await runResponse.text();
      expect(body).toContain('event: terminated');
      expect(body).not.toContain('未终止');
      expect(aborted).toBe(true);
      const messages = await localStore.listMessages(ctx, 'term-sess');
      expect(messages.slice(0, 2)).toEqual([
        { role: 'user', text: '保留的问题' },
        { role: 'assistant', text: '保留的回答' },
      ] as Msg[]);
      expect(messages.at(-2)).toMatchObject({ role: 'user', text: '长任务' });
      expect(messages.at(-1)).toMatchObject({
        role: 'assistant',
        text: expect.stringContaining('开始执行'),
        durationMs: expect.any(Number),
      });
      expect(messages.at(-1)?.text).toContain('已终止当前运行。');
    } finally {
      await new Promise<void>((resolve) => terminateServer.close(() => resolve()));
    }
  });

  it('persists duration for a failed agent run with partial output', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'failed-run-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const failingModel: ChatModel = {
      id: 'failing',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'thinking_delta', text: '正在分析。' };
        yield { type: 'text_delta', text: '部分回答。' };
        throw Object.assign(new Error('upstream failed'), { status: 400 });
      },
    };
    const rt = {
      model: failingModel,
      tools: new ToolRegistry(),
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'failed-run-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;
    const failedServer = createHttpServer(rt);
    await new Promise<void>((resolve) => failedServer.listen(0, '127.0.0.1', resolve));
    const failedBase = `http://127.0.0.1:${(failedServer.address() as AddressInfo).port}`;

    try {
      const run = await fetch(`${failedBase}/v1/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ task: '失败任务', sessionId: 'failed-sess' }),
      });
      expect(run.status).toBe(200);
      expect(await run.text()).toContain('event: error');

      const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
      const messages = await localStore.listMessages(ctx, 'failed-sess');
      expect(messages.at(-2)).toMatchObject({ role: 'user', text: '失败任务' });
      expect(messages.at(-1)).toMatchObject({
        role: 'assistant',
        text: expect.stringContaining('部分回答。'),
        thinking: '正在分析。',
        durationMs: expect.any(Number),
      });
      expect(messages.at(-1)?.text).toContain('运行失败：upstream failed');
    } finally {
      await new Promise<void>((resolve) => failedServer.close(() => resolve()));
    }
  });

  it('paginates and deletes chat sessions', async () => {
    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
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

    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    const msgs = await store.listMessages(ctx, 'sess-upload');
    expect(msgs.find((m) => m.role === 'user')?.text).toContain('[上传附件]');
    expect(msgs.find((m) => m.role === 'user')?.text).toContain('error.log');
    expect(msgs.find((m) => m.role === 'user')?.text).toContain('data:text/plain;base64,ZXJyb3IgbGluZQ==');
  });

  it('turns image attachments into content blocks instead of inlined base64 text', async () => {
    const imageData = 'iVBORw0KGgoAAAANSUhEUg=='; // 假 PNG base64
    const r = await fetch(`${base}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        task: '看下这张截图',
        sessionId: 'sess-upload-img',
        attachments: [{
          name: 'shot.png',
          type: 'image/png',
          size: 18,
          data: `data:image/png;base64,${imageData}`,
        }],
      }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('event: done');

    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    const msgs = await store.listMessages(ctx, 'sess-upload-img');
    const user = msgs.find((m) => m.role === 'user');
    // 图像本体进 contentBlocks（受 keep-last-K / 硬裁剪治理），text 只留元信息
    expect(user?.contentBlocks).toEqual([{ type: 'image', mimeType: 'image/png', data: imageData }]);
    expect(user?.text).toContain('shot.png');
    expect(user?.text).not.toContain(imageData);
  });

  it('creates empty sessions immediately and exposes context usage', async () => {
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: 'empty-http', title: '新会话' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      session: { sessionId: 'empty-http', title: '新会话', messageCount: 0 },
    });

    const listed = await fetch(`${base}/v1/sessions?limit=20`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { sessions: Array<{ sessionId: string; title: string }> };
    expect(listedBody.sessions).toContainEqual(expect.objectContaining({ sessionId: 'empty-http', title: '新会话' }));

    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    await store.appendMessage(ctx, 'context-http', { role: 'user', text: '1234567890' });
    await store.appendMessage(ctx, 'context-http', { role: 'assistant', text: 'abcd' });
    const context = await fetch(`${base}/v1/sessions/context-http/context`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(context.status).toBe(200);
    expect(await context.json()).toEqual({
      sessionId: 'context-http',
      usedTokens: 4,
      maxTokens: 200000,
      estimated: true,
    });
  });

  it('exposes current-user session cumulative token usage', async () => {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'default', username: 'admin', password: 'pw' }),
    });
    const authToken = ((await login.json()) as { token: string }).token;
    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    await store.createSession(ctx, { sessionId: 'usage-http', title: '用量会话' });
    await store.record({ kind: 'usage', action: 'agent', tenantId: 'default', sessionId: 'usage-http', detail: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 } });
    await store.record({ kind: 'usage', action: 'agent', tenantId: 'default', sessionId: 'usage-http', detail: { inputTokens: 50, outputTokens: 10 } });
    await store.record({ kind: 'usage', action: 'scheduler', tenantId: 'default', sessionId: 'usage-http', detail: { inputTokens: 999, outputTokens: 999 } });

    const response = await fetch(`${base}/v1/sessions/usage-http/usage`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: 'usage-http', totalTokens: 185 });

    const unauthorized = await fetch(`${base}/v1/sessions/usage-http/usage`);
    expect(unauthorized.status).toBe(401);

    const missing = await fetch(`${base}/v1/sessions/not-owned/usage`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(missing.status).toBe(404);
  });

  it('appends idle session messages without starting an agent run', async () => {
    const appended = await fetch(`${base}/v1/sessions/append-idle/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        task: '补充一条信息',
        attachments: [{ name: 'note.txt', type: 'text/plain', size: 4, data: 'data:text/plain;base64,bm90ZQ==' }],
      }),
    });
    expect(appended.status).toBe(200);
    expect(await appended.json()).toEqual({ ok: true, sessionId: 'append-idle', queued: false });

    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    const msgs = await store.listMessages(ctx, 'append-idle');
    expect(msgs).toEqual([
      expect.objectContaining({ role: 'user', text: expect.stringContaining('补充一条信息') }),
    ]);
    expect(msgs[0]?.text).toContain('[上传附件]');
    expect(msgs[0]?.text).toContain('note.txt');
  });

  it('finds a cross-worker active run even when a newer terminal run exists', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'cross-worker-secret' });
    const admin = await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const sessionId = 'cross-worker-session';
    const older = new Date('2026-07-28T00:00:00.000Z');
    await localStore.putAgentRunBindingIfAbsent({
      tenantId: 'default', userId: admin.id, sessionId, runId: 'run-active-older', kernel: 'pi',
      graphName: '', graphVersion: '', createdAt: older,
    });
    await localStore.updateAgentRun('default', 'run-active-older', { status: 'running', updatedAt: older });
    const newer = new Date(older.getTime() + 1000);
    await localStore.putAgentRunBindingIfAbsent({
      tenantId: 'default', userId: admin.id, sessionId, runId: 'run-terminal-newer', kernel: 'pi',
      graphName: '', graphVersion: '', createdAt: newer,
    });
    await localStore.updateAgentRun('default', 'run-terminal-newer', { status: 'succeeded', updatedAt: newer, completedAt: newer });
    const append = vi.fn(async () => {});
    const rt = {
      model, tools: new ToolRegistry(), store: localStore, policy: new AllowAllPolicy(), policyPreApproved: new AllowAllPolicy(),
      authProvider: auth, jwtSecret: 'cross-worker-secret', systemExtra: '', durableRunRuntime: { append },
    } as unknown as Runtime;
    const server = createHttpServer(rt);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const localBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${localBase}/v1/sessions/${sessionId}/append`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ task: 'cross worker steer' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ queued: true });
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-active-older' }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects a durable run when another worker already owns the session', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'cross-worker-run-secret' });
    const admin = await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    await localStore.putAgentRunBindingIfAbsent({
      tenantId: 'default', userId: admin.id, sessionId: 'shared-session', runId: 'remote-running', kernel: 'pi',
      graphName: '', graphVersion: '', createdAt: new Date(),
    });
    await localStore.updateAgentRun('default', 'remote-running', { status: 'running', updatedAt: new Date() });
    const run = vi.fn(async () => { throw new Error('must not start a competing run'); });
    const rt = {
      model, tools: new ToolRegistry(), store: localStore, policy: new AllowAllPolicy(), policyPreApproved: new AllowAllPolicy(),
      authProvider: auth, jwtSecret: 'cross-worker-run-secret', systemExtra: '', durableRunRuntime: { run },
    } as unknown as Runtime;
    const server = createHttpServer(rt);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const localBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${localBase}/v1/agent`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ sessionId: 'shared-session', task: 'competing request' }),
      });
      expect(response.status).toBe(409);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('routes active session appends through the durable runtime inbox', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'append-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;

    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let appended!: (input: AppendRunMessageInput) => void;
    const appendedInput = new Promise<AppendRunMessageInput>((resolve) => { appended = resolve; });
    const appendDurably = vi.fn(async (input: AppendRunMessageInput) => appended(input));
    const runDurably = vi.fn(async () => {
      firstStarted();
      let sequence = 0n;
      const codec = new EventCodec({
        tenantId: 'default', runId: 'durable-active-run', attemptId: 'attempt-a', turnNo: 1,
        correlationId: 'http-compat', sequence: () => ++sequence,
      });
      const update = (delta: string) => codec.fromPi({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: delta }], stopReason: 'stop' },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      } as never);
      return {
        runId: 'durable-active-run', status: 'running' as const,
        events: {
          async *[Symbol.asyncIterator]() {
            yield update('第一段回答');
            const input = await appendedInput;
            yield update(`已纳入：${input.message.text}`);
          },
        },
        async result() {
          const input = await appendedInput;
          return {
            runId: 'durable-active-run', status: 'succeeded' as const, text: `已纳入：${input.message.text}`,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          };
        },
      };
    });
    const queueModel: ChatModel = {
      id: 'queue',
      async *stream(): AsyncIterable<StreamEvent> { throw new Error('legacy runtime must not execute'); },
    };
    const rt = {
      model: queueModel,
      tools: new ToolRegistry(),
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'append-secret',
      systemExtra: '',
      durableRunRuntime: { run: runDurably, append: appendDurably } as unknown as DurableRunRuntime,
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const appendServer = createHttpServer(rt);
    await new Promise<void>((resolve) => appendServer.listen(0, '127.0.0.1', resolve));
    const appendBase = `http://127.0.0.1:${(appendServer.address() as AddressInfo).port}`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` };

    try {
      const run = fetch(`${appendBase}/v1/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: '开始排查', sessionId: 'active-append' }),
      });
      await started;

      const competing = await fetch(`${appendBase}/v1/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: '并发启动另一个任务', sessionId: 'active-append' }),
      });

      const appended = await fetch(`${appendBase}/v1/sessions/active-append/append`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: '中途修正：优先看 kube-system' }),
      });
      expect(appended.status).toBe(200);
      expect(await appended.json()).toEqual({ ok: true, sessionId: 'active-append', queued: true });
      expect(runDurably).toHaveBeenCalledOnce();
      expect(appendDurably).toHaveBeenCalledWith(expect.objectContaining({
        runId: expect.any(String), mode: 'steer',
        message: expect.objectContaining({ role: 'user', text: expect.stringContaining('中途修正') }),
      }));

      const runResponse = await run;
      expect(runResponse.status).toBe(200);
      const runBody = await runResponse.text();
      expect(runBody).toContain('event: text_delta');
      expect(runBody).toContain('已纳入：中途修正');
      expect(competing.status).toBe(409);
      await competing.text();
    } finally {
      await new Promise<void>((resolve) => appendServer.close(() => resolve()));
    }
  });

  it('projects durable terminal results into legacy success, error, and terminated SSE semantics', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'durable-result-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const run = vi.fn(async (input: { input: Array<{ text?: string }> }) => {
      const mode = input.input[0]?.text;
      const status = mode === 'fail' ? 'failed' as const : mode === 'cancel' ? 'cancelled' as const : 'succeeded' as const;
      return {
        runId: `run-${mode}`, status: 'running' as const,
        events: { async *[Symbol.asyncIterator]() {} },
        async result() {
          return {
            runId: `run-${mode}`, status,
            ...(status === 'succeeded' ? { text: 'fallback durable answer' } : {}),
            ...(status === 'failed' ? { error: { code: 'MODEL_PROVIDER_ERROR' as const, message: 'provider failed', retryable: false } } : {}),
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          };
        },
      };
    });
    const rt = {
      model, tools: new ToolRegistry(), store: localStore, policy: new AllowAllPolicy(), policyPreApproved: new AllowAllPolicy(),
      authProvider: auth, jwtSecret: 'durable-result-secret', systemExtra: '', durableRunRuntime: { run },
    } as unknown as Runtime;
    const server = createHttpServer(rt);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const localBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (task: string, sessionId: string) => {
      const response = await fetch(`${localBase}/v1/agent`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ task, sessionId }),
      });
      return response.text();
    };
    try {
      const success = await request('success', 'result-success');
      expect(success).toContain('event: text_delta');
      expect(success).toContain('fallback durable answer');
      expect(success).toContain('event: done');

      const failed = await request('fail', 'result-failed');
      expect(failed).toContain('event: error');
      expect(failed).toContain('provider failed');

      const cancelled = await request('cancel', 'result-cancelled');
      expect(cancelled).toContain('event: terminated');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('runs /goal with an autonomous prompt and extended step budget', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'goal-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'noop', description: 'noop', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });

    const seenSystems: string[] = [];
    let calls = 0;
    const goalModel: ChatModel = {
      id: 'goal',
      async *stream(input): AsyncIterable<StreamEvent> {
        calls++;
        seenSystems.push(input.system);
        if (calls <= 21) {
          yield { type: 'tool_call', call: { id: `tool-${calls}`, name: 'noop', args: {} } };
        } else {
          yield { type: 'text_delta', text: '目标完成' };
        }
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const rt = {
      model: goalModel,
      tools,
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'goal-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const goalServer = createHttpServer(rt);
    await new Promise<void>((resolve) => goalServer.listen(0, '127.0.0.1', resolve));
    const goalBase = `http://127.0.0.1:${(goalServer.address() as AddressInfo).port}`;

    try {
      const run = await fetch(`${goalBase}/v1/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ task: '/goal 完成巡检并整理结果', sessionId: 'goal-sess' }),
      });
      expect(run.status).toBe(200);
      const body = await run.text();
      expect(body).toContain('目标完成');
      expect(body).toContain('"steps":22');
      expect(seenSystems[0]).toContain('目标模式');
      expect(seenSystems[0]).toContain('不可逆');
    } finally {
      await new Promise<void>((resolve) => goalServer.close(() => resolve()));
    }
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
        context_window_tokens: 200000,
        context_keep_images: 1,
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
          context_window_tokens: 200000,
          context_keep_images: 1,
        },
        {
          id: 'glm-5',
          protocol: 'anthropic',
          base_url: 'http://192.168.10.108:18317',
          model: 'glm-5',
          api_key: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
          api_key_set: true,
          api_key_preview: 'tes...aZ3',
          context_window_tokens: 200000,
          context_keep_images: 1,
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
        context_window_tokens: 128000,
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
        context_window_tokens: 128000,
      },
    });
    expect(await store.getLlmSettings({ tenantId: 'default' })).toMatchObject({
      id: 'glm-5',
      protocol: 'anthropic',
      baseURL: 'http://192.168.10.108:18317',
      apiKey: 'test-api-key-lb19tkNtlcFtsKkUtaZ3',
      model: 'glm-5',
      contextWindowTokens: 128000,
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
      run: async () => ({ id: '', content: '浏览器预览地址：http://stream.local/session' }),
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
        result: { content: '浏览器预览地址：http://stream.local/session' },
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

  it('lists real active sandboxes with their bound chat sessions', async () => {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'sandbox-list-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    await auth.createUser('default', 'tenant', 'pw', 'tenant_admin');
    await auth.createUser('default', 'user', 'pw', 'user');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const tenantToken = (await auth.login('default', 'tenant', 'pw'))!;
    const userToken = (await auth.login('default', 'user', 'pw'))!;
    const { provider } = mockSandboxProvider();
    const manager = new SandboxManager({ provider });
    const tools = new ToolRegistry();
    for (const tool of buildSandboxTools(manager)) tools.register(tool);
    const profiles = [
      {
        id: 'code-id',
        name: 'code',
        template: 'code-id',
        description: '普通代码沙箱',
        envType: 'code' as const,
        runtimeRole: 'sandbox-reader' as const,
        image: 'aiop/opensandbox-code:dev',
        desktop: false,
        privileged: false,
        capabilities: ['python', 'shell'],
      },
      {
        id: 'diag-id',
        name: 'netdiag',
        template: 'diag-id',
        description: '网络排查沙箱',
        envType: 'code' as const,
        runtimeRole: 'sandbox-diag' as const,
        image: 'aiop/opensandbox-netdiag:dev',
        desktop: false,
        privileged: true,
        capabilities: ['kubectl', 'tcpdump'],
      },
    ];
    for (const tool of buildSandboxProfileTools(manager, profiles)) tools.register(tool);
    const rt = {
      model,
      tools,
      sandboxes: manager,
      sandboxProfiles: profiles,
      sandboxProfilesFor: (ctx: { role: string }) => profiles.filter(
        (profile) => profile.runtimeRole !== 'sandbox-diag' || ctx.role === 'platform_admin',
      ),
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'sandbox-list-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    const sandboxServer = createHttpServer(rt);
    await new Promise<void>((resolve) => sandboxServer.listen(0, '127.0.0.1', resolve));
    const sandboxBase = `http://127.0.0.1:${(sandboxServer.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };

    try {
      await fetch(`${sandboxBase}/v1/sandbox/run-command`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'session-a', command: 'echo a' }),
      });
      await fetch(`${sandboxBase}/v1/sandbox/run-command`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'session-b', profile: 'netdiag', command: 'echo b' }),
      });

      const listed = await fetch(`${sandboxBase}/v1/sandboxes`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(listed.status).toBe(200);
      const body = await listed.json() as {
        sandboxes: Array<{ id: string; sandboxId: string; key: string; sessionId: string; status: string; type: string; profile?: string; image?: string; privileged?: boolean }>;
        profiles: Array<{ name: string; image?: string; capabilities: string[] }>;
      };
      expect(body.profiles).toEqual([
        expect.objectContaining({ id: 'code-id', name: 'code', image: 'aiop/opensandbox-code:dev', capabilities: ['python', 'shell'] }),
        expect.objectContaining({ id: 'diag-id', name: 'netdiag', image: 'aiop/opensandbox-netdiag:dev', capabilities: ['kubectl', 'tcpdump'] }),
      ]);
      for (const authToken of [tenantToken, userToken]) {
        const roleListed = await fetch(`${sandboxBase}/v1/sandboxes`, {
          headers: { authorization: `Bearer ${authToken}` },
        });
        expect(roleListed.status).toBe(200);
        expect((await roleListed.json() as { profiles: Array<{ id: string }> }).profiles).toEqual([
          expect.objectContaining({ id: 'code-id' }),
        ]);
      }
      expect(body.sandboxes).toEqual([
        expect.objectContaining({
          id: 'sandbox-1', sandboxId: 'sandbox-1', sessionId: 'session-a', status: 'ready', type: 'session',
          metadata: expect.objectContaining({ tenantId: 'default', userId: expect.any(String), sessionId: 'session-a' }),
        }),
        expect.objectContaining({
          id: 'sandbox-2',
          sandboxId: 'sandbox-2',
          sessionId: 'session-b',
          status: 'ready',
          type: 'diag-id',
          profile: 'diag-id',
          image: 'diag-id',
          privileged: true,
        }),
      ]);
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
      run: async () => ({ id: '', content: '浏览器预览地址：data:text/html;charset=utf-8,%3Chtml%3E%3C%2Fhtml%3E' }),
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
        result: { content: '浏览器预览地址：/v1/browser/stream-view?sessionId=live-s1' },
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
    await localStore.createTenant({ id: 'other', name: 'Other' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'skill-import-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    await auth.createUser('default', 'tenant-admin', 'pw', 'tenant_admin');
    const uploader = await auth.createUser('default', 'uploader', 'pw', 'user');
    await auth.createUser('other', 'other-user', 'pw', 'user');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const tenantAdminToken = (await auth.login('default', 'tenant-admin', 'pw'))!;
    const uploaderToken = (await auth.login('default', 'uploader', 'pw'))!;
    const otherToken = (await auth.login('other', 'other-user', 'pw'))!;
    const skillRoot = await mkdtemp(join(tmpdir(), 'aiop-http-skill-import-'));
    await mkdir(skillRoot, { recursive: true });
    const piSkillLoader: ProductSkillLoader = vi.fn(async (env, sources) => (
      loadSourcedSkills<SkillProductRecord>(env, sources)
    ));
    const skills = new SkillRegistry(skillRoot, { loader: piSkillLoader });
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
      '.product.json': JSON.stringify({
        name: 'imported', version: '1', enabled: true, reviewed: true,
        tenantId: 'evil', allowedTenantIds: ['*'], ownerUserId: 'attacker',
        visibility: 'public', allowedRoles: ['platform_admin'],
        credentials: ['aios'], credentialFile: '../../escape.json',
      }),
      'scripts/run.sh': 'echo imported',
    }).toString('base64');

    try {
      const imported = await fetch(`${importBase}/v1/skills/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${uploaderToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'imported.zip', data: `data:application/zip;base64,${data}` }),
      });
      expect(imported.status).toBe(201);
      expect(await imported.json()).toMatchObject({
        pendingReview: true,
        product: {
          name: 'imported',
          version: '1',
          enabled: true,
          reviewed: false,
          tenantId: 'default',
          ownerUserId: uploader.id,
          visibility: 'private',
        },
      });

      const persisted = JSON.parse(await readFile(
        join(skillRoot, 'users', uploader.id, 'imported', '.product.json'), 'utf8',
      )) as Record<string, unknown>;
      expect(persisted).toEqual({
        name: 'imported', version: '1', enabled: true, reviewed: false,
        tenantId: 'default', ownerUserId: uploader.id, visibility: 'private',
      });
      expect(await skills.summariesFor({ tenantId: 'default', userId: uploader.id, role: 'user' })).not.toContain('imported');
      expect(piSkillLoader).not.toHaveBeenCalled();

      const listed = await fetch(`${importBase}/v1/tools`, {
        headers: { authorization: `Bearer ${uploaderToken}` },
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
      expect(body.tools).not.toContainEqual(expect.objectContaining({ name: 'imported' }));

      const selfReview = await fetch(`${importBase}/v1/skills/imported/review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${uploaderToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reviewed: true }),
      });
      expect(selfReview.status).toBe(403);

      const adminUploadData = storedZip({
        'SKILL.md': '---\nname: admin-owned\ndescription: Admin owned\n---\nbody',
      }).toString('base64');
      const adminUpload = await fetch(`${importBase}/v1/skills/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'admin-owned.zip', data: `data:application/zip;base64,${adminUploadData}` }),
      });
      expect(adminUpload.status).toBe(201);
      const adminSelfReview = await fetch(`${importBase}/v1/skills/admin-owned/review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reviewed: true }),
      });
      expect(adminSelfReview.status).toBe(403);
      expect(piSkillLoader).not.toHaveBeenCalled();

      const tenantGlobal = await fetch(`${importBase}/v1/skills/imported/review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tenantAdminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reviewed: true, global: true }),
      });
      expect(tenantGlobal.status).toBe(403);

      const localReview = await fetch(`${importBase}/v1/skills/imported/review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tenantAdminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reviewed: true }),
      });
      expect(localReview.status).toBe(200);
      expect(piSkillLoader).toHaveBeenCalledTimes(1);
      expect(await localReview.json()).toMatchObject({
        product: { name: 'imported', reviewed: true, tenantId: 'default', visibility: 'private' },
      });

      const listedAfterReview = await fetch(`${importBase}/v1/tools`, {
        headers: { authorization: `Bearer ${uploaderToken}` },
      }).then((response) => response.json()) as typeof body;
      expect(listedAfterReview.tools).toContainEqual(expect.objectContaining({
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
      const otherBeforeGlobal = await fetch(`${importBase}/v1/tools`, {
        headers: { authorization: `Bearer ${otherToken}` },
      }).then((response) => response.json()) as typeof body;
      expect(otherBeforeGlobal.tools).not.toContainEqual(expect.objectContaining({ name: 'imported' }));

      const repeatedLocalReview = await fetch(`${importBase}/v1/skills/imported/review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tenantAdminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reviewed: true }),
      });
      expect(repeatedLocalReview.status).toBe(409);

      const globalData = storedZip({
        'SKILL.md': '---\nname: globalized\ndescription: Global skill\n---\nbody',
      }).toString('base64');
      const globalImport = await fetch(`${importBase}/v1/skills/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${uploaderToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'globalized.zip', data: `data:application/zip;base64,${globalData}` }),
      });
      expect(globalImport.status).toBe(201);
      const globalReview = await fetch(`${importBase}/v1/skills/globalized/review`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reviewed: true, global: true }),
      });
      expect(globalReview.status).toBe(200);
      expect(await globalReview.json()).toMatchObject({
        product: { reviewed: true, allowedTenantIds: ['*'], visibility: 'public' },
      });
      const otherAfterGlobal = await fetch(`${importBase}/v1/tools`, {
        headers: { authorization: `Bearer ${otherToken}` },
      }).then((response) => response.json()) as typeof body;
      expect(otherAfterGlobal.tools).toContainEqual(expect.objectContaining({ name: 'globalized' }));
      expect(otherAfterGlobal.tools).not.toContainEqual(expect.objectContaining({ name: 'imported' }));

      const rootFiles = await fetch(`${importBase}/v1/skills/imported/files`, {
        headers: { authorization: `Bearer ${uploaderToken}` },
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
        headers: { authorization: `Bearer ${uploaderToken}` },
      });
      expect(skillMd.status).toBe(200);
      expect(await skillMd.json()).toMatchObject({
        path: 'SKILL.md',
        entry: expect.objectContaining({ path: 'SKILL.md', isDirectory: false }),
        content: expect.stringContaining('# Imported'),
      });

      const disabled = await fetch(`${importBase}/v1/skills/imported/disable`, {
        method: 'POST',
        headers: { authorization: `Bearer ${uploaderToken}` },
      });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toMatchObject({ skill: { name: 'imported', enabled: false, status: '已禁用' } });

      const disabledLoad = await fetch(`${importBase}/v1/tools/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${uploaderToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', name: 'load_skill', args: { name: 'imported' } }),
      });
      expect(disabledLoad.status).toBe(200);
      expect(await disabledLoad.json()).toMatchObject({ ok: false, result: { isError: true } });

      const enabled = await fetch(`${importBase}/v1/skills/imported/enable`, {
        method: 'POST',
        headers: { authorization: `Bearer ${uploaderToken}` },
      });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({ skill: { name: 'imported', enabled: true, status: '已启用' } });

      const rejectedDelete = await fetch(`${importBase}/v1/skills/imported`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${uploaderToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: false }),
      });
      expect(rejectedDelete.status).toBe(400);

      const deleted = await fetch(`${importBase}/v1/skills/imported`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${uploaderToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });

      const afterDelete = await fetch(`${importBase}/v1/tools`, {
        headers: { authorization: `Bearer ${uploaderToken}` },
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

describe('HTTP server 会话互斥与自动压缩', () => {
  async function makeServer(chatModel: ChatModel) {
    const localStore = new MemoryStore();
    await localStore.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store: localStore, secret: 'mutex-secret' });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const adminToken = (await auth.login('default', 'admin', 'pw'))!;
    const rt = {
      model: chatModel,
      tools: new ToolRegistry(),
      store: localStore,
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      authProvider: auth,
      jwtSecret: 'mutex-secret',
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;
    const srv = createHttpServer(rt);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` };
    return { srv, url, headers, localStore };
  }

  it('rejects a concurrent run on the same session with 409', async () => {
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => { streamStarted = resolve; });
    const slowModel: ChatModel = {
      id: 'slow',
      async *stream(input): AsyncIterable<StreamEvent> {
        streamStarted();
        const signal = (input as { signal?: AbortSignal }).signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 500);
        });
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const { srv, url, headers } = await makeServer(slowModel);
    try {
      const run = fetch(`${url}/v1/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: '长任务', sessionId: 'mutex-sess' }),
      });
      await started;

      const second = await fetch(`${url}/v1/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: '并发任务', sessionId: 'mutex-sess' }),
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toContain('正在运行');

      // 其他会话不受影响
      const other = await fetch(`${url}/v1/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: '另一个会话', sessionId: 'other-sess' }),
      });
      expect(other.status).toBe(200);
      await other.text();

      await fetch(`${url}/v1/sessions/mutex-sess/terminate`, { method: 'POST', headers });
      await (await run).text();
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('auto-compacts a long history, emits context_compacted, and persists the rewritten history', async () => {
    const chatModel: ChatModel = {
      id: 'mock',
      async *stream(): AsyncIterable<StreamEvent> {
        // 同一模型也承接摘要请求：返回的文本即摘要内容
        yield { type: 'text_delta', text: '模拟摘要或回答' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const { srv, url, headers, localStore } = await makeServer(chatModel);
    const ctx = { tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' as const };
    // 默认 200k 窗口 → 预算 152k → 触发线 ≈129k tokens；30 对消息 ≈180k tokens 超线
    for (let i = 0; i < 30; i++) {
      await localStore.appendMessage(ctx, 'compact-sess', { role: 'user', text: `问题${i} ${'x'.repeat(24_000)}` });
      await localStore.appendMessage(ctx, 'compact-sess', { role: 'assistant', text: `回答${i}` });
    }
    try {
      const r = await fetch(`${url}/v1/agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task: '继续任务', sessionId: 'compact-sess' }),
      });
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain('event: context_compacted');
      expect(body).toContain('event: done');

      const messages = await localStore.listMessages(ctx, 'compact-sess');
      // 用户输入永不吞掉：压缩区间的 27 条用户消息原样保留在摘要之前
      // + 摘要 1 条 + 保留的最近 8 条（含本轮 task）+ 本轮 assistant 1 条 = 37
      expect(messages).toHaveLength(37);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.text).toContain('问题0');
      const summaryIdx = messages.findIndex((m) => m.text?.includes('历史对话摘要'));
      expect(summaryIdx).toBeGreaterThan(0);
      expect(messages[summaryIdx]!.text).toContain('模拟摘要或回答');
      expect(messages.slice(0, summaryIdx).every((m) => m.role === 'user')).toBe(true);
      expect(messages.at(-2)!.text).toBe('继续任务');
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('HTTP server 定时任务设置', () => {
  it('reads the default and updates the scheduler max run duration', async () => {
    const initial = await fetch(`${base}/v1/settings/scheduler`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ settings: { max_run_minutes: 240 } });

    const updated = await fetch(`${base}/v1/settings/scheduler`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ max_run_minutes: 90 }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ settings: { max_run_minutes: 90 } });
    expect(await store.getSchedulerSettings({ tenantId: 'default' })).toEqual({ maxRunMs: 90 * 60_000 });

    const reread = await fetch(`${base}/v1/settings/scheduler`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await reread.json()).toEqual({ settings: { max_run_minutes: 90 } });

    const invalid = await fetch(`${base}/v1/settings/scheduler`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ max_run_minutes: 0 }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe('HTTP server MCP 管理', () => {
  async function login(username: string): Promise<string> {
    const r = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'default', username, password: 'pw' }),
    });
    return ((await r.json()) as { token: string }).token;
  }

  it('lists servers with status and tools', async () => {
    const admin = await login('admin');
    const r = await fetch(`${base}/v1/mcp/servers`, { headers: { authorization: `Bearer ${admin}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { servers: Array<Record<string, unknown>> };
    const fs = body.servers.find((s) => s.name === 'fs');
    expect(fs).toMatchObject({ transport: 'stdio', status: 'connected', tools: ['mcp__fs__echo'] });
  });

  it('requires auth to list and tenant:manage to mutate', async () => {
    const unauth = await fetch(`${base}/v1/mcp/servers`);
    expect(unauth.status).toBe(401);

    const bob = await login('bob');
    const denied = await fetch(`${base}/v1/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob}` },
      body: JSON.stringify({ name: 'x', config: { transport: 'stdio', command: 'x' } }),
    });
    expect(denied.status).toBe(403);
  });

  it('validates add payload', async () => {
    const admin = await login('admin');
    const post = (payload: unknown) => fetch(`${base}/v1/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify(payload),
    });

    expect((await post({ config: { transport: 'stdio', command: 'x' } })).status).toBe(400); // 缺 name
    expect((await post({ name: 'a__b', config: { transport: 'stdio', command: 'x' } })).status).toBe(400); // 连续下划线
    expect((await post({ name: 'x', config: { transport: 'ws' } })).status).toBe(400); // transport 非法
    expect((await post({ name: 'x', config: { transport: 'stdio' } })).status).toBe(400); // stdio 缺 command
    expect((await post({ name: 'x', config: { transport: 'sse' } })).status).toBe(400); // sse 缺 url
    expect((await post({ name: 'fs', config: { transport: 'stdio', command: 'x' } })).status).toBe(409); // 重名
  });

  it('adds a server, registers tools, persists, then deletes', async () => {
    const admin = await login('admin');
    const created = await fetch(`${base}/v1/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ name: 'extra', config: { transport: 'stdio', command: 'fake' } }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { server: Record<string, unknown> };
    expect(createdBody.server).toMatchObject({ name: 'extra', status: 'connected', tools: ['mcp__extra__echo'] });

    // 工具进入注册表，可直接调用
    const call = await fetch(`${base}/v1/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ sessionId: 'mcp-test', name: 'mcp__extra__echo', args: { text: 'hi' } }),
    });
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as { ok: boolean; result: { content: string } };
    expect(callBody.ok).toBe(true);
    expect(callBody.result.content).toContain('echo:');

    // 配置已持久化
    expect(await store.getMcpServers({ tenantId: 'default' })).toMatchObject({
      extra: { transport: 'stdio', command: 'fake' },
    });

    const removed = await fetch(`${base}/v1/mcp/servers/extra`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(removed.status).toBe(200);
    const afterDelete = await store.getMcpServers({ tenantId: 'default' });
    expect(afterDelete && 'extra' in afterDelete).toBe(false);

    const gone = await fetch(`${base}/v1/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ sessionId: 'mcp-test', name: 'mcp__extra__echo', args: {} }),
    });
    expect(gone.status).toBe(409);

    const missing = await fetch(`${base}/v1/mcp/servers/extra`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(missing.status).toBe(404);
  });

  it('keeps failed servers in error state and supports reconnect', async () => {
    const admin = await login('admin');
    const created = await fetch(`${base}/v1/mcp/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ name: 'down1', config: { transport: 'http', url: 'http://x' } }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { server: Record<string, unknown> };
    expect(createdBody.server).toMatchObject({ name: 'down1', status: 'error' });
    expect(String(createdBody.server.error)).toContain('connect refused');

    const reconnected = await fetch(`${base}/v1/mcp/servers/down1/reconnect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(reconnected.status).toBe(200);
    const reconnectedBody = (await reconnected.json()) as { server: Record<string, unknown> };
    expect(reconnectedBody.server).toMatchObject({ name: 'down1', status: 'error' }); // mock 仍拒绝

    const unknown = await fetch(`${base}/v1/mcp/servers/nope/reconnect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(unknown.status).toBe(404);

    // 清理，避免影响其他用例
    await fetch(`${base}/v1/mcp/servers/down1`, { method: 'DELETE', headers: { authorization: `Bearer ${admin}` } });
  });
});

describe('HTTP server 定时任务管理', () => {
  async function adminToken(): Promise<string> {
    const r = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'default', username: 'admin', password: 'pw' }),
    });
    return ((await r.json()) as { token: string }).token;
  }

  async function createTask(token: string): Promise<number> {
    const r = await fetch(`${base}/v1/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ cron: '0 3 * * *', task: '巡检测试' }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { task: { id: number } }).task.id;
  }

  it('PATCH updates fields, validates cron, recomputes next run', async () => {
    const token = await adminToken();
    const id = await createTask(token);
    const patch = (payload: unknown) => fetch(`${base}/v1/schedule/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });

    expect((await patch({ cron: 'nope' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);

    const ok = await patch({ cron: '0 4 * * *', task: '更新后的巡检', enabled: false });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { task: { cron: string; task: string; enabled: boolean; nextRunAt: string } };
    expect(body.task).toMatchObject({ cron: '0 4 * * *', task: '更新后的巡检', enabled: false });
    expect(new Date(body.task.nextRunAt).getUTCHours()).toBe(4);

    const missing = await fetch(`${base}/v1/schedule/99999`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'x' }),
    });
    expect(missing.status).toBe(404);
  });

  it('DELETE removes task and its runs; 404 afterwards', async () => {
    const token = await adminToken();
    const id = await createTask(token);
    await store.recordTaskRun({ taskId: id, status: 'success', detail: 'ok' });

    const del = await fetch(`${base}/v1/schedule/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(200);

    const listed = await fetch(`${base}/v1/schedule`, { headers: { authorization: `Bearer ${token}` } });
    const tasks = ((await listed.json()) as { tasks: Array<{ id: number }> }).tasks;
    expect(tasks.some((t) => t.id === id)).toBe(false);
    expect(await store.listTaskRuns({ tenantId: 'default', userId: 'u_default_admin', role: 'platform_admin' }, id)).toHaveLength(0);

    const again = await fetch(`${base}/v1/schedule/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.status).toBe(404);
  });

  it('POST /run triggers an immediate run recorded in task_runs', async () => {
    const token = await adminToken();
    const id = await createTask(token);

    const run = await fetch(`${base}/v1/schedule/${id}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(run.status).toBe(202);
    expect(await run.json()).toMatchObject({ ok: true, taskId: id, started: true });

    // 异步执行：轮询 task_runs 直到出现结果
    let runs: Array<{ status: string; detail?: string }> = [];
    for (let i = 0; i < 50 && !runs.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const r = await fetch(`${base}/v1/schedule/${id}/runs`, { headers: { authorization: `Bearer ${token}` } });
      runs = ((await r.json()) as { runs: typeof runs }).runs;
    }
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]!.status).toBe('success');
    expect(runs[0]!.detail).toBeTruthy(); // mock 模型输出（具体内容取决于当前激活的 mock 模型）

    const missing = await fetch(`${base}/v1/schedule/99999/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });
});

type SandboxSettingsState = {
  settings: SandboxSettings;
  apiKeySet: boolean;
  runtime?: {
    enabled: boolean;
    mode?: SandboxSettings['mode'];
    status?: string;
    templateCount?: number;
    lastSuccessfulRefreshAt?: string;
  };
};

type SandboxTemplateRefreshResult = {
  changed: boolean;
  templateCount: number;
  state: SandboxSettingsState;
};

type SandboxSettingsUpdate = {
  settings: SandboxSettings;
  keyAction:
    | { action: 'retain' }
    | { action: 'replace'; apiKey: string }
    | { action: 'clear' };
};

async function createSandboxSettingsHttpServer(options: {
  initial?: SandboxSettingsState;
  apply?: (input: SandboxSettingsUpdate) => Promise<SandboxSettingsState>;
  refresh?: () => Promise<SandboxTemplateRefreshResult>;
} = {}) {
  const localStore = new MemoryStore();
  await localStore.createTenant({ id: 'default', name: 'Default' });
  const auth = new LocalAuthProvider({ store: localStore, secret: 'sandbox-settings-http-secret' });
  await auth.createUser('default', 'platform', 'pw', 'platform_admin');
  await auth.createUser('default', 'tenant', 'pw', 'tenant_admin');
  await auth.createUser('default', 'user', 'pw', 'user');
  const platformToken = (await auth.login('default', 'platform', 'pw'))!;
  const tenantToken = (await auth.login('default', 'tenant', 'pw'))!;
  const userToken = (await auth.login('default', 'user', 'pw'))!;
  const auditEvents: Array<Record<string, unknown>> = [];
  let state: SandboxSettingsState = options.initial ?? {
    settings: { enabled: false, mode: 'local' },
    apiKeySet: false,
    runtime: { enabled: false, mode: 'local', status: 'disabled' },
  };
  const getSandboxSettings = vi.fn(async () => state);
  const updateSandbox = vi.fn(async (input: SandboxSettingsUpdate) => {
    if (options.apply) return options.apply(input);
    state = {
      settings: input.settings,
      apiKeySet: input.keyAction.action === 'replace'
        ? true
        : input.keyAction.action === 'clear'
          ? false
          : state.apiKeySet,
      runtime: {
        enabled: input.settings.enabled,
        mode: input.settings.mode,
        status: input.settings.enabled ? 'active' : 'disabled',
      },
    };
    return state;
  });
  const refreshSandboxTemplates = vi.fn(async () => {
    if (options.refresh) return options.refresh();
    return { changed: false, templateCount: state.runtime?.templateCount ?? 0, state };
  });
  const rt = {
    model,
    tools: new ToolRegistry(),
    store: localStore,
    audit: { record: async (event: Record<string, unknown>) => { auditEvents.push(event); } },
    policy: new AllowAllPolicy(),
    policyPreApproved: new AllowAllPolicy(),
    authProvider: auth,
    jwtSecret: 'sandbox-settings-http-secret',
    systemExtra: '',
    defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    getSandboxSettings,
    updateSandbox,
    refreshSandboxTemplates,
  } as unknown as Runtime;
  const localServer = createHttpServer(rt);
  await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const localBase = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`;
  return {
    base: localBase,
    platformToken,
    tenantToken,
    userToken,
    auditEvents,
    getSandboxSettings,
    updateSandbox,
    refreshSandboxTemplates,
    close: () => new Promise<void>((resolve) => localServer.close(() => resolve())),
  };
}

describe('HTTP server 平台 Sandbox 设置', () => {
  it('allows only platform admins and returns platform-scoped non-secret settings', async () => {
    const fixture = await createSandboxSettingsHttpServer({
      initial: {
        settings: {
          enabled: true,
          mode: 'aios_lifecycle',
          lifecycleUrl: 'https://sandbox.example.test/lifecycle',
          placement: { clusterId: 'local', namespace: 'sandbox-system' },
        },
        apiKeySet: true,
        runtime: { enabled: true, mode: 'aios_lifecycle', status: 'active' },
        apiKey: 'hidden-value',
        encryptedApiKey: 'hidden-envelope',
      } as SandboxSettingsState,
    });
    try {
      const denied = await fetch(`${fixture.base}/v1/settings/sandbox`, {
        headers: { authorization: `Bearer ${fixture.tenantToken}` },
      });
      expect(denied.status).toBe(403);

      const response = await fetch(`${fixture.base}/v1/settings/sandbox`, {
        headers: { authorization: `Bearer ${fixture.platformToken}` },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        scope: 'platform',
        settings: {
          enabled: true,
          mode: 'aios_lifecycle',
          lifecycle_url: 'https://sandbox.example.test/lifecycle',
          placement: { cluster_id: 'local', namespace: 'sandbox-system' },
          api_key_set: true,
        },
        runtime: { enabled: true, mode: 'aios_lifecycle', status: 'active' },
      });
      expect(text).not.toContain('hidden-value');
      expect(text).not.toContain('hidden-envelope');
      expect(text).not.toContain('api_key_preview');
      expect(text).not.toContain('encrypted');
    } finally {
      await fixture.close();
    }
  });

  it('serializes non-sensitive catalog runtime status fields', async () => {
    const fixture = await createSandboxSettingsHttpServer({
      initial: {
        settings: {
          enabled: true,
          mode: 'aios_lifecycle',
          lifecycleUrl: 'https://sandbox.example.test/lifecycle',
          placement: { clusterId: 'local', namespace: 'sandbox-system' },
        },
        apiKeySet: true,
        runtime: {
          enabled: true,
          mode: 'aios_lifecycle',
          status: 'active',
          templateCount: 3,
          lastSuccessfulRefreshAt: '2026-07-16T10:00:00.000Z',
        },
      },
    });
    try {
      const response = await fetch(`${fixture.base}/v1/settings/sandbox`, {
        headers: { authorization: `Bearer ${fixture.platformToken}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { runtime: Record<string, unknown> };
      expect(body.runtime).toEqual({
        enabled: true,
        mode: 'aios_lifecycle',
        status: 'active',
        template_count: 3,
        last_successful_refresh_at: '2026-07-16T10:00:00.000Z',
      });
      expect(body.runtime).not.toHaveProperty('fingerprint');
    } finally {
      await fixture.close();
    }
  });

  it('refreshes AIOS templates only for platform admins and audits safe details', async () => {
    const state: SandboxSettingsState = {
      settings: {
        enabled: true,
        mode: 'aios_lifecycle',
        lifecycleUrl: 'https://sandbox.example.test/lifecycle',
        placement: { clusterId: 'cluster-a', namespace: 'sandbox-system' },
      },
      apiKeySet: true,
      runtime: {
        enabled: true,
        mode: 'aios_lifecycle',
        status: 'active',
        templateCount: 3,
        lastSuccessfulRefreshAt: '2026-07-16T10:00:00.000Z',
      },
    };
    const fixture = await createSandboxSettingsHttpServer({
      initial: state,
      refresh: async () => ({ changed: true, templateCount: 3, state }),
    });
    const refresh = (token?: string) => fetch(
      `${fixture.base}/v1/settings/sandbox/refresh-templates`,
      {
        method: 'POST',
        headers: token
          ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
          : { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    try {
      expect((await refresh()).status).toBe(401);
      expect((await refresh(fixture.userToken)).status).toBe(403);
      expect((await refresh(fixture.tenantToken)).status).toBe(403);
      expect(fixture.refreshSandboxTemplates).not.toHaveBeenCalled();

      const response = await refresh(fixture.platformToken);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        scope: 'platform',
        settings: {
          enabled: true,
          mode: 'aios_lifecycle',
          lifecycle_url: 'https://sandbox.example.test/lifecycle',
          placement: { cluster_id: 'cluster-a', namespace: 'sandbox-system' },
          api_key_set: true,
        },
        runtime: {
          enabled: true,
          mode: 'aios_lifecycle',
          status: 'active',
          template_count: 3,
          last_successful_refresh_at: '2026-07-16T10:00:00.000Z',
        },
        refresh: { changed: true, template_count: 3 },
      });
      expect(fixture.refreshSandboxTemplates).toHaveBeenCalledTimes(1);
      expect(fixture.auditEvents).toEqual([
        expect.objectContaining({
          kind: 'sandbox',
          action: 'sandbox-templates-refreshed',
          tenantId: 'default',
          detail: { mode: 'aios_lifecycle', changed: true, templateCount: 3 },
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it('returns sanitized refresh errors and rejects unsupported runtimes', async () => {
    const failed = await createSandboxSettingsHttpServer({
      initial: {
        settings: {
          enabled: true,
          mode: 'aios_lifecycle',
          lifecycleUrl: 'https://sandbox.example.test/lifecycle',
          placement: { clusterId: 'cluster-a', namespace: 'sandbox-system' },
        },
        apiKeySet: true,
      },
      refresh: async () => {
        throw new Error('remote body contained X-API-KEY and secret-value');
      },
    });
    try {
      const response = await fetch(`${failed.base}/v1/settings/sandbox/refresh-templates`, {
        method: 'POST',
        headers: { authorization: `Bearer ${failed.platformToken}` },
      });
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain('AIOS 模板目录刷新失败');
      expect(text).not.toContain('X-API-KEY');
      expect(text).not.toContain('secret-value');
      expect(failed.auditEvents).toHaveLength(0);
    } finally {
      await failed.close();
    }

    const unsupported = await createSandboxSettingsHttpServer({
      initial: {
        settings: { enabled: false, mode: 'local' },
        apiKeySet: false,
        runtime: { enabled: false, mode: 'local', status: 'disabled' },
      },
    });
    try {
      const response = await fetch(`${unsupported.base}/v1/settings/sandbox/refresh-templates`, {
        method: 'POST',
        headers: { authorization: `Bearer ${unsupported.platformToken}` },
      });
      expect(response.status).toBe(409);
      expect(unsupported.refreshSandboxTemplates).not.toHaveBeenCalled();
    } finally {
      await unsupported.close();
    }
  });

  it('parses all four modes and translates mode-specific fields', async () => {
    const fixture = await createSandboxSettingsHttpServer();
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${fixture.platformToken}`,
    };
    try {
      const inputs = [
        {
          body: { enabled: true, mode: 'standard_e2b', domain: 'E2B.EXAMPLE.TEST', api_key: 'standard-key' },
          settings: { enabled: true, mode: 'standard_e2b', domain: 'e2b.example.test' },
        },
        {
          body: {
            enabled: true,
            mode: 'aios_lifecycle',
            lifecycle_url: 'https://AIOS.EXAMPLE.TEST/lifecycle/',
            placement: { cluster_id: 'cluster-a', namespace: 'sandbox-system' },
            api_key: 'aios-key',
          },
          settings: {
            enabled: true,
            mode: 'aios_lifecycle',
            lifecycleUrl: 'https://aios.example.test/lifecycle',
            placement: { clusterId: 'cluster-a', namespace: 'sandbox-system' },
          },
        },
        {
          body: {
            enabled: true,
            mode: 'opensandbox',
            domain: 'OPEN.EXAMPLE.TEST:8080',
            protocol: 'https',
            default_image: 'code-image',
          },
          settings: {
            enabled: true,
            mode: 'opensandbox',
            domain: 'open.example.test:8080',
            protocol: 'https',
            defaultImage: 'code-image',
          },
        },
        {
          body: { enabled: false, mode: 'local' },
          settings: { enabled: false, mode: 'local' },
        },
      ] as const;

      for (const input of inputs) {
        const response = await fetch(`${fixture.base}/v1/settings/sandbox`, {
          method: 'POST',
          headers,
          body: JSON.stringify(input.body),
        });
        expect(response.status).toBe(200);
        expect(fixture.updateSandbox.mock.calls.at(-1)?.[0].settings).toEqual(input.settings);
        const text = await response.text();
        expect(text).not.toContain('api_key_preview');
        expect(text).not.toContain('standard-key');
        expect(text).not.toContain('aios-key');
      }
    } finally {
      await fixture.close();
    }
  });

  it('enforces retain, replace, and explicit clear key semantics', async () => {
    const fixture = await createSandboxSettingsHttpServer({
      initial: {
        settings: { enabled: false, mode: 'standard_e2b', domain: 'e2b.example.test' },
        apiKeySet: true,
      },
    });
    const post = (body: Record<string, unknown>) => fetch(`${fixture.base}/v1/settings/sandbox`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${fixture.platformToken}`,
      },
      body: JSON.stringify(body),
    });
    try {
      expect((await post({ enabled: false, mode: 'standard_e2b', domain: 'e2b.example.test' })).status).toBe(200);
      expect(fixture.updateSandbox.mock.calls.at(-1)?.[0].keyAction).toEqual({ action: 'retain' });

      expect((await post({
        enabled: true,
        mode: 'standard_e2b',
        domain: 'e2b.example.test',
        api_key: 'replacement-key',
      })).status).toBe(200);
      expect(fixture.updateSandbox.mock.calls.at(-1)?.[0].keyAction).toEqual({
        action: 'replace',
        apiKey: 'replacement-key',
      });

      expect((await post({ enabled: false, mode: 'standard_e2b', domain: 'e2b.example.test', clear_api_key: true })).status).toBe(200);
      expect(fixture.updateSandbox.mock.calls.at(-1)?.[0].keyAction).toEqual({ action: 'clear' });

      const calls = fixture.updateSandbox.mock.calls.length;
      expect((await post({ enabled: false, mode: 'local', api_key: '' })).status).toBe(400);
      expect((await post({ enabled: false, mode: 'local', api_key: 'new-key' })).status).toBe(400);
      expect((await post({ enabled: false, mode: 'local', api_key: 'new-key', clear_api_key: true })).status).toBe(400);
      expect((await post({
        enabled: true,
        mode: 'standard_e2b',
        domain: 'e2b.example.test',
        clear_api_key: true,
      })).status).toBe(400);
      expect((await post({
        enabled: true,
        mode: 'aios_lifecycle',
        lifecycle_url: 'https://sandbox.example.test/lifecycle',
        placement: { cluster_id: 'local', namespace: 'sandbox-system' },
        clear_api_key: true,
      })).status).toBe(400);
      expect(fixture.updateSandbox).toHaveBeenCalledTimes(calls);
    } finally {
      await fixture.close();
    }
  });

  it('rejects mixed fields and returns safe apply errors without changing the old state', async () => {
    const oldState: SandboxSettingsState = {
      settings: { enabled: false, mode: 'local' },
      apiKeySet: false,
      runtime: { enabled: false, mode: 'local', status: 'disabled' },
    };
    const fixture = await createSandboxSettingsHttpServer({
      initial: oldState,
      apply: async () => { throw new Error('persistence failed with internal detail'); },
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${fixture.platformToken}`,
    };
    try {
      const mixed = await fetch(`${fixture.base}/v1/settings/sandbox`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: false, mode: 'local', lifecycle_url: 'https://unexpected.example.test' }),
      });
      expect(mixed.status).toBe(400);
      expect(fixture.updateSandbox).not.toHaveBeenCalled();

      const failed = await fetch(`${fixture.base}/v1/settings/sandbox`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: false, mode: 'opensandbox', domain: 'new.example.test' }),
      });
      expect(failed.status).toBe(500);
      const failedText = await failed.text();
      expect(failedText).toContain('沙箱配置应用失败');
      expect(failedText).not.toContain('internal detail');

      const reread = await fetch(`${fixture.base}/v1/settings/sandbox`, {
        headers: { authorization: `Bearer ${fixture.platformToken}` },
      });
      expect(await reread.json()).toMatchObject({ scope: 'platform', settings: { enabled: false, mode: 'local' } });
      expect(fixture.auditEvents).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it('maps endpoint-binding validation to 400 and audits only non-sensitive details on success', async () => {
    const fixture = await createSandboxSettingsHttpServer({
      initial: {
        settings: { enabled: false, mode: 'standard_e2b', domain: 'old.example.test' },
        apiKeySet: true,
      },
      apply: async (input) => {
        if (input.keyAction.action === 'retain') {
          throw new Error('Sandbox 凭据目标已变化，请重新输入或清除 API key');
        }
        return {
          settings: input.settings,
          apiKeySet: true,
          runtime: { enabled: input.settings.enabled, mode: input.settings.mode, status: 'active' },
        };
      },
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${fixture.platformToken}`,
    };
    try {
      const rejected = await fetch(`${fixture.base}/v1/settings/sandbox`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: false, mode: 'standard_e2b', domain: 'new.example.test' }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: 'Sandbox 凭据目标已变化，请重新输入或清除 API key' });

      const replaced = await fetch(`${fixture.base}/v1/settings/sandbox`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          enabled: true,
          mode: 'aios_lifecycle',
          lifecycle_url: 'https://sandbox.example.test/lifecycle',
          placement: { cluster_id: 'cluster-a', namespace: 'sandbox-system' },
          api_key: 'replacement-key',
        }),
      });
      expect(replaced.status).toBe(200);
      expect(fixture.auditEvents).toHaveLength(1);
      expect(fixture.auditEvents[0]).toMatchObject({
        kind: 'sandbox',
        action: 'sandbox-settings-updated',
        tenantId: 'default',
        detail: {
          enabled: true,
          mode: 'aios_lifecycle',
          endpoint: 'https://sandbox.example.test/lifecycle',
          placement: { clusterId: 'cluster-a', namespace: 'sandbox-system' },
          keyAction: 'replace',
        },
      });
      expect(JSON.stringify(fixture.auditEvents)).not.toContain('replacement-key');
    } finally {
      await fixture.close();
    }
  });
});
