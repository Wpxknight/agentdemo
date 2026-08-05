import { describe, expect, it, vi } from 'vitest';
import type { SandboxCommand, SandboxProvider } from '../../packages/sandbox-runtime/src/types.js';

const e2b = vi.hoisted(() => ({ killed: vi.fn() }));
vi.mock('@e2b/code-interpreter', () => {
  class Sandbox {
    readonly sandboxId = `e2b-real-adapter-${Math.random()}`;
    readonly commands = {
      run: async (command: string, options?: {
        onStdout?: (text: string) => void;
        onStderr?: (text: string) => void;
      }) => {
        if (command === 'wait') return new Promise(() => undefined);
        options?.onStdout?.('provider-out');
        options?.onStderr?.('provider-err');
        return { stdout: 'provider-out', stderr: 'provider-err', exitCode: 0 };
      },
    };
    readonly files = { read: async () => new Uint8Array(), write: async () => undefined };
    async runCode() { return { logs: { stdout: [], stderr: [] } }; }
    async setTimeout() {}
    async kill() { e2b.killed(this.sandboxId); }
    static async create() { return new Sandbox(); }
    static async connect() { return new Sandbox(); }
  }
  return { Sandbox };
});

const open = vi.hoisted(() => ({ killed: vi.fn(), closed: vi.fn() }));
vi.mock('@alibaba-group/opensandbox', () => {
  class Sandbox {
    readonly id = `open-real-adapter-${Math.random()}`;
    readonly commands = {
      run: async (
        command: string,
        _options?: unknown,
        handlers?: { onStdout?: (chunk: { text: string }) => void; onStderr?: (chunk: { text: string }) => void },
      ) => {
        if (command === 'wait') return new Promise(() => undefined);
        handlers?.onStdout?.({ text: 'provider-out' });
        handlers?.onStderr?.({ text: 'provider-err' });
        return {
          logs: { stdout: [{ text: 'provider-out' }], stderr: [{ text: 'provider-err' }] },
          exitCode: 0,
        };
      },
    };
    readonly files = { readBytes: async () => new Uint8Array(), writeFiles: async () => undefined };
    async renew() {}
    async kill() { open.killed(this.id); }
    async close() { open.closed(this.id); }
    static async create() { return new Sandbox(); }
    static async connect() { return new Sandbox(); }
  }
  return { Sandbox };
});

const { SandboxRuntime } = await import('../../packages/sandbox-runtime/src/runtime.js');
const { LocalSandboxProvider } = await import('../../packages/sandbox-runtime/src/local.js');
const { E2bProvider } = await import('../../packages/sandbox-runtime/src/e2b.js');
const { OpenSandboxProvider } = await import('../../packages/sandbox-runtime/src/opensandbox.js');
const { AiosE2bProvider } = await import('../../packages/sandbox-runtime/src/aios-e2b.js');

interface RealProviderHarness {
  name: string;
  provider: SandboxProvider;
  spec: { key: string; template?: string };
  outputCommand: string | SandboxCommand;
  waitCommand: string | SandboxCommand;
  /** SDK/HTTP fakes expose kill calls; the real Local handle is verified through lease invalidation. */
  killCount?: () => number;
}

