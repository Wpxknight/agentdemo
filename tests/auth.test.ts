import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { LocalAuthProvider } from '../src/auth/local.js';
import { MemoryStore } from '../src/db/memory.js';
import { bearerToken, authenticate } from '../src/server/context.js';
import { parseConfig } from '../src/config/load.js';
import { buildRuntime } from '../src/runtime.js';
import type { Config } from '../src/config/schema.js';

describe('password hashing', () => {
  it('verifies correct password and rejects wrong', async () => {
    const h = await hashPassword('hunter2');
    expect(await verifyPassword('hunter2', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('produces distinct salts', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });
});

describe('LocalAuthProvider', () => {
  async function setup() {
    const store = new MemoryStore();
    await store.createTenant({ id: 't1', name: 'T1' });
    const auth = new LocalAuthProvider({ store, secret: 'test-secret' });
    const user = await auth.createUser('t1', 'alice', 'pw', 'tenant_admin');
    return { store, auth, user };
  }

  it('logs in and issues a verifiable token carrying identity', async () => {
    const { auth, user } = await setup();
    const token = await auth.login('t1', 'alice', 'pw');
    expect(token).toBeTypeOf('string');

    const ctx = await auth.authenticate(token!);
    expect(ctx).toEqual({ tenantId: 't1', userId: user.id, role: 'tenant_admin' });
  });

  it('rejects wrong password and unknown user', async () => {
    const { auth } = await setup();
    expect(await auth.login('t1', 'alice', 'bad')).toBeUndefined();
    expect(await auth.login('t1', 'bob', 'pw')).toBeUndefined();
  });

  it('rejects tampered / foreign tokens', async () => {
    const { auth } = await setup();
    expect(await auth.authenticate('not-a-jwt')).toBeUndefined();

    const other = new LocalAuthProvider({ store: new MemoryStore(), secret: 'different' });
    const token = await auth.login('t1', 'alice', 'pw');
    expect(await other.authenticate(token!)).toBeUndefined(); // 不同密钥签名校验失败
  });

  it('scopes users by tenant (same username, different tenant)', async () => {
    const { auth, store } = await setup();
    await store.createTenant({ id: 't2', name: 'T2' });
    await auth.createUser('t2', 'alice', 'pw2', 'user');

    const c1 = await auth.authenticate((await auth.login('t1', 'alice', 'pw'))!);
    const c2 = await auth.authenticate((await auth.login('t2', 'alice', 'pw2'))!);
    expect(c1!.tenantId).toBe('t1');
    expect(c2!.tenantId).toBe('t2');
    expect(c1!.userId).not.toBe(c2!.userId);
  });
});

describe('server/context', () => {
  it('extracts bearer token', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer xyz')).toBe('xyz');
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Basic foo')).toBeUndefined();
  });

  it('authenticate resolves context from Authorization header', async () => {
    const store = new MemoryStore();
    await store.createTenant({ id: 't1', name: 'T1' });
    const auth = new LocalAuthProvider({ store, secret: 's' });
    await auth.createUser('t1', 'alice', 'pw', 'user');
    const token = await auth.login('t1', 'alice', 'pw');

    const ctx = await authenticate(auth, `Bearer ${token}`);
    expect(ctx?.tenantId).toBe('t1');
    expect(await authenticate(auth, undefined)).toBeUndefined();
  });
});

describe('local auth bootstrap', () => {
  it('parses configured bootstrap admin credentials', () => {
    const cfg = parseConfig(`{
      "models": { "mock": { "protocol": "openai", "baseURL": "http://localhost/v1", "apiKey": "x", "model": "mock" } },
      "defaultModel": "mock",
      "auth": {
        "provider": "local",
        "bootstrapAdmin": { "tenantId": "default", "username": "admin", "password": "pw", "role": "platform_admin" }
      }
    }`);

    expect(cfg.auth?.bootstrapAdmin?.username).toBe('admin');
  });

  it('creates the configured bootstrap admin when building local runtime', async () => {
    const config = {
      models: { mock: { protocol: 'openai', baseURL: 'http://localhost/v1', apiKey: 'x', model: 'mock' } },
      defaultModel: 'mock',
      auth: {
        provider: 'local',
        bootstrapAdmin: { tenantId: 'default', username: 'admin', password: 'pw', role: 'platform_admin' },
      },
    } as Config;

    const rt = await buildRuntime(config);
    try {
      const token = await rt.authProvider.login('default', 'admin', 'pw');
      expect(token).toBeTypeOf('string');
    } finally {
      await rt.dispose();
    }
  });

  it('registers local sandbox and browser tools from config', async () => {
    const cfg = parseConfig(`{
      "models": { "mock": { "protocol": "openai", "baseURL": "http://localhost/v1", "apiKey": "x", "model": "mock" } },
      "defaultModel": "mock",
      "sandbox": { "enabled": true, "provider": "local", "desktop": true }
    }`);

    const rt = await buildRuntime(cfg);
    try {
      expect(rt.tools.has('sbx__run_code')).toBe(true);
      expect(rt.tools.has('sbx__run_command')).toBe(true);
      expect(rt.tools.has('sandbox_list_profiles')).toBe(true);
      expect(rt.tools.has('sandbox_run_command')).toBe(true);
      expect(rt.tools.has('desktop_stream_url')).toBe(true);
      expect(rt.tools.has('browser_navigate')).toBe(true);
      expect(rt.tools.has('browser_screenshot')).toBe(true);
      expect(rt.sandboxProfiles).toEqual([
        expect.objectContaining({
          id: 'default',
          name: 'default',
          envType: 'code',
          desktop: true,
        }),
      ]);
      const command = await rt.tools.dispatch({
        id: 'legacy-command',
        name: 'sbx__run_command',
        args: { command: 'printf legacy-dual-use' },
      }, { sessionId: 'legacy-desktop', tenantId: 'default', userId: 'user', role: 'user' });
      expect(command).toMatchObject({ isError: false });
      expect(command.content).toContain('legacy-dual-use');
    } finally {
      await rt.dispose();
    }
  });

  it('registers AIOS lifecycle tools from the dynamic template catalog', async () => {
    const cfg = parseConfig(`{
      "models": { "mock": { "protocol": "openai", "baseURL": "http://localhost/v1", "apiKey": "x", "model": "mock" } },
      "defaultModel": "mock",
      "sandbox": {
        "enabled": true,
        "provider": "e2b",
        "apiKey": "test-aios-key",
        "aios": {
          "lifecycleUrl": "http://aios-sandbox-server:8080",
          "placement": { "clusterId": "local", "namespace": "aios-sandbox-local" }
        },
        "desktop": false
      }
    }`);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([
      {
        templateID: 'code-id',
        names: ['code-interpreter'],
        aliases: ['code'],
        buildStatus: 'ready',
        aios: {
          description: 'Code sandbox',
          envType: 'code',
          runtimeRole: 'sandbox-reader',
          image: 'code:latest',
          defaultTimeoutHours: 1
        }
      }
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));

    const rt = await buildRuntime(cfg);
    try {
      expect(fetch).toHaveBeenCalledWith(
        'http://aios-sandbox-server:8080/templates',
        expect.objectContaining({ method: 'GET', redirect: 'error' }),
      );
      expect(rt.tools.has('sbx__run_code')).toBe(true);
      expect(rt.tools.has('sbx__run_command')).toBe(true);
      expect(rt.tools.has('sandbox_list_profiles')).toBe(true);
      expect(rt.tools.has('sandbox_ensure')).toBe(true);
      expect(rt.tools.has('desktop_stream_url')).toBe(false);
      expect(rt.tools.has('browser_navigate')).toBe(false);
      expect(rt.tools.has('browser_screenshot')).toBe(false);
      expect(rt.sandboxProfiles).toEqual([
        expect.objectContaining({
          id: 'code-id',
          name: 'code-interpreter',
          template: 'code-id',
          capabilities: ['python', 'node', 'shell'],
        }),
      ]);
      expect(rt.userHome).toBeUndefined();
      expect(rt.sandboxSettings).not.toHaveProperty('apiKey');
    } finally {
      await rt.dispose();
      fetch.mockRestore();
    }
  });

  it('registers OpenSandbox browser tools from config', async () => {
    const cfg = parseConfig(`{
      "models": { "mock": { "protocol": "openai", "baseURL": "http://localhost/v1", "apiKey": "x", "model": "mock" } },
      "defaultModel": "mock",
      "sandbox": {
        "enabled": true,
        "provider": "opensandbox",
        "domain": "opensandbox-server.opensandbox-system.svc:80",
        "protocol": "http",
        "desktop": true,
        "defaultImage": "aiop/opensandbox-browser:latest",
        "profiles": {
          "code": { "description": "代码沙箱", "image": "aiop/opensandbox-code:latest", "capabilities": ["python", "shell"] },
          "browser": { "description": "浏览器沙箱", "image": "aiop/opensandbox-browser:latest", "desktop": true, "capabilities": ["browser", "screenshot"] },
          "netdiag": { "description": "运维沙箱", "image": "aiop/opensandbox-netdiag:dev", "privileged": true, "capabilities": ["kubectl", "tcpdump"] }
        }
      }
    }`);

    const rt = await buildRuntime(cfg);
    try {
      expect(rt.tools.has('sbx__run_code')).toBe(true);
      expect(rt.tools.has('sbx__run_command')).toBe(true);
      expect(rt.tools.has('sandbox_list_profiles')).toBe(true);
      expect(rt.tools.has('sandbox_ensure')).toBe(true);
      expect(rt.tools.has('sandbox_run_code')).toBe(true);
      expect(rt.tools.has('sandbox_run_command')).toBe(true);
      expect(rt.tools.has('desktop_stream_url')).toBe(true);
      expect(rt.tools.has('browser_navigate')).toBe(true);
      expect(rt.tools.has('browser_screenshot')).toBe(true);
      expect(rt.sandboxProfiles).toEqual([
        expect.objectContaining({ name: 'code', image: 'aiop/opensandbox-code:latest', capabilities: ['python', 'shell'] }),
        expect.objectContaining({ name: 'browser', desktop: true, image: 'aiop/opensandbox-browser:latest' }),
        expect.objectContaining({ name: 'netdiag', privileged: true, capabilities: ['kubectl', 'tcpdump'] }),
      ]);
    } finally {
      await rt.dispose();
    }
  });
});
