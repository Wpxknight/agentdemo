import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/db/memory.js';
import { MysqlStore } from '../src/db/mysql.js';
import {
  buildRuntime,
  bridgeDurableGovernedTools,
  createFencedToolLedger,
  createDefaultDurableRunRuntime,
  createMcpCredentialProvider,
  resolveMcpBootstrapConfigs,
  resolveRuntimeModelConfig,
  resolveRuntimeSandboxConfig,
} from '../src/runtime.js';
import { ConfigSchema, SandboxConfigSchema, type Config } from '../src/config/schema.js';
import { DurableRunManager } from '@aiop/pi-runtime';
import { GovernedToolOutcomeError } from '@aiop/pi-runtime';
import { McpManager } from '@aiop/mcp-runtime';
import { AllowAllPolicy } from '../src/agent/policy.js';
import { defineTool, ToolRegistry } from '../src/agent/tools.js';

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
  it('fences pre-execution ledger mutations with the active durable attempt lease', async () => {
    const calls: string[] = [];
    const ledger = {
      get: async () => undefined,
      putIfAbsent: async () => { calls.push('write'); return true; },
      update: async () => { calls.push('write'); },
      claimPendingApproval: async () => { calls.push('write'); return true; },
    };
    const store = {
      toolLedger: ledger,
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
        attempts: { list: async () => [{
          tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', workerId: 'worker-a',
          leaseToken: 3n, kernel: 'pi', kernelVersion: '0.82.1', status: 'running', startedAt: new Date(),
        }] },
        runs: { assertLease: async () => { calls.push('fence'); } },
        toolLedger: ledger,
      }),
    } as never;
    const fenced = createFencedToolLedger(store, { tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a' });
    await fenced.putIfAbsent({
      tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'deploy', argsDigest: 'digest',
      capability: 'non_idempotent_write', idempotencyKey: 'key-a', status: 'started',
      createdAt: new Date(), updatedAt: new Date(),
    });
    expect(calls).toEqual(['fence', 'write']);
  });

  it('persists durable MCP waiting interactions and preserves outcomes for resume', async () => {
    const definition = {
      name: 'mcp__ops__deploy', description: 'deploy', inputSchema: {}, capability: 'non_idempotent_write' as const,
      execute: async () => ({ content: 'unused' }),
    };
    const waiting = {
      kind: 'waiting' as const, reason: 'approval' as const, interactionId: 'approval-a',
      interactionUpdates: [{
        tenantId: 'tenant-a', runId: 'run-a', id: 'approval-a', userId: 'user-a', sessionId: 'session-a',
        attemptId: 'attempt-a', turnNo: 1, kind: 'approval' as const, toolCallId: 'call-a', status: 'pending' as const,
        payload: {}, createdAt: new Date('2026-07-29T00:00:00.000Z'),
      }],
    };
    const execute = vi.fn(async (_call, context) => context.interactionResolution
      ? { kind: 'result' as const, result: { callId: 'call-a', content: 'approved' } }
      : waiting);
    const tools = bridgeDurableGovernedTools({
      definitions: [definition], runtime: { execute },
      context: {
        identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
        runId: 'run-a', attemptId: 'attempt-a', turnNo: 1, sessionId: 'session-a',
      },
    });

    await expect(tools[0]!.execute('call-a', {}, new AbortController().signal, () => undefined, undefined))
      .rejects.toMatchObject({
        kind: 'waiting', interactionId: 'approval-a',
        outcome: { interactionUpdates: waiting.interactionUpdates },
      });

    const resumed = bridgeDurableGovernedTools({
      definitions: [definition], runtime: { execute },
      context: {
        identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
        runId: 'run-a', attemptId: 'attempt-b', turnNo: 2, sessionId: 'session-a',
        interactionResolution: {
          interactionId: 'approval-a', kind: 'approval', toolCallId: 'call-a', value: true,
        },
      },
    });
    await expect(resumed[0]!.execute('call-a', {}, new AbortController().signal, () => undefined, undefined))
      .resolves.toMatchObject({ content: [{ type: 'text', text: 'approved' }] });
    expect(GovernedToolOutcomeError).toBeTypeOf('function');
  });
  it('limits startup MCP config fallback to the default tenant', () => {
    const startup = { shared: { transport: 'http' as const, url: 'https://mcp.example', headers: { authorization: 'secret' } } };
    expect(resolveMcpBootstrapConfigs('default', startup, undefined)).toEqual(startup);
    expect(resolveMcpBootstrapConfigs('tenant-b', startup, undefined)).toEqual({});
    expect(resolveMcpBootstrapConfigs('tenant-b', startup, {
      own: { transport: 'http', url: 'https://tenant-b.example' },
    })).toEqual({ own: { transport: 'http', url: 'https://tenant-b.example' } });
  });

  it('resolves MCP credentials from the requesting tenant and actor', async () => {
    const get = vi.fn(async () => ({ headers: { authorization: 'Bearer tenant-a' } }));
    const provider = createMcpCredentialProvider({ get } as never);
    await expect(provider.resolve({ tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] }, 'ops'))
      .resolves.toEqual({ headers: { authorization: 'Bearer tenant-a' } });
    expect(get).toHaveBeenCalledWith('tenant-a', 'user-a', 'mcp:ops');
  });

  it('clears the download sweep timer when runtime initialization fails', async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), 'aiop-runtime-init-cleanup-'));
      await mkdir(join(root, '.aiop-publications'), { recursive: true });
      await writeFile(join(root, '.aiop-publications', 'broken.json'), '{');
      const parsed = ConfigSchema.parse({
        ...config,
        downloads: { enabled: true, dir: join(root, 'downloads') },
        skills: { dir: root },
      });
      const before = vi.getTimerCount();

      await expect(buildRuntime(parsed, { store: new MemoryStore() })).rejects.toThrow();

      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts bounded pending quotas suitable for a 5Gi shared skill PVC', () => {
    const parsed = ConfigSchema.parse({
      ...config,
      skills: {
        dir: '/skills',
        pendingQuota: {
          perUserMaxCount: 20,
          perUserMaxBytes: 256 * 1024 * 1024,
          perTenantMaxCount: 200,
          perTenantMaxBytes: 4 * 1024 * 1024 * 1024,
          minFreeBytes: 512 * 1024 * 1024,
          retentionMs: 24 * 60 * 60 * 1000,
        },
      },
    });

    expect(parsed.skills?.pendingQuota).toMatchObject({
      perTenantMaxBytes: 4 * 1024 * 1024 * 1024,
      minFreeBytes: 512 * 1024 * 1024,
    });
  });

  it('fails startup when shared skill storage requires a distributed mutation lock without MySQL', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'aiop-runtime-distributed-skills-'));
    const parsed = ConfigSchema.parse({
      ...config,
      skills: { dir: skillRoot, requireDistributedLock: true },
    });

    await expect(buildRuntime(parsed, { store: new MemoryStore() }))
      .rejects.toThrow('distributed mutation lock');
  });

  it('constructs the MysqlStore durable primary path by default', async () => {
    const runtime = await createDefaultDurableRunRuntime(
      new MysqlStore({} as never),
      { id: 'configured', protocol: 'openai', baseURL: 'http://model.local/v1', apiKey: 'secret', model: 'custom-model' },
      'system prompt',
    );

    expect(runtime).toBeInstanceOf(DurableRunManager);
  });

  it('rejects attempts to disable the mandatory durable Pi runtime', async () => {
    await expect(createDefaultDurableRunRuntime(
      new MysqlStore({} as never),
      { id: 'configured', protocol: 'openai', baseURL: 'http://model.local/v1', apiKey: 'secret', model: 'custom-model' },
      'system prompt',
      false,
    )).rejects.toThrow('mandatory');
  });

  it('assembles identity-resolved MCP tools into durable Pi sessions through the governed adapter', async () => {
    const mcp = new McpManager({
      ops: { transport: 'http', url: 'https://ops.example', toolCapabilities: { inspect: 'read' } },
    }, async () => ({
      listTools: async () => ({ tools: [{ name: 'inspect', inputSchema: {} }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => undefined,
    }));
    const runtime = await createDefaultDurableRunRuntime(
      new MysqlStore({} as never),
      { id: 'configured', protocol: 'openai', baseURL: 'http://model.local/v1', apiKey: 'secret', model: 'custom-model' },
      'system prompt',
      true,
      mcp,
      new AllowAllPolicy(),
    ) as DurableRunManager;
    const sessionFactory = (runtime as unknown as { options: { sessions: { options: {
      resolveTools(input: unknown): Promise<Array<{ name: string }>>;
    } } } }).options.sessions;

    const tools = await sessionFactory.options.resolveTools({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a',
      events: { tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1 },
    });
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__ops__inspect']);
    await mcp.close();
  });

  it('selects the pre-approved policy for MCP, Sandbox, and built-in durable tools', async () => {
    const mcp = new McpManager({
      ops: { transport: 'http', url: 'https://ops.example', toolCapabilities: { inspect: 'read' } },
    }, async () => ({
      listTools: async () => ({ tools: [{ name: 'inspect', inputSchema: {} }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'mcp' }] }), close: async () => undefined,
    }));
    const products = new ToolRegistry()
      .register(defineTool({
        name: 'builtin_probe', description: 'builtin', inputSchema: {}, capability: 'read',
        execute: async () => ({ id: '', content: 'builtin' }),
      }), 'aiop')
      .register(defineTool({
        name: 'sandbox_probe', description: 'sandbox', inputSchema: {}, capability: 'read',
        execute: async () => ({ id: '', content: 'sandbox' }),
      }), 'sandbox');
    const standard = { check: vi.fn(async () => ({ blocked: true, reason: 'standard' })) };
    const preApproved = { check: vi.fn(async () => ({ blocked: true, reason: 'pre-approved' })) };
    const factory = createDefaultDurableRunRuntime as unknown as (...args: unknown[]) => Promise<DurableRunManager>;
    const runtime = await factory(
      new MysqlStore({} as never),
      { id: 'configured', protocol: 'openai', baseURL: 'http://model.local/v1', apiKey: 'secret', model: 'custom-model' },
      'system prompt', true, mcp, standard, products, preApproved,
    );
    const sessionFactory = (runtime as unknown as { options: { sessions: { options: {
      resolveTools(input: unknown): Promise<Array<{ name: string; execute(...args: unknown[]): Promise<unknown> }>>;
    } } } }).options.sessions;
    const context = {
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      sessionId: 'session-a', execution: { unattended: true, preApproved: true },
      events: { tenantId: 'tenant-a', runId: 'run-a', attemptId: 'attempt-a', turnNo: 1 },
    };
    const tools = await sessionFactory.options.resolveTools(context);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['builtin_probe', 'mcp__ops__inspect', 'sandbox_probe']);
    for (const [index, tool] of tools.entries()) {
      await tool.execute(`call-${index}`, {}, new AbortController().signal, () => undefined, undefined).catch(() => undefined);
    }
    expect(preApproved.check).toHaveBeenCalledTimes(3);
    expect(standard.check).not.toHaveBeenCalled();

    const ordinary = await sessionFactory.options.resolveTools({ ...context, execution: { unattended: true } });
    await ordinary[0]!.execute('ordinary', {}, new AbortController().signal, () => undefined, undefined).catch(() => undefined);
    expect(standard.check).toHaveBeenCalledOnce();
    await mcp.close();
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
