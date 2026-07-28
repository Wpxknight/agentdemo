import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/db/memory.js';
import { MysqlStore } from '../src/db/mysql.js';
import { createDefaultDurableRunRuntime, resolveRuntimeModelConfig, resolveRuntimeSandboxConfig } from '../src/runtime.js';
import { ConfigSchema, SandboxConfigSchema, type Config } from '../src/config/schema.js';
import { DurableRunManager } from '../packages/pi-runtime/src/index.js';

const config: Config = {
  models: {
    fallback: {
      protocol: 'anthropic',
      baseURL: 'http://fallback',
      apiKey: 'fallback-key',
      model: 'fallback-model',
    },
  },
  defaultModel: 'fallback',
};

describe('resolveRuntimeModelConfig', () => {
  it('prefers persisted default tenant LLM settings over startup config', async () => {
    const store = new MemoryStore();
    await store.setLlmSettings({ tenantId: 'default' }, {
      id: 'persisted',
      protocol: 'openai',
      baseURL: 'http://persisted/v1',
      apiKey: 'plain-persisted-key',
      model: 'persisted-model',
    });

    await expect(resolveRuntimeModelConfig(config, store)).resolves.toEqual({
      id: 'persisted',
      protocol: 'openai',
      baseURL: 'http://persisted/v1',
      apiKey: 'plain-persisted-key',
      model: 'persisted-model',
    });
  });
});

describe('production durable runtime assembly', () => {
  it('constructs the shared durable Pi runtime for a MysqlStore', async () => {
    const runtime = await createDefaultDurableRunRuntime(
      new MysqlStore({} as never),
      { id: 'configured', protocol: 'openai', baseURL: 'http://model.local/v1', apiKey: 'secret', model: 'custom-model' },
      'system prompt',
    );

    expect(runtime).toBeInstanceOf(DurableRunManager);
  });
});

describe('Sandbox bootstrap configuration', () => {
  const aiosSandbox = {
    enabled: true,
    provider: 'e2b' as const,
    aios: {
      lifecycleUrl: 'http://aios-sandbox-server:8080',
      placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
    },
    profiles: {
      code: { image: 'code-interpreter' },
    },
  };

  it('accepts an E2B sandbox with AIOS lifecycle configuration', () => {
    expect(SandboxConfigSchema.parse(aiosSandbox).aios).toEqual(aiosSandbox.aios);
  });

  it('rejects AIOS sandbox configuration for a non-E2B provider', () => {
    expect(() => SandboxConfigSchema.parse({ ...aiosSandbox, provider: 'opensandbox' })).toThrow(/provider=e2b/);
  });

  it('accepts catalog-owned browser/templates but rejects manual privilege, warm-pool, and user-home features', () => {
    expect(SandboxConfigSchema.parse({ ...aiosSandbox, desktop: true }).desktop).toBe(true);
    expect(SandboxConfigSchema.parse({
      ...aiosSandbox,
      profiles: { browser: { image: 'browser-template', desktop: true } },
    }).profiles).toEqual({
      browser: expect.objectContaining({ image: 'browser-template', desktop: true }),
    });
    expect(SandboxConfigSchema.parse({
      ...aiosSandbox,
      profiles: { code: { image: 'other-template' } },
    }).profiles).toEqual({
      code: expect.objectContaining({ image: 'other-template' }),
    });
    expect(SandboxConfigSchema.parse({ ...aiosSandbox, profiles: undefined }).profiles).toBeUndefined();
    expect(() => SandboxConfigSchema.parse({
      ...aiosSandbox,
      profiles: { diag: { image: 'sandbox-diag', privileged: true } },
    })).toThrow(/privileged|Runtime Role/);
    expect(() => SandboxConfigSchema.parse({ ...aiosSandbox, warmPoolSize: 1 })).toThrow(/warmPoolSize/);
    expect(() => SandboxConfigSchema.parse({ ...aiosSandbox, userHomeRoot: '/home/users' }))
      .toThrow(/用户主目录挂载/);
    expect(() => SandboxConfigSchema.parse({ ...aiosSandbox, userHomeMountPath: '/workspace/home' }))
      .toThrow(/用户主目录挂载/);
  });

  it('requires a complete HTTP(S) lifecycle placement', () => {
    expect(() => SandboxConfigSchema.parse({
      ...aiosSandbox,
      aios: { ...aiosSandbox.aios, lifecycleUrl: 'aios-sandbox-server:8080' },
    })).toThrow(/HTTP/);
    expect(() => SandboxConfigSchema.parse({
      ...aiosSandbox,
      aios: { ...aiosSandbox.aios, placement: { namespace: 'aios-sandbox-local' } },
    })).toThrow(/clusterId/);
  });

  it('uses persisted page settings instead of startup sandbox config', () => {
    const startup = ConfigSchema.parse({ ...config, sandbox: aiosSandbox }).sandbox!;
    expect(resolveRuntimeSandboxConfig(startup, {
      enabled: false,
      mode: 'opensandbox',
      domain: 'persisted.example',
      protocol: 'https',
    })).toMatchObject({
      enabled: false,
      provider: 'opensandbox',
      domain: 'persisted.example',
      protocol: 'https',
    });
  });

  it('uses startup sandbox only as bootstrap fallback', () => {
    const startup = SandboxConfigSchema.parse({ enabled: true, provider: 'e2b', domain: 'startup.example' });
    expect(resolveRuntimeSandboxConfig(startup)).toEqual(startup);
    expect(resolveRuntimeSandboxConfig(undefined, { enabled: false, mode: 'local' })).toMatchObject({
      enabled: false,
      provider: 'local',
    });
  });
});
