import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config/schema.js';
import { MemoryStore } from '../src/db/memory.js';
import { buildRuntime } from '../src/runtime.js';
import { SecretBox } from '../src/security/secret-box.js';

const config: Config = {
  models: {
    mock: { protocol: 'openai', baseURL: 'http://localhost/v1', apiKey: 'x', model: 'mock' },
  },
  defaultModel: 'mock',
};

const AIOS_SETTINGS = {
  enabled: true,
  mode: 'aios_lifecycle' as const,
  lifecycleUrl: 'http://aios-lifecycle.default.svc:8080',
  placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
};

const platformAdmin = { tenantId: 'default', userId: 'admin', role: 'platform_admin' as const };
const ordinaryUser = { tenantId: 'default', userId: 'user', role: 'user' as const };

function aiosTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    templateID: 'code-id',
    names: ['code-interpreter'],
    aliases: ['code'],
    buildStatus: 'ready',
    aios: {
      description: 'Code sandbox',
      envType: 'code',
      runtimeRole: 'sandbox-reader',
      image: 'code:latest',
      defaultTimeoutHours: 1,
    },
    ...overrides,
  };
}

function aiosCatalog(version = 'one'): Record<string, unknown>[] {
  return [
    aiosTemplate({
      templateID: 'browser-id',
      names: ['browser'],
      aios: {
        description: `Browser sandbox ${version}`,
        envType: 'browser',
        runtimeRole: 'sandbox-reader',
        image: `browser:${version}`,
        defaultTimeoutHours: 2,
      },
    }),
    aiosTemplate({ templateID: 'code-id' }),
    aiosTemplate({
      templateID: 'diag-id',
      names: ['netdig'],
      aios: {
        description: 'Diagnostic sandbox',
        envType: 'code',
        runtimeRole: 'sandbox-diag',
        image: 'diag:latest',
        defaultTimeoutHours: 0,
      },
    }),
  ];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runtime sandbox controller', () => {
  it('registers tools only for capabilities present in the active AIOS catalog', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const rt = await buildRuntime(config, { store: new MemoryStore() });
    try {
      fetch.mockResolvedValueOnce(jsonResponse(200, [aiosTemplate({
        templateID: 'browser-id',
        names: ['browser'],
        aios: {
          description: 'Browser sandbox',
          envType: 'browser',
          runtimeRole: 'sandbox-reader',
          image: 'browser:latest',
          defaultTimeoutHours: 1,
        },
      })]));
      await rt.updateSandbox?.({
        settings: AIOS_SETTINGS,
        keyAction: { action: 'replace', apiKey: 'test-key' },
      });
      expect(rt.tools.has('sandbox_list_profiles')).toBe(true);
      expect(rt.tools.has('browser_navigate')).toBe(true);
      expect(rt.tools.has('sbx__run_code')).toBe(false);
      expect(rt.tools.has('sandbox_run_command')).toBe(false);
      expect(rt.tools.has('sbx__export_file')).toBe(false);
      expect(rt.tools.has('skill__sync_to_sandbox')).toBe(false);

      fetch.mockResolvedValueOnce(jsonResponse(200, [aiosTemplate({
        templateID: 'code-id',
        names: ['code-interpreter'],
      })]));
      await rt.refreshSandboxTemplates?.();
      expect(rt.tools.has('sbx__run_code')).toBe(true);
      expect(rt.tools.has('sandbox_run_command')).toBe(true);
      expect(rt.tools.has('sbx__export_file')).toBe(true);
      expect(rt.tools.has('browser_navigate')).toBe(false);
    } finally {
      await rt.dispose();
    }
  });

  it('prepares an AIOS generation from the catalog and activates role-aware browser capabilities', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.endsWith('/templates')) return jsonResponse(200, aiosCatalog());
      if (url.endsWith('/sandboxes') && method === 'POST') return jsonResponse(201, { sandboxID: 'sb-browser' });
      if (url.endsWith('/commands') && method === 'POST') {
        return jsonResponse(200, { stdout: '', stderr: '', exitCode: 0 });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });
    const rt = await buildRuntime(config, { store: new MemoryStore() });
    try {
      expect(rt.getSandboxSettings ? (await rt.getSandboxSettings()).runtime?.enabled : false).toBe(false);
      expect(rt.tools.has('sbx__run_code')).toBe(false);
      expect(rt.sandboxProfiles).toEqual([]);

      await rt.updateSandbox?.({ settings: { enabled: true, mode: 'local' }, keyAction: { action: 'retain' } });
      expect(rt.sandboxes).toBeDefined();
      expect(rt.tools.has('sbx__run_code')).toBe(true);
      expect(rt.tools.has('sandbox_list_profiles')).toBe(true);
      expect(rt.sandboxProfiles?.map((profile) => profile.name)).toEqual(['default']);

      await rt.updateSandbox?.({
        settings: AIOS_SETTINGS,
        keyAction: { action: 'replace', apiKey: 'test-key' },
      });
      expect(rt.sandboxProfilesFor?.(platformAdmin)).toHaveLength(3);
      expect(rt.sandboxProfilesFor?.(ordinaryUser).map((profile) => profile.id)).toEqual(['browser-id', 'code-id']);
      expect(rt.sandboxProfilesFor?.(platformAdmin)).toEqual([
        expect.objectContaining({
          id: 'browser-id',
          template: 'browser-id',
          desktop: true,
          capabilities: ['shell', 'browser', 'screenshot', 'navigate', 'click', 'type'],
        }),
        expect.objectContaining({
          id: 'code-id',
          template: 'code-id',
          capabilities: ['python', 'node', 'shell'],
        }),
        expect.objectContaining({
          id: 'diag-id',
          template: 'diag-id',
          privileged: true,
          capabilities: ['python', 'node', 'shell', 'diagnostics'],
        }),
      ]);
      expect(rt.tools.has('browser_navigate')).toBe(true);
      expect(rt.tools.has('kubectl')).toBe(false);

      const navigate = await rt.tools.dispatch({
        id: 'browser-navigate',
        name: 'browser_navigate',
        args: { url: 'https://example.test' },
      }, { ...ordinaryUser, sessionId: 'browser-session' });
      expect(navigate.isError).not.toBe(true);
      expect(requests.find((request) => request.url.endsWith('/sandboxes'))?.body).toMatchObject({
        template: 'browser-id',
        placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
      });

      await rt.updateSandbox?.({
        settings: { ...AIOS_SETTINGS, enabled: false },
        keyAction: { action: 'clear' },
      });
      expect(rt.getSandboxSettings ? (await rt.getSandboxSettings()).runtime?.enabled : false).toBe(false);
      expect(rt.sandboxProfiles).toEqual([]);
      expect(rt.tools.has('sbx__run_code')).toBe(false);
      expect(rt.tools.has('sandbox_list_profiles')).toBe(false);
    } finally {
      await rt.dispose();
    }
  });

  it('starts with catalog_unavailable for persisted AIOS failure and recovers through manual refresh', async () => {
    const store = new MemoryStore();
    const box = new SecretBox('runtime-catalog-secret', 'platform-settings');
    const seeded = await buildRuntime(config, { store, settingsSecretBox: box });
    await seeded.updateSandbox?.({
      settings: { ...AIOS_SETTINGS, enabled: false },
      keyAction: { action: 'replace', apiKey: 'persisted-aios-key' },
    });
    await seeded.dispose();
    await store.setSandboxSettingsRecord(
      { tenantId: 'default' },
      AIOS_SETTINGS,
      { action: 'retain' },
    );

    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockRejectedValueOnce(new Error('offline persisted-aios-key'));
    const rt = await buildRuntime(config, { store, settingsSecretBox: box });
    try {
      expect(rt.tools.has('sbx__run_code')).toBe(false);
      expect(rt.sandboxProfiles).toEqual([]);
      expect(await rt.getSandboxSettings?.()).toMatchObject({
        settings: AIOS_SETTINGS,
        apiKeySet: true,
        runtime: {
          enabled: false,
          mode: 'aios_lifecycle',
          status: 'catalog_unavailable',
          templateCount: 0,
        },
      });

      fetch.mockResolvedValueOnce(jsonResponse(200, aiosCatalog()));
      await expect(rt.refreshSandboxTemplates?.()).resolves.toMatchObject({
        changed: true,
        templateCount: 3,
        state: {
          runtime: { enabled: true, status: 'active', templateCount: 3 },
        },
      });
      expect(rt.sandboxProfilesFor?.(platformAdmin)).toHaveLength(3);
      expect(rt.tools.has('browser_navigate')).toBe(true);
    } finally {
      await rt.dispose();
    }
  });

  it('keeps an unchanged generation and atomically replaces only a changed catalog', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockImplementation(async () => jsonResponse(200, aiosCatalog('one')));
    const rt = await buildRuntime(config, { store: new MemoryStore() });
    try {
      await rt.updateSandbox?.({ settings: AIOS_SETTINGS, keyAction: { action: 'replace', apiKey: 'test-key' } });
      const firstProfile = rt.sandboxProfilesFor?.(ordinaryUser)[0];
      const firstRunCode = rt.tools.defs().find((tool) => tool.name === 'sbx__run_code');

      await expect(rt.refreshSandboxTemplates?.()).resolves.toMatchObject({
        changed: false,
        templateCount: 3,
      });
      expect(rt.sandboxProfilesFor?.(ordinaryUser)[0]).toEqual(firstProfile);
      expect(rt.tools.defs().find((tool) => tool.name === 'sbx__run_code')).toBe(firstRunCode);

      fetch.mockResolvedValueOnce(jsonResponse(200, aiosCatalog('two')));
      await expect(rt.refreshSandboxTemplates?.()).resolves.toMatchObject({
        changed: true,
        templateCount: 3,
      });
      expect(rt.sandboxProfilesFor?.(ordinaryUser)[0]).toMatchObject({ image: 'browser:two' });
      expect(rt.tools.defs().find((tool) => tool.name === 'sbx__run_code')).not.toBe(firstRunCode);

      fetch.mockRejectedValueOnce(new Error('refresh failed test-key'));
      await expect(rt.refreshSandboxTemplates?.()).rejects.toThrow('AIOS Lifecycle request failed');
      expect(rt.sandboxProfilesFor?.(ordinaryUser)[0]).toMatchObject({ image: 'browser:two' });
      expect(await rt.getSandboxSettings?.()).toMatchObject({
        runtime: { enabled: true, status: 'active', templateCount: 3 },
      });
    } finally {
      await rt.dispose();
    }
  });

  it('serializes refresh with settings updates and rechecks the active credential target', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(jsonResponse(200, aiosCatalog('one')));
    const rt = await buildRuntime(config, { store: new MemoryStore() });
    try {
      await rt.updateSandbox?.({ settings: AIOS_SETTINGS, keyAction: { action: 'replace', apiKey: 'first-key' } });
      const pendingCatalog = deferred<Response>();
      fetch.mockImplementationOnce(async () => pendingCatalog.promise);
      const refresh = rt.refreshSandboxTemplates!();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

      const switchMode = rt.updateSandbox!({
        settings: { enabled: true, mode: 'local' },
        keyAction: { action: 'clear' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rt.sandboxSettings).toEqual(AIOS_SETTINGS);

      pendingCatalog.resolve(jsonResponse(200, aiosCatalog('two')));
      await refresh;
      await switchMode;
      expect(rt.sandboxSettings).toEqual({ enabled: true, mode: 'local' });
      expect(rt.sandboxProfiles?.map((profile) => profile.id)).toEqual(['default']);
      expect(rt.tools.has('browser_navigate')).toBe(false);
      await expect(rt.refreshSandboxTemplates?.()).rejects.toThrow(/AIOS|启用/);
    } finally {
      await rt.dispose();
    }
  });

  it('unrefs the AIOS catalog timer and clears it on mode switch and dispose', async () => {
    const timers: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => {
      const timer = { unref: vi.fn() };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, aiosCatalog()));
    const rt = await buildRuntime(config, { store: new MemoryStore() });

    await rt.updateSandbox?.({ settings: AIOS_SETTINGS, keyAction: { action: 'replace', apiKey: 'test-key' } });
    const firstCatalogTimer = timers.at(-1)!;
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 60_000);
    expect(firstCatalogTimer.unref).toHaveBeenCalled();

    await rt.updateSandbox?.({ settings: { enabled: true, mode: 'local' }, keyAction: { action: 'clear' } });
    expect(clearIntervalSpy).toHaveBeenCalledWith(firstCatalogTimer);

    await rt.updateSandbox?.({ settings: AIOS_SETTINGS, keyAction: { action: 'replace', apiKey: 'test-key' } });
    const secondCatalogTimer = timers.at(-1)!;
    expect(secondCatalogTimer).not.toBe(firstCatalogTimer);
    await rt.dispose();
    expect(clearIntervalSpy).toHaveBeenCalledWith(secondCatalogTimer);
  });

  it('keeps standard desktop profiles compatible with default sandbox and browser tools', async () => {
    const desktopConfig: Config = {
      ...config,
      sandbox: {
        enabled: true,
        provider: 'local',
        desktop: true,
        userHomeMountPath: '/home/user/host',
      },
    };
    const rt = await buildRuntime(desktopConfig, { store: new MemoryStore() });
    try {
      await expect(rt.tools.dispatch({
        id: 'run-command',
        name: 'sbx__run_command',
        args: { command: 'printf compatible' },
      }, { ...ordinaryUser, sessionId: 'desktop-compatible' })).resolves.toMatchObject({
        isError: false,
      });
      expect(rt.tools.has('browser_navigate')).toBe(true);
    } finally {
      await rt.dispose();
    }
  });

  it('persists bootstrap settings once and restores encrypted settings on restart', async () => {
    const store = new MemoryStore();
    const box = new SecretBox('runtime-settings-secret', 'platform-settings');
    const bootstrap: Config = {
      ...config,
      sandbox: {
        enabled: false,
        provider: 'e2b',
        domain: 'bootstrap.example.test',
        apiKey: 'bootstrap-key',
        desktop: false,
        userHomeMountPath: '/home/user/host',
      },
    };
    const first = await buildRuntime(bootstrap, { store, settingsSecretBox: box });
    try {
      expect(await first.getSandboxSettings?.()).toMatchObject({
        settings: { enabled: false, mode: 'standard_e2b', domain: 'bootstrap.example.test' },
        apiKeySet: true,
      });
      const stored = await store.getSandboxSettingsRecord({ tenantId: 'default' });
      expect(stored?.encryptedApiKey).toBeTypeOf('string');
      expect(JSON.stringify(stored?.settings)).not.toContain('bootstrap-key');
    } finally {
      await first.dispose();
    }

    const restarted = await buildRuntime(config, { store, settingsSecretBox: box });
    try {
      expect(await restarted.getSandboxSettings?.()).toMatchObject({
        settings: { enabled: false, mode: 'standard_e2b', domain: 'bootstrap.example.test' },
        apiKeySet: true,
        runtime: { enabled: false, status: 'disabled' },
      });
    } finally {
      await restarted.dispose();
    }
  });

  it('does not overwrite persisted settings or activate bootstrap config when secret decryption fails', async () => {
    const store = new MemoryStore();
    const savedSettings = {
      enabled: true,
      mode: 'standard_e2b' as const,
      domain: 'persisted.example.test',
    };
    const oldBox = new SecretBox('old-runtime-settings-secret', 'platform-settings');
    const first = await buildRuntime(config, { store, settingsSecretBox: oldBox });
    await first.updateSandbox?.({
      settings: savedSettings,
      keyAction: { action: 'replace', apiKey: 'persisted-key' },
    });
    await first.dispose();
    const before = await store.getSandboxSettingsRecord({ tenantId: 'default' });

    const startup: Config = {
      ...config,
      sandbox: { enabled: true, provider: 'local', desktop: false, userHomeMountPath: '/home/user/host' },
    };
    const restarted = await buildRuntime(startup, {
      store,
      settingsSecretBox: new SecretBox('wrong-runtime-settings-secret', 'platform-settings'),
    });
    try {
      expect(await restarted.getSandboxSettings?.()).toEqual({
        settings: savedSettings,
        apiKeySet: true,
        runtime: {
          enabled: false,
          mode: 'standard_e2b',
          status: 'credentials_reconfiguration_required',
        },
      });
      expect(restarted.tools.has('sbx__run_code')).toBe(false);
      await expect(restarted.updateSandbox?.({
        settings: { ...savedSettings, enabled: false },
        keyAction: { action: 'retain' },
      })).rejects.toThrow(/无法解密.*重新配置/);
      expect(await store.getSandboxSettingsRecord({ tenantId: 'default' })).toEqual(before);

      await restarted.updateSandbox?.({
        settings: { ...savedSettings, enabled: false },
        keyAction: { action: 'replace', apiKey: 'replacement-key' },
      });
      expect(await restarted.getSandboxSettings?.()).toMatchObject({
        settings: { ...savedSettings, enabled: false },
        apiKeySet: true,
        runtime: { enabled: false, status: 'disabled' },
      });
    } finally {
      await restarted.dispose();
    }
  });

  it('serializes concurrent settings updates so persisted and active state stay aligned', async () => {
    class BlockingStore extends MemoryStore {
      writes = 0;
      firstPersisted!: () => void;
      releaseFirst!: () => void;
      readonly persisted = new Promise<void>((resolve) => { this.firstPersisted = resolve; });
      readonly release = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

      override async setSandboxSettingsRecord(...args: Parameters<MemoryStore['setSandboxSettingsRecord']>) {
        this.writes++;
        await super.setSandboxSettingsRecord(...args);
        if (this.writes === 1) {
          this.firstPersisted();
          await this.release;
        }
      }
    }
    const store = new BlockingStore();
    const rt = await buildRuntime(config, { store });
    try {
      const enable = rt.updateSandbox!({
        settings: { enabled: true, mode: 'local' },
        keyAction: { action: 'retain' },
      });
      await store.persisted;

      const disable = rt.updateSandbox!({
        settings: { enabled: false, mode: 'local' },
        keyAction: { action: 'retain' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.writes).toBe(1);

      store.releaseFirst();
      await Promise.all([enable, disable]);
      expect(await store.getSandboxSettings({ tenantId: 'default' })).toEqual({ enabled: false, mode: 'local' });
      expect(await rt.getSandboxSettings?.()).toMatchObject({
        settings: { enabled: false, mode: 'local' },
        runtime: { enabled: false, status: 'disabled' },
      });
      expect(rt.tools.has('sbx__run_code')).toBe(false);
    } finally {
      store.releaseFirst?.();
      await rt.dispose();
    }
  });

  it('rejects updates queued behind runtime disposal', async () => {
    class BlockingStore extends MemoryStore {
      persisted!: () => void;
      release!: () => void;
      readonly didPersist = new Promise<void>((resolve) => { this.persisted = resolve; });
      readonly canFinish = new Promise<void>((resolve) => { this.release = resolve; });

      override async setSandboxSettingsRecord(...args: Parameters<MemoryStore['setSandboxSettingsRecord']>) {
        await super.setSandboxSettingsRecord(...args);
        this.persisted();
        await this.canFinish;
      }
    }
    const store = new BlockingStore();
    const rt = await buildRuntime(config, { store });
    const updating = rt.updateSandbox!({
      settings: { enabled: true, mode: 'local' },
      keyAction: { action: 'retain' },
    });
    await store.didPersist;

    const disposing = rt.dispose();
    const late = expect(rt.updateSandbox!({
      settings: { enabled: false, mode: 'local' },
      keyAction: { action: 'retain' },
    })).rejects.toThrow(/disposed/);
    store.release();

    await updating;
    await late;
    await disposing;
    expect(await store.getSandboxSettings({ tenantId: 'default' })).toEqual({ enabled: true, mode: 'local' });
  });

  it('keeps the active resolver and tools when persistence fails', async () => {
    class FailingStore extends MemoryStore {
      failNext = false;
      override async setSandboxSettingsRecord(...args: Parameters<MemoryStore['setSandboxSettingsRecord']>) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('persistence failed');
        }
        return super.setSandboxSettingsRecord(...args);
      }
    }
    const store = new FailingStore();
    const rt = await buildRuntime(config, { store });
    try {
      await rt.updateSandbox?.({ settings: { enabled: true, mode: 'local' }, keyAction: { action: 'retain' } });
      const runCode = rt.tools.defs().find((tool) => tool.name === 'sbx__run_code');
      expect(runCode).toBeDefined();
      store.failNext = true;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(200, aiosCatalog()));

      await expect(rt.updateSandbox?.({
        settings: {
          enabled: true,
          mode: 'aios_lifecycle',
          lifecycleUrl: 'http://aios-lifecycle.default.svc:8080',
          placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
        },
        keyAction: { action: 'replace', apiKey: 'candidate-key' },
      })).rejects.toThrow('persistence failed');

      expect(rt.tools.defs().find((tool) => tool.name === 'sbx__run_code')).toBe(runCode);
      expect(rt.sandboxSettings).toEqual({ enabled: true, mode: 'local' });
      expect(rt.sandboxProfiles?.map((profile) => profile.name)).toEqual(['default']);
      expect(await rt.getSandboxSettings?.()).toMatchObject({
        settings: { enabled: true, mode: 'local' },
        runtime: { enabled: true, mode: 'local', status: 'active' },
      });
    } finally {
      await rt.dispose();
    }
  });
});
