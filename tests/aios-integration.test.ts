import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MemoryStore } from '../src/db/memory.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { AiosAuthProvider, AiosAuthError, parseAiosExpiry } from '../src/auth/aios.js';
import { UserCredentials } from '../src/auth/credentials.js';
import { softDeleteUser, setUserEnabled } from '../src/auth/lifecycle.js';
import { AuthzError } from '../src/auth/rbac.js';
import { AiosConfigSchema } from '../src/config/schema.js';
import { SkillRegistry } from '../src/skill/registry.js';
import { createHttpServer } from '../src/server/http.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { Runtime } from '../src/runtime.js';
import type { RequestContext } from '../src/auth/types.js';

const SECRET = 'aios-test-secret';

async function writeSkillProduct(path: string, metadata: Record<string, unknown>): Promise<void> {
  await writeFile(join(path, '.product.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

function aiosProvider(store: MemoryStore, credentials: UserCredentials, userinfo: () => Promise<Response>) {
  const config = AiosConfigSchema.parse({
    verify: 'userinfo',
    userinfoUrl: 'http://aios.test/userinfo',
    adminRoles: ['admin'],
    allowedParentOrigins: ['https://aios.example.com'],
  });
  return new AiosAuthProvider({
    store,
    secret: SECRET,
    config,
    credentials,
    fetchImpl: (() => userinfo()) as typeof fetch,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AiosAuthProvider（token exchange + direct identity）', () => {
  it('exchange 验证 accountId、保持 users 不变、缓存凭据并签发可校验 JWT', async () => {
    const store = new MemoryStore();
    const credentials = new UserCredentials(store, SECRET);
    const provider = aiosProvider(store, credentials, async () =>
      jsonResponse({ code: 0, data: { accountId: '1001', displayName: '张三', status: 'active', roles: ['admin'] } }));

    const tokenData = { token: 'aios-tk-1', refreshToken: 'rf-1', expiredTime: '2099-01-01T00:00:00+0800' };
    const before = await store.listUsers('default');
    const { token, ctx } = await provider.exchange(tokenData);

    expect(ctx).toMatchObject({ tenantId: 'default', userId: '1001', provider: 'aios', role: 'tenant_admin', displayName: '张三' });
    expect(await store.listUsers('default')).toEqual(before);
    expect(await provider.authenticate(token)).toMatchObject(ctx);
    expect(await provider.authenticate(token)).toMatchObject(ctx); // 每请求都重新调用可信 userinfo

    const cached = await credentials.get<typeof tokenData>('default', '1001', 'aios');
    expect(cached).toMatchObject({ token: 'aios-tk-1', refreshToken: 'rf-1' });
    const raw = await store.getUserCredential('default', '1001', 'aios');
    expect(raw!.payload).not.toContain('aios-tk-1');

    const again = await provider.exchange(tokenData);
    expect(again.ctx.userId).toBe('1001');
    expect(await store.listUsers('default')).toEqual(before);
  });

  it('普通角色映射 user；AIOS 校验失败则拒绝', async () => {
    const store = new MemoryStore();
    const credentials = new UserCredentials(store, SECRET);
    let ok = true;
    const provider = aiosProvider(store, credentials, async () =>
      ok ? jsonResponse({ data: { accountId: '2', status: 'active', roles: ['dev'] } }) : jsonResponse({ error: 'x' }, 401));

    const { ctx } = await provider.exchange({ token: 't' });
    expect(ctx.role).toBe('user');

    ok = false;
    await expect(provider.exchange({ token: 'bad' })).rejects.toThrow(AiosAuthError);
  });

  it('accountId 非规范十进制或可信状态 disabled 时 fail closed', async () => {
    const store = new MemoryStore();
    const credentials = new UserCredentials(store, SECRET);
    let body: unknown = { data: { accountId: '03', status: 'active', roles: [] } };
    const provider = aiosProvider(store, credentials, async () => jsonResponse(body));

    await expect(provider.exchange({ token: 't' })).rejects.toThrow('合法 accountId');
    body = { data: { accountId: '3', status: 'disabled', roles: [] } };
    const configured = new AiosAuthProvider({
      store,
      credentials,
      secret: SECRET,
      config: AiosConfigSchema.parse({
        verify: 'userinfo', userinfoUrl: 'http://aios.test/userinfo', fields: { status: 'status' },
      }),
      fetchImpl: (async () => jsonResponse(body)) as typeof fetch,
    });
    await expect(configured.exchange({ token: 't' })).rejects.toThrow('已被禁用');
  });

  it('exchange 在签发 session 前拒绝非法或已过期 expiredTime，缺失时使用服务端 TTL', async () => {
    const store = new MemoryStore();
    const credentials = new UserCredentials(store, SECRET);
    const provider = aiosProvider(store, credentials, async () =>
      jsonResponse({ data: { accountId: '8', status: 'active', roles: [] } }));

    await expect(provider.exchange({ token: 't', expiredTime: 'not-a-date' })).rejects.toThrow('格式非法');
    await expect(provider.exchange({ token: 't', expiredTime: '2000-01-01T00:00:00Z' })).rejects.toThrow('已过期');
    expect(await credentials.get('default', '8', 'aios')).toBeUndefined();

    const exchanged = await provider.exchange({ token: 't' });
    expect(await provider.authenticate(exchanged.token)).toMatchObject({ userId: '8' });
  });

  it('parseAiosExpiry 兼容 +0800 时区写法', () => {
    expect(parseAiosExpiry('2099-01-02T03:04:05+0800')!.toISOString()).toBe('2099-01-01T19:04:05.000Z');
    expect(parseAiosExpiry('not-a-date')).toBeUndefined();
    expect(parseAiosExpiry(undefined)).toBeUndefined();
  });
});

describe('UserCredentials（加密缓存）', () => {
  it('过期凭据视为缺失', async () => {
    const store = new MemoryStore();
    const credentials = new UserCredentials(store, SECRET);
    await credentials.set('t1', 'u1', 'aios', { token: 'x' }, new Date(Date.now() - 1000));
    expect(await credentials.get('t1', 'u1', 'aios')).toBeUndefined();
  });

  it('clear 清除某用户全部凭据', async () => {
    const store = new MemoryStore();
    const credentials = new UserCredentials(store, SECRET);
    await credentials.set('t1', 'u1', 'aios', { token: 'x' });
    await credentials.clear('t1', 'u1');
    expect(await credentials.get('t1', 'u1', 'aios')).toBeUndefined();
  });
});

describe('AIOS integrated debug local login', () => {
  async function startDebugServer(enabled: boolean) {
    const store = new MemoryStore();
    await store.createTenant({ id: 'default', name: 'Default' });
    const local = new LocalAuthProvider({ store, secret: SECRET });
    const localUser = await local.createUser('default', 'admin', 'pw', 'tenant_admin');
    await store.createUser({
      tenantId: 'default', username: 'aios-name', role: 'user', passwordHash: 'not-a-password', authProvider: 'aios',
    });
    const credentials = new UserCredentials(store, SECRET);
    const aios = aiosProvider(store, credentials, async () =>
      jsonResponse({ data: { accountId: '901', displayName: '平台用户', status: 'active', roles: [] } }));
    const auditEvents: Array<Record<string, unknown>> = [];
    const rt = {
      tools: new ToolRegistry(), store,
      audit: { record: async (event: Record<string, unknown>) => { auditEvents.push(event); } },
      policy: new AllowAllPolicy(), policyPreApproved: new AllowAllPolicy(),
      deploymentMode: 'aios-integrated', authProvider: aios, aiosAuth: aios,
      ...(enabled ? { debugLocalAuth: local } : {}), credentials, jwtSecret: SECRET, systemExtra: '',
      defaultContext: { tenantId: 'default', userId: '1', role: 'platform_admin' as const },
    } as unknown as Runtime;
    const server = createHttpServer(rt);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { store, local, localUser, aios, auditEvents, server, base };
  }

  it('is closed by default and exposes anonymous capabilities', async () => {
    const env = await startDebugServer(false);
    try {
      const capabilities = await fetch(`${env.base}/v1/auth/capabilities`);
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({
        deploymentMode: 'aios-integrated', authProvider: 'aios',
        capabilities: { aiosExchange: true, localLogin: false },
      });
      const login = await fetch(`${env.base}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'default', username: 'admin', password: 'pw' }),
      });
      expect(login.status).toBe(404);
      const localToken = await env.local.login('default', 'admin', 'pw');
      const me = await fetch(`${env.base}/v1/me`, { headers: { authorization: `Bearer ${localToken}` } });
      expect(me.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => env.server.close(() => resolve()));
    }
  });

  it('allows only active local users, audits success, and keeps local user management disabled', async () => {
    const env = await startDebugServer(true);
    try {
      const capabilities = await fetch(`${env.base}/v1/auth/capabilities`).then((r) => r.json());
      expect(capabilities).toMatchObject({ capabilities: { aiosExchange: true, localLogin: true } });
      const wrong = await fetch(`${env.base}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'default', username: 'admin', password: 'wrong' }),
      });
      expect(wrong.status).toBe(401);
      const nonLocal = await fetch(`${env.base}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'default', username: 'aios-name', password: 'anything' }),
      });
      expect(nonLocal.status).toBe(401);
      const login = await fetch(`${env.base}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'default', username: 'admin', password: 'pw' }),
      });
      expect(login.status).toBe(200);
      const token = (await login.json() as { token: string }).token;
      const me = await fetch(`${env.base}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(await me.json()).toMatchObject({
        userId: env.localUser.id, authProvider: 'local',
        features: { localLogin: true, localUserManagement: false },
      });
      expect(env.auditEvents.find((event) => event.action === 'aios-debug-local-login')).toMatchObject({
        provider: 'local', deploymentMode: 'aios-integrated', userId: env.localUser.id,
      });
    } finally {
      await new Promise<void>((resolve) => env.server.close(() => resolve()));
    }
  });

  it('routes signed JWT by provider claim without fallback', async () => {
    const env = await startDebugServer(true);
    try {
      const localToken = await env.local.login('default', 'admin', 'pw');
      const localSpy = vi.spyOn(env.local, 'authenticate');
      const aiosSpy = vi.spyOn(env.aios, 'authenticate');
      expect((await fetch(`${env.base}/v1/me`, { headers: { authorization: `Bearer ${localToken}` } })).status).toBe(200);
      expect(localSpy).toHaveBeenCalledTimes(1);
      expect(aiosSpy).not.toHaveBeenCalled();

      const exchanged = await env.aios.exchange({ token: 'platform-token' });
      localSpy.mockClear();
      aiosSpy.mockClear();
      expect((await fetch(`${env.base}/v1/me`, { headers: { authorization: `Bearer ${exchanged.token}` } })).status).toBe(200);
      expect(aiosSpy).toHaveBeenCalledTimes(1);
      expect(localSpy).not.toHaveBeenCalled();

      await env.store.deleteUserCredentials('default', '901');
      localSpy.mockClear();
      aiosSpy.mockClear();
      expect((await fetch(`${env.base}/v1/me`, { headers: { authorization: `Bearer ${exchanged.token}` } })).status).toBe(401);
      expect(aiosSpy).toHaveBeenCalledTimes(1);
      expect(localSpy).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => env.server.close(() => resolve()));
    }
  });
});

describe('会话按用户隔离（MemoryStore）', () => {
  const ctxA: RequestContext = { tenantId: 't1', userId: 'ua', role: 'user' };
  const ctxB: RequestContext = { tenantId: 't1', userId: 'ub', role: 'user' };

  it('同租户不同用户的会话与消息互不可见', async () => {
    const store = new MemoryStore();
    await store.appendMessage(ctxA, 's-1', { role: 'user', text: 'A 的私密问题' });

    expect(await store.listMessages(ctxB, 's-1')).toEqual([]);
    expect((await store.listSessions(ctxB)).map((s) => s.sessionId)).toEqual([]);
    expect(await store.countSessions(ctxB)).toBe(0);
    // B 用 A 的 sessionId 删除 → 无效
    expect(await store.deleteSession(ctxB, 's-1')).toBe(false);
    expect((await store.listMessages(ctxA, 's-1')).length).toBe(1);

    // B 写入同名 sessionId 只落到自己名下，不污染 A
    await store.appendMessage(ctxB, 's-1', { role: 'user', text: 'B 的问题' });
    expect((await store.listMessages(ctxA, 's-1'))[0]!.text).toBe('A 的私密问题');
    expect((await store.listMessages(ctxB, 's-1'))[0]!.text).toBe('B 的问题');
  });

  it('定时任务：普通用户仅见自己的，管理员见全租户', async () => {
    const store = new MemoryStore();
    const taskA = await store.createScheduledTask(ctxA, { sessionId: 's', cron: '0 * * * *', task: 'A 的任务' });
    await store.createScheduledTask(ctxB, { sessionId: 's', cron: '0 * * * *', task: 'B 的任务' });

    expect((await store.listScheduledTasks(ctxA)).map((t) => t.task)).toEqual(['A 的任务']);
    expect(await store.getScheduledTask(ctxB, taskA.id)).toBeUndefined();
    expect(await store.deleteScheduledTask(ctxB, taskA.id)).toBe(false);

    const admin: RequestContext = { tenantId: 't1', userId: 'boss', role: 'tenant_admin' };
    expect((await store.listScheduledTasks(admin)).length).toBe(2);
  });
});

describe('用户生命周期（软删除 / 墓碑 / 护栏）', () => {
  async function setup() {
    const store = new MemoryStore();
    const credentials = new UserCredentials(store, SECRET);
    const admin = await store.createUser({ tenantId: 't1', username: 'boss', role: 'tenant_admin', passwordHash: 'x' });
    const alice = await store.createUser({ tenantId: 't1', username: 'alice', role: 'user', passwordHash: 'x' });
    const adminCtx: RequestContext = { tenantId: 't1', userId: admin.id, role: 'tenant_admin' };
    return { store, credentials, admin, alice, adminCtx, deps: { store, credentials } };
  }

  it('软删除：禁用 + 清凭据 + 暂停任务，默认保留原 username（封禁语义）', async () => {
    const { store, credentials, alice, adminCtx, deps } = await setup();
    await credentials.set('t1', alice.id, 'aios', { token: 'x' });
    await store.createScheduledTask({ tenantId: 't1', userId: alice.id, role: 'user' }, { sessionId: 's', cron: '0 * * * *', task: 't' });

    const deleted = await softDeleteUser(deps, adminCtx, alice);
    expect(deleted.status).toBe('disabled');
    expect(deleted.username).toBe('alice'); // 不打墓碑：用户名占位即封禁
    expect(await credentials.get('t1', alice.id, 'aios')).toBeUndefined();
    const tasks = await store.listScheduledTasks({ tenantId: 't1', userId: alice.id, role: 'user' });
    expect(tasks.every((t) => !t.enabled)).toBe(true);
  });

  it('tombstone=true 打墓碑释放用户名；启用可恢复访问', async () => {
    const { store, alice, adminCtx, deps } = await setup();
    const deleted = await softDeleteUser(deps, adminCtx, alice, { tombstone: true });
    expect(deleted.username).toMatch(/^alice#deleted#\d+$/);

    const restored = await setUserEnabled(deps, adminCtx, deleted, true);
    expect(restored.status).toBe('active');
    void store;
  });

  it('护栏：不能删自己；租户管理员不能删管理员', async () => {
    const { store, admin, alice, adminCtx, deps } = await setup();
    await expect(softDeleteUser(deps, adminCtx, admin)).rejects.toThrow(AuthzError);

    const boss2 = await store.createUser({ tenantId: 't1', username: 'boss2', role: 'tenant_admin', passwordHash: 'x' });
    await expect(softDeleteUser(deps, adminCtx, boss2)).rejects.toThrow('仅平台管理员');

    // 普通用户对任何人都无权
    const aliceCtx: RequestContext = { tenantId: 't1', userId: alice.id, role: 'user' };
    await expect(softDeleteUser(deps, aliceCtx, admin)).rejects.toThrow(AuthzError);
  });

  it('本地登录：禁用账号拒绝登录', async () => {
    const store = new MemoryStore();
    const auth = new LocalAuthProvider({ store, secret: SECRET });
    const user = await auth.createUser('t1', 'bob', 'pw', 'user');
    expect(await auth.login('t1', 'bob', 'pw')).toBeTruthy();
    await store.updateUser('t1', user.id, { status: 'disabled' });
    expect(await auth.login('t1', 'bob', 'pw')).toBeUndefined();
  });
});

describe('SkillRegistry 所有权与可见性', () => {
  let dir: string;
  let reg: SkillRegistry;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiop-skill-vis-'));
    // 存量公共技能（旧布局：根目录，原地视为 public）
    await mkdir(join(dir, 'legacy'), { recursive: true });
    await writeFile(join(dir, 'legacy', 'SKILL.md'), '---\nname: legacy\ndescription: 存量技能\n---\n正文');
    await writeSkillProduct(join(dir, 'legacy'), {
      name: 'legacy', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', visibility: 'public',
    });
    // 管理员上传的公共技能（带 .owner）
    await mkdir(join(dir, '_public', 'pub'), { recursive: true });
    await writeFile(join(dir, '_public', 'pub', 'SKILL.md'), '---\nname: pub\ndescription: 公共技能\n---\n正文');
    await writeSkillProduct(join(dir, '_public', 'pub'), {
      name: 'pub', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'u_admin', visibility: 'public',
    });
    // u1 的私有技能（声明凭据需求）
    await mkdir(join(dir, 'users', 'u1', 'mine'), { recursive: true });
    await writeFile(
      join(dir, 'users', 'u1', 'mine', 'SKILL.md'),
      '---\nname: mine\ndescription: u1 的私有技能\ncredentials: aios\ncredential_file: sub/token.json\n---\n正文',
    );
    await writeSkillProduct(join(dir, 'users', 'u1', 'mine'), {
      name: 'mine', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'u1', visibility: 'private',
      credentials: ['aios'], credentialFile: 'sub/token.json',
    });
    // u2 的已共享技能
    await mkdir(join(dir, 'users', 'u2', 'team'), { recursive: true });
    await writeFile(join(dir, 'users', 'u2', 'team', 'SKILL.md'), '---\nname: team\ndescription: u2 共享技能\n---\n正文');
    await writeSkillProduct(join(dir, 'users', 'u2', 'team'), {
      name: 'team', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: 'u2', visibility: 'shared',
    });
    reg = new SkillRegistry(dir);
    await reg.scan();
  });

  afterAll(() => {
    // tmp 目录留给 OS 清理
  });

  it('扫描多根目录并解析 owner/visibility/credentials', () => {
    const byName = new Map(reg.list().map((s) => [s.name, s]));
    expect(byName.get('legacy')).toMatchObject({ visibility: 'public', owner: '' });
    expect(byName.get('pub')).toMatchObject({ visibility: 'public', owner: 'u_admin' });
    expect(byName.get('mine')).toMatchObject({
      visibility: 'private', owner: 'u1', credentials: ['aios'], credentialFile: 'sub/token.json',
    });
    expect(byName.get('team')).toMatchObject({ visibility: 'shared', owner: 'u2' });
  });

  it('listFor：public ∪ 自己的 ∪ shared；私有技能对他人不可见', () => {
    const u1View = reg.listFor({ tenantId: 'default', userId: 'u1', role: 'user' }).map((s) => s.name).sort();
    expect(u1View).toEqual(['legacy', 'mine', 'pub', 'team']);
    const u3View = reg.listFor({ tenantId: 'default', userId: 'u3', role: 'user' }).map((s) => s.name).sort();
    expect(u3View).toEqual(['legacy', 'pub', 'team']);
    // 管理员也看不到他人私有技能
    const adminView = reg.listFor({ tenantId: 'default', userId: 'u_admin', role: 'tenant_admin' }).map((s) => s.name).sort();
    expect(adminView).toEqual(['legacy', 'pub', 'team']);
  });

  it('canManage：仅所有者；无主存量技能由 tenant:manage 管理员代管', () => {
    const mine = reg.get('mine')!;
    expect(reg.canManage(mine, { tenantId: 'default', userId: 'u1', role: 'user' })).toBe(true);
    expect(reg.canManage(mine, { tenantId: 'default', userId: 'u_admin', role: 'platform_admin' })).toBe(false); // 管理员不能管他人技能
    const legacy = reg.get('legacy')!;
    expect(reg.canManage(legacy, { tenantId: 'default', userId: 'u_admin', role: 'tenant_admin' })).toBe(true);
    expect(reg.canManage(legacy, { tenantId: 'default', userId: 'u1', role: 'user' })).toBe(false);
  });

  it('load_skill 执行链路做同一套可见性过滤（不信 LLM）', async () => {
    const tool = reg.tool();
    // u3 尝试加载 u1 的私有技能 → 等同不存在
    const denied = await tool.execute({ name: 'mine' }, { sessionId: 's', tenantId: 'default', userId: 'u3', role: 'user' });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('未找到技能');
    // u1 自己可以加载
    const ok = await tool.execute({ name: 'mine' }, { sessionId: 's', tenantId: 'default', userId: 'u1', role: 'user' });
    expect(ok.isError).toBeUndefined();
  });

  it('setShared 切换 private ↔ shared；公共技能不可共享', async () => {
    const shared = await reg.setShared('mine', true);
    expect(shared.visibility).toBe('shared');
    expect(reg.listFor({ tenantId: 'default', userId: 'u3', role: 'user' }).map((s) => s.name)).toContain('mine');
    const back = await reg.setShared('mine', false);
    expect(back.visibility).toBe('private');
    await expect(reg.setShared('pub', true)).rejects.toThrow('公共技能');
  });

  it('importRootFor：管理员 → _public；普通用户 → users/<uid>', () => {
    expect(reg.importRootFor({ tenantId: 'default', userId: 'u_admin', role: 'tenant_admin' })).toBe(join(dir, '_public'));
    expect(reg.importRootFor({ tenantId: 'default', userId: 'u1', role: 'user' })).toBe(join(dir, 'users', 'u1'));
    expect(reg.importRootFor({ tenantId: 'default', userId: '../evil', role: 'user' })).toBe(join(dir, 'users', '.._evil'));
  });
});

describe('HTTP 越权防护（A/B 用户）', () => {
  let server: Server;
  let base: string;
  let store: MemoryStore;
  let adminToken: string;
  let aliceToken: string;
  let bobToken: string;
  let bobId: string;
  let skillDir: string;
  let auditEvents: Array<Record<string, unknown>>;

  async function login(username: string): Promise<string> {
    const r = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'default', username, password: 'pw' }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { token: string }).token;
  }

  beforeAll(async () => {
    store = new MemoryStore();
    await store.createTenant({ id: 'default', name: 'Default' });
    const auth = new LocalAuthProvider({ store, secret: SECRET });
    await auth.createUser('default', 'admin', 'pw', 'platform_admin');
    const alice = await auth.createUser('default', 'alice', 'pw', 'user');
    const bob = await auth.createUser('default', 'bob', 'pw', 'user');
    bobId = bob.id;
    void alice;

    const credentials = new UserCredentials(store, SECRET);
    const aiosAuth = aiosProvider(store, credentials, async () =>
      jsonResponse({ data: { accountId: '9', displayName: '平台用户', status: 'active', roles: [] } }));

    skillDir = await mkdtemp(join(tmpdir(), 'aiop-http-skill-'));
    await mkdir(join(skillDir, 'users', bob.id, 'bobskill'), { recursive: true });
    await writeFile(
      join(skillDir, 'users', bob.id, 'bobskill', 'SKILL.md'),
      '---\nname: bobskill\ndescription: bob 的技能\n---\n正文',
    );
    await writeSkillProduct(join(skillDir, 'users', bob.id, 'bobskill'), {
      name: 'bobskill', version: '1', enabled: true, reviewed: true,
      tenantId: 'default', ownerUserId: bob.id, visibility: 'private',
    });
    const skillRegistry = new SkillRegistry(skillDir);
    await skillRegistry.scan();

    auditEvents = [];
    const rt = {
      tools: new ToolRegistry(),
      store,
      audit: { record: async (event: Record<string, unknown>) => { auditEvents.push(event); } },
      policy: new AllowAllPolicy(),
      policyPreApproved: new AllowAllPolicy(),
      deploymentMode: 'standalone',
      authProvider: auth,
      aiosAuth,
      credentials,
      skillRegistry,
      frameAncestors: ['https://aios.example.com'],
      jwtSecret: SECRET,
      systemExtra: '',
      defaultContext: { tenantId: 'default', userId: 'cli', role: 'platform_admin' as const },
    } as unknown as Runtime;

    server = createHttpServer(rt);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    adminToken = await login('admin');
    aliceToken = await login('alice');
    bobToken = await login('bob');
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function authed(token: string): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  }

  it('AIOS exchange 换发 aiop JWT，可用于 /v1/me', async () => {
    const r = await fetch(`${base}/auth/aios/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'platform-token', expiredTime: '2099-01-01T00:00:00+0800' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { token: string; role: string; displayName: string };
    expect(body.role).toBe('user');
    expect(body.displayName).toBe('平台用户');

    const me = await fetch(`${base}/v1/me`, { headers: authed(body.token) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      tenantId: 'default', userId: '9', role: 'user', authProvider: 'aios', displayName: '平台用户',
      deploymentMode: 'standalone',
      permissions: ['task:create'],
      features: { localLogin: true, localUserManagement: true },
    });
    const exchangeAudit = auditEvents.find((event) => event.action === 'aios-exchange');
    expect(exchangeAudit).toMatchObject({
      kind: 'auth', tenantId: 'default', userId: '9', provider: 'aios', deploymentMode: 'standalone',
    });
    expect(exchangeAudit?.correlationId).toEqual(expect.any(String));
    expect(JSON.stringify(exchangeAudit)).not.toContain('platform-token');
  });

  it('缺 token / 无效 token 的 exchange 被拒', async () => {
    const missing = await fetch(`${base}/auth/aios/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(missing.status).toBe(400);
  });

  it.each([null, 123, {}, '', 'not-a-date', '2000-01-01T00:00:00Z'])(
    'HTTP exchange 拒绝已提供但无效的 expiredTime: %j',
    async (expiredTime) => {
      const response = await fetch(`${base}/auth/aios/exchange`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'platform-token', expiredTime }),
      });
      expect([400, 401]).toContain(response.status);
    },
  );

  it('HTTP exchange 仅在 expiredTime 未提供时使用服务端 TTL', async () => {
    const response = await fetch(`${base}/auth/aios/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'platform-token' }),
    });
    expect(response.status).toBe(200);
  });

  it('index.html 带 frame-ancestors CSP（仅同源 + 白名单宿主可嵌入）', async () => {
    const r = await fetch(`${base}/`);
    if (r.status === 200) {
      expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'self' https://aios.example.com");
    } else {
      // 构建产物不存在（纯后端测试环境）时跳过
      expect([404, 200]).toContain(r.status);
    }
  });

  it('会话越权：B 拿不到 A 的会话与消息（404/空），列表互不可见', async () => {
    // alice 建会话并写入消息
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST', headers: authed(aliceToken),
      body: JSON.stringify({ sessionId: 'alice-s1', title: 'alice 的会话' }),
    });
    expect(created.status).toBe(201);
    await fetch(`${base}/v1/sessions/alice-s1/append`, {
      method: 'POST', headers: authed(aliceToken), body: JSON.stringify({ text: 'alice 的私密消息' }),
    });

    // bob 列表里看不到
    const bobList = await fetch(`${base}/v1/sessions`, { headers: authed(bobToken) }).then((r) => r.json()) as { sessions: { sessionId: string }[] };
    expect(bobList.sessions.map((s) => s.sessionId)).not.toContain('alice-s1');

    // bob 直接按 id 读消息 → 空（按 user 过滤等同不存在）
    const bobRead = await fetch(`${base}/v1/sessions/alice-s1/messages`, { headers: authed(bobToken) }).then((r) => r.json()) as { messages: unknown[] };
    expect(bobRead.messages).toEqual([]);

    // bob 删除 alice 的会话 → 404
    const bobDelete = await fetch(`${base}/v1/sessions/alice-s1`, { method: 'DELETE', headers: authed(bobToken) });
    expect(bobDelete.status).toBe(404);

    // alice 自己仍完好
    const aliceRead = await fetch(`${base}/v1/sessions/alice-s1/messages`, { headers: authed(aliceToken) }).then((r) => r.json()) as { messages: { text?: string }[] };
    expect(aliceRead.messages.length).toBeGreaterThan(0);
  });

  it('技能越权：私有技能对他人 404；共享后可见；非所有者不可改删（管理员也不行）', async () => {
    // bob 可见自己的技能
    const bobTools = await fetch(`${base}/v1/tools`, { headers: authed(bobToken) }).then((r) => r.json()) as { tools: { name: string; canManage?: boolean }[] };
    expect(bobTools.tools.map((t) => t.name)).toContain('bobskill');

    // alice 看不到；直接访问文件 → 404
    const aliceTools = await fetch(`${base}/v1/tools`, { headers: authed(aliceToken) }).then((r) => r.json()) as { tools: { name: string }[] };
    expect(aliceTools.tools.map((t) => t.name)).not.toContain('bobskill');
    const aliceFiles = await fetch(`${base}/v1/skills/bobskill/files`, { headers: authed(aliceToken) });
    expect(aliceFiles.status).toBe(404);

    // bob 共享 → alice 可见但不可管理
    const share = await fetch(`${base}/v1/skills/bobskill/share`, { method: 'POST', headers: authed(bobToken) });
    expect(share.status).toBe(200);
    const aliceTools2 = await fetch(`${base}/v1/tools`, { headers: authed(aliceToken) }).then((r) => r.json()) as { tools: { name: string; canManage?: boolean; visibility?: string }[] };
    const sharedSkill = aliceTools2.tools.find((t) => t.name === 'bobskill');
    expect(sharedSkill).toMatchObject({ visibility: 'shared', canManage: false });

    // alice 尝试禁用/删除 → 403；管理员（非所有者）也 403
    expect((await fetch(`${base}/v1/skills/bobskill/disable`, { method: 'POST', headers: authed(aliceToken) })).status).toBe(403);
    expect((await fetch(`${base}/v1/skills/bobskill`, { method: 'DELETE', headers: authed(adminToken), body: JSON.stringify({ confirm: true }) })).status).toBe(403);
    // alice 取消共享（非所有者）→ 403
    expect((await fetch(`${base}/v1/skills/bobskill/unshare`, { method: 'POST', headers: authed(aliceToken) })).status).toBe(403);
  });

  it('用户管理：普通用户 403；管理员可列表/禁用/恢复/软删除；禁用后 token 分钟级失效', async () => {
    // 普通用户无权
    expect((await fetch(`${base}/v1/admin/users`, { headers: authed(bobToken) })).status).toBe(403);

    // 管理员列表含来源/状态字段
    const list = await fetch(`${base}/v1/admin/users`, { headers: authed(adminToken) }).then((r) => r.json()) as { users: { id: string; username: string; status: string; authProvider: string }[] };
    expect(list.users.find((u) => u.username === 'bob')).toMatchObject({ status: 'active', authProvider: 'local' });

    // 不能删自己
    const admin = list.users.find((u) => u.username === 'admin')!;
    expect((await fetch(`${base}/v1/admin/users/${admin.id}`, { method: 'DELETE', headers: authed(adminToken) })).status).toBe(403);

    // 禁用 bob → bob 的现有 token 立即失效（状态缓存被主动清除）
    expect((await fetch(`${base}/v1/admin/users/${bobId}/disable`, { method: 'POST', headers: authed(adminToken) })).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions`, { headers: authed(bobToken) })).status).toBe(401);
    // 登录也被拒
    const relogin = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'default', username: 'bob', password: 'pw' }),
    });
    expect(relogin.status).toBe(401);

    // 恢复
    expect((await fetch(`${base}/v1/admin/users/${bobId}/enable`, { method: 'POST', headers: authed(adminToken) })).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions`, { headers: authed(bobToken) })).status).toBe(200);

    // 软删除（默认不打墓碑）：username 保留、状态 disabled
    const del = await fetch(`${base}/v1/admin/users/${bobId}`, { method: 'DELETE', headers: authed(adminToken) });
    expect(del.status).toBe(200);
    const deleted = (await del.json()) as { user: { username: string; status: string } };
    expect(deleted.user).toMatchObject({ username: 'bob', status: 'disabled' });
    // 同名新建被拒（占位即封禁）
    const recreate = await fetch(`${base}/v1/admin/users`, {
      method: 'POST', headers: authed(adminToken),
      body: JSON.stringify({ tenantId: 'default', username: 'bob', password: 'pw2', role: 'user' }),
    });
    expect(recreate.status).toBe(409);
  });
});
