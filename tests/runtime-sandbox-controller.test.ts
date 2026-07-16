import { describe, expect, it } from 'vitest';
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

describe('runtime sandbox controller', () => {
  it('enables, switches, and disables sandbox capabilities without restart', async () => {
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
        settings: {
          enabled: true,
          mode: 'aios_lifecycle',
          lifecycleUrl: 'http://aios-lifecycle.default.svc:8080',
          placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
        },
        keyAction: { action: 'replace', apiKey: 'test-key' },
      });
      expect(rt.sandboxProfiles).toEqual([
        expect.objectContaining({
          name: 'code', image: 'code-interpreter', desktop: false,
          privileged: false, capabilities: ['python', 'node', 'shell'],
        }),
      ]);
      expect(rt.tools.has('browser_navigate')).toBe(false);
      expect(rt.tools.has('kubectl')).toBe(false);

      await rt.updateSandbox?.({
        settings: {
          enabled: false,
          mode: 'aios_lifecycle',
          lifecycleUrl: 'http://aios-lifecycle.default.svc:8080',
          placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
        },
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