function localHarness(): RealProviderHarness {
  return {
    name: 'local',
    provider: new LocalSandboxProvider(),
    spec: { key: 'local-real' },
    outputCommand: {
      program: process.execPath,
      args: ['-e', "process.stdout.write('provider-out');process.stderr.write('provider-err')"],
    },
    waitCommand: { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
  };
}

function e2bHarness(): RealProviderHarness {
  return {
    name: 'e2b', provider: new E2bProvider({ apiKey: 'key' }), spec: { key: 'e2b-real' },
    outputCommand: 'emit-output', waitCommand: 'wait', killCount: () => e2b.killed.mock.calls.length,
  };
}

function openHarness(): RealProviderHarness {
  return {
    name: 'opensandbox', provider: new OpenSandboxProvider(), spec: { key: 'open-real' },
    outputCommand: 'emit-output', waitCommand: 'wait', killCount: () => open.killed.mock.calls.length,
  };
}

function aiosHarness(): RealProviderHarness {
  let sequence = 0;
  let kills = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { command?: string } : undefined;
    if (url.endsWith('/sandboxes') && init?.method === 'POST') return json({ id: `aios-real-${++sequence}` }, 201);
    if (url.endsWith('/commands')) {
      if (body?.command === 'wait') return new Promise<Response>(() => undefined);
      if (body?.command === 'true') return json({ stdout: '', stderr: '', exitCode: 0 });
      return json({ stdout: 'provider-out', stderr: 'provider-err', exitCode: 0 });
    }
    if (init?.method === 'DELETE') kills += 1;
    return new Response(undefined, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
  return {
    name: 'aios',
    provider: new AiosE2bProvider({
      lifecycleUrl: 'http://aios.local', apiKey: 'key', placement: { clusterId: 'local' },
      allowedTemplateIds: new Set(['code']), fetch, readinessDelayMs: 0,
    }),
    spec: { key: 'aios-real', template: 'code' }, outputCommand: 'emit-output', waitCommand: 'wait',
    killCount: () => kills,
  };
}

describe.each([
  ['LocalSandboxProvider', localHarness],
  ['E2bProvider', e2bHarness],
  ['OpenSandboxProvider', openHarness],
  ['AiosE2bProvider', aiosHarness],
] as const)('%s real-provider runtime contract', (_providerClass, makeHarness) => {
  it('covers acquire, execute, output, stop, and release', async () => {
    const harness = makeHarness();
    const runtime = new SandboxRuntime({ providerName: harness.name, provider: harness.provider });
    const before = harness.killCount?.();
    const lease = await runtime.acquire({ spec: harness.spec });
    const chunks: Array<{ stream: string; text: string }> = [];

    await expect(runtime.execute({ lease, command: harness.outputCommand, onOutput: (chunk) => chunks.push(chunk) }))
      .resolves.toMatchObject({ stdout: 'provider-out', stderr: 'provider-err', exitCode: 0 });
    expect(chunks).toEqual([
      { stream: 'stdout', text: 'provider-out' },
      { stream: 'stderr', text: 'provider-err' },
    ]);
    await runtime.stop({ lease });
    await expect(runtime.execute({ lease, command: harness.outputCommand }))
      .rejects.toThrow('lease is not active');
    await runtime.release({ lease });
    if (harness.killCount) expect(harness.killCount()).toBe(before! + 1);

    const released = await runtime.acquire({ spec: { ...harness.spec, key: `${harness.spec.key}-release` } });
    await runtime.release({ lease: released });
    await expect(runtime.execute({ lease: released, command: harness.outputCommand }))
      .rejects.toThrow('lease is not active');
    if (harness.killCount) expect(harness.killCount()).toBe(before! + 2);
  });

  it('kills the acquired handle on timeout', async () => {
    const harness = makeHarness();
    const runtime = new SandboxRuntime({ providerName: harness.name, provider: harness.provider });
    const before = harness.killCount?.();
    const lease = await runtime.acquire({ spec: { ...harness.spec, key: `${harness.spec.key}-timeout` } });

    await expect(runtime.execute({ lease, command: harness.waitCommand, timeoutMs: 5 })).resolves.toEqual({
      stdout: '', stderr: '', exitCode: 124, error: 'command timed out', timedOut: true,
    });
    await expect(runtime.execute({ lease, command: harness.outputCommand }))
      .rejects.toThrow('lease is not active');
    if (harness.killCount) expect(harness.killCount()).toBe(before! + 1);
  });

  it('kills the acquired handle on abort', async () => {
    const harness = makeHarness();
    const runtime = new SandboxRuntime({ providerName: harness.name, provider: harness.provider });
    const before = harness.killCount?.();
    const lease = await runtime.acquire({ spec: { ...harness.spec, key: `${harness.spec.key}-abort` } });
    const abort = new AbortController();
    const execution = runtime.execute({ lease, command: harness.waitCommand, signal: abort.signal });
    abort.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    await expect(runtime.execute({ lease, command: harness.outputCommand }))
      .rejects.toThrow('lease is not active');
    if (harness.killCount) {
      await vi.waitFor(() => expect(harness.killCount!()).toBe(before! + 1));
    }
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
