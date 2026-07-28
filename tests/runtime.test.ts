import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/db/memory.js';
import { MysqlStore } from '../src/db/mysql.js';
import { buildRuntime, createDefaultDurableRunRuntime, resolveRuntimeModelConfig, resolveRuntimeSandboxConfig } from '../src/runtime.js';
import { ConfigSchema, SandboxConfigSchema, type Config } from '../src/config/schema.js';
import { DurableRunManager } from '@aiop/pi-runtime';

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
  it('fails startup when shared skill storage requires a distributed mutation lock without MySQL', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'aiop-runtime-distributed-skills-'));
    const parsed = ConfigSchema.parse({
      ...config,
      skills: { dir: skillRoot, requireDistributedLock: true },
    });

    await expect(buildRuntime(parsed, { store: new MemoryStore() }))
      .rejects.toThrow('distributed mutation lock');
  });

  it('keeps the MysqlStore durable primary path disabled by default', async () => {
    const runtime = await createDefaultDurableRunRuntime(
      new MysqlStore({} as never),
      { id: 'configured', protocol: 'openai', baseURL: 'http://model.local/v1', apiKey: 'secret', model: 'custom-model' },
      'system prompt',
    );

    expect(runtime).toBeUndefined();
  });

  it('constructs the shared durable Pi runtime only when explicitly enabled', async () => {
    const runtime = await createDefaultDurableRunRuntime(
      new MysqlStore({} as never),
      { id: 'configured', protocol: 'openai', baseURL: 'http://model.local/v1', apiKey: 'secret', model: 'custom-model' },
      'system prompt',
      true,
    );

    expect(runtime).toBeInstanceOf(DurableRunManager);
  });

  it('preserves an explicitly injected durable runtime without enabling automatic assembly', async () => {
    const injected = { run() {}, resume() {}, cancel() {}, append() {} } as never;
    const runtime = await buildRuntime(config, { store: new MemoryStore(), durableRunRuntime: injected });
    try {
      expect(runtime.durableRunRuntime).toBe(injected);
    } finally {
      await runtime.dispose();
    }
  });

  it('imports the Pi runtime through its public workspace package boundary', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(
      new URL('../src/runtime.ts', import.meta.url), 'utf8',
    ));
    expect(source).toContain("from '@aiop/pi-runtime'");
    expect(source).not.toContain("from '../packages/pi-runtime/src/index.js'");
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
