import { describe, expect, it, vi } from 'vitest';

const e2b = vi.hoisted(() => ({ killed: vi.fn(), files: new Map<string, Uint8Array>() }));
vi.mock('@e2b/code-interpreter', () => {
  class Sandbox {
    readonly sandboxId = 'e2b-real-adapter';
    readonly commands = { run: async (command: string, options?: { onStdout?: (text: string) => void }) => {
      options?.onStdout?.(command);
      return { stdout: command, stderr: '', exitCode: 0 };
    } };
    readonly files = {
      write: async (path: string, content: ArrayBuffer) => { e2b.files.set(path, new Uint8Array(content)); },
      read: async (path: string) => e2b.files.get(path) ?? new Uint8Array(),
    };
    async runCode(code: string) { return { logs: { stdout: [code], stderr: [] } }; }
    async setTimeout() {}
    async kill() { e2b.killed(); }
    static async create() { return new Sandbox(); }
    static async connect() { return new Sandbox(); }
  }
  return { Sandbox };
});

const open = vi.hoisted(() => ({ killed: vi.fn(), closed: vi.fn(), files: new Map<string, Uint8Array>() }));
vi.mock('@alibaba-group/opensandbox', () => {
  class Sandbox {
    readonly id = 'open-real-adapter';
    readonly commands = { run: async (command: string) => ({
      logs: { stdout: [{ text: command }], stderr: [] }, exitCode: 0,
    }) };
    readonly files = {
      writeFiles: async (files: Array<{ path: string; data: Uint8Array }>) => {
        for (const file of files) open.files.set(file.path, file.data);
      },
      readBytes: async (path: string) => open.files.get(path) ?? new Uint8Array(),
    };
    async renew() {}
    async kill() { open.killed(); }
    async close() { open.closed(); }
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

describe('concrete sandbox provider contract', () => {
  it('runs LocalSandboxProvider lifecycle', async () => {
    const runtime = new SandboxRuntime({ providerName: 'local', provider: new LocalSandboxProvider() });
    const lease = await runtime.acquire({ spec: { key: 'local-real' } });
    await expect(runtime.execute({ lease, command: { program: process.execPath, args: ['-e', "process.stdout.write('ok')"] } }))
      .resolves.toMatchObject({ stdout: 'ok', exitCode: 0 });
    await runtime.release({ lease });
  });

  it('runs E2bProvider lifecycle through its SDK adapter', async () => {
    const runtime = new SandboxRuntime({ providerName: 'e2b', provider: new E2bProvider({ apiKey: 'key' }) });
    await exerciseFiles(runtime, 'e2b');
    expect(e2b.killed).toHaveBeenCalled();
  });

  it('runs OpenSandboxProvider lifecycle through its SDK adapter', async () => {
    const runtime = new SandboxRuntime({ providerName: 'opensandbox', provider: new OpenSandboxProvider() });
    await exerciseFiles(runtime, 'opensandbox');
    expect(open.killed).toHaveBeenCalled();
    expect(open.closed).toHaveBeenCalled();
  });

  it('runs AiosE2bProvider lifecycle through its HTTP adapter', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const files = new Map<string, Uint8Array>();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ url, body });
      if (url.endsWith('/sandboxes') && init?.method === 'POST') return json({ id: 'aios-real-adapter' }, 201);
      if (url.endsWith('/commands')) return json({ stdout: '', stderr: '', exitCode: 0 });
      if (url.endsWith('/filesystem/write')) {
        const value = body as { path: string; content: string };
        files.set(value.path, Uint8Array.from(Buffer.from(value.content, 'base64')));
        return json({});
      }
      if (url.endsWith('/filesystem/read')) {
        const value = body as { path: string };
        return json({ encoding: 'base64', content: Buffer.from(files.get(value.path) ?? []).toString('base64') });
      }
      return new Response(undefined, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const provider = new AiosE2bProvider({
      lifecycleUrl: 'http://aios.local', apiKey: 'key', placement: { clusterId: 'local' },
      allowedTemplateIds: new Set(['code']), fetch, readinessDelayMs: 0,
    });
    const runtime = new SandboxRuntime({ providerName: 'aios', provider });
    const lease = await runtime.acquire({ spec: { key: 'aios', template: 'code' } });
    await runtime.upload({ lease, file: { path: '/workspace/a', content: new Uint8Array([4, 5]) } });
    await expect(runtime.download({ lease, path: '/workspace/a' }))
      .resolves.toEqual({ path: '/workspace/a', content: new Uint8Array([4, 5]) });
    await runtime.release({ lease });
    expect(requests.some((request) => request.url.endsWith('/filesystem/read'))).toBe(true);
  });
});

async function exerciseFiles(runtime: InstanceType<typeof SandboxRuntime>, providerName: string): Promise<void> {
  const lease = await runtime.acquire({ spec: { key: providerName } });
  await runtime.upload({ lease, file: { path: '/workspace/a', content: new Uint8Array([1, 2, 3]) } });
  await expect(runtime.download({ lease, path: '/workspace/a' }))
    .resolves.toEqual({ path: '/workspace/a', content: new Uint8Array([1, 2, 3]) });
  await runtime.release({ lease });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
