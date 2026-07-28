import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  created: [] as unknown[],
  connected: [] as unknown[],
  runCode: vi.fn(),
  runCommand: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  setTimeout: vi.fn(),
  kill: vi.fn(),
}));

vi.mock('@e2b/code-interpreter', () => {
  class Sandbox {
    readonly sandboxId = 'sb-e2b';
    readonly commands = { run: h.runCommand };
    readonly files = { read: h.readFile, write: h.writeFile };
    async runCode(code: string, opts?: unknown) {
      return h.runCode(code, opts);
    }
    async setTimeout(ms: number) { return h.setTimeout(ms); }
    async kill() { return h.kill(); }
    static async create(opts: unknown) {
      h.created.push(opts);
      return new Sandbox();
    }
    static async connect(sandboxId: string, opts: unknown) {
      h.connected.push({ sandboxId, opts });
      return new Sandbox();
    }
  }
  return { Sandbox };
});

const { E2bProvider } = await import('../src/sandbox/e2b.js');

beforeEach(() => {
  h.created.length = 0;
  h.connected.length = 0;
  h.runCode.mockReset();
  h.runCommand.mockReset();
  h.readFile.mockReset();
  h.writeFile.mockReset();
  h.setTimeout.mockReset();
  h.kill.mockReset();
  h.runCode.mockResolvedValue({ logs: { stdout: [], stderr: [] } });
  h.runCommand.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  h.readFile.mockResolvedValue(Uint8Array.from([1, 2, 3]));
  h.writeFile.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('E2bProvider standard SDK mode', () => {
  it('keeps the official SDK create option shape without AIOS-only fields', async () => {
    const p = new E2bProvider({ apiKey: 'key', domain: 'e2b.local' });

    await p.create({
      key: 'session:dev',
      template: 'kubectl:latest',
      namespace: 'aiop',
      serviceAccount: 'aiop-ops',
      timeoutMs: 12_345,
      envs: { A: 'one' },
      metadata: { cluster: 'dev' },
    });

    expect(h.created[0]).toEqual({
      apiKey: 'key',
      domain: 'e2b.local',
      template: 'kubectl:latest',
      timeoutMs: 12_345,
      envs: { A: 'one' },
      metadata: {
        cluster: 'dev',
        namespace: 'aiop',
        serviceAccount: 'aiop-ops',
      },
    });
    expect(h.created[0]).not.toHaveProperty('placement');
    expect(h.created[0]).not.toHaveProperty('lifecycleUrl');
  });

  it('passes the outer apiKey into explicit AIOS mode', async () => {
    const requests: Array<{ headers: Headers; body?: unknown }> = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        headers: new Headers(init?.headers),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      return requests.length === 1
        ? new Response(JSON.stringify({ sandboxID: 'sb-aios' }), { status: 201 })
        : new Response(JSON.stringify({ stdout: '', stderr: '', exitCode: 0 }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const p = new E2bProvider({
      apiKey: 'outer-aios-key',
      aios: {
        lifecycleUrl: 'http://aios.local',
        placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
        allowedTemplateIds: new Set(['code-interpreter']),
        fetch,
        readinessDelayMs: 0,
      },
    });

    await p.create({ key: 'session:dev', template: 'code-interpreter' });

    expect(requests[0].headers.get('x-api-key')).toBe('outer-aios-key');
    expect(requests[0].body).toMatchObject({
      placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
    });
    expect(h.created).toHaveLength(0);
  });

  it('uses the spec domain and E2B_API_KEY fallback for create and connect', async () => {
    vi.stubEnv('E2B_API_KEY', 'env-e2b-key');
    const p = new E2bProvider({ domain: 'provider.e2b.local' });

    await p.create({ key: 'session:dev', domain: 'cluster.e2b.local' });
    await p.connect('existing-sbx', {
      key: 'session:dev',
      domain: 'cluster.e2b.local',
      timeoutMs: 9000,
    });

    expect(h.created[0]).toMatchObject({
      apiKey: 'env-e2b-key',
      domain: 'cluster.e2b.local',
    });
    expect(h.connected[0]).toEqual({
      sandboxId: 'existing-sbx',
      opts: { apiKey: 'env-e2b-key', domain: 'cluster.e2b.local' },
    });
    expect(h.setTimeout).toHaveBeenCalledWith(9000);
  });

  it('preserves line breaks and forwards runCode output callbacks', async () => {
    h.runCode.mockImplementation(async (_code, opts) => {
      opts.onStdout({ line: 'live-out' });
      opts.onStderr({ line: 'live-err' });
      return {
        logs: {
          stdout: ['alpha', 'beta'],
          stderr: ['warn', 'again'],
        },
        error: { name: 'PythonError', value: 'bad code' },
      };
    });
    const output: unknown[] = [];
    const p = new E2bProvider({ apiKey: 'key' });
    const handle = await p.create({ key: 'session:dev' });
    const result = await handle.runCode('print("x")', {
      language: 'python',
      onOutput: (chunk) => output.push(chunk),
    });

    expect(h.runCode).toHaveBeenCalledWith('print("x")', expect.objectContaining({ language: 'python' }));
    expect(output).toEqual([
      { stream: 'stdout', text: 'live-out' },
      { stream: 'stderr', text: 'live-err' },
    ]);
    expect(result).toEqual({
      stdout: 'alpha\nbeta',
      stderr: 'warn\nagain',
      error: 'PythonError: bad code',
    });
  });

  it('forwards command options and supports file, timeout, and kill operations', async () => {
    h.runCommand.mockImplementation(async (_command, opts) => {
      opts.onStdout('out-chunk');
      opts.onStderr('err-chunk');
      return { stdout: 'out', stderr: 'err', exitCode: 7, error: 'failed' };
    });
    const output: unknown[] = [];
    const p = new E2bProvider({ apiKey: 'key' });
    const handle = await p.create({ key: 'session:dev' });

    await expect(handle.runCommand('exit 7', {
      timeoutMs: 4321,
      onOutput: (chunk) => output.push(chunk),
    })).resolves.toEqual({ stdout: 'out', stderr: 'err', exitCode: 7, error: 'failed' });
    expect(h.runCommand).toHaveBeenCalledWith('exit 7', expect.objectContaining({ timeoutMs: 4321 }));
    expect(output).toEqual([
      { stream: 'stdout', text: 'out-chunk' },
      { stream: 'stderr', text: 'err-chunk' },
    ]);

    await expect(handle.readFile('/home/user/file.bin')).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(h.readFile).toHaveBeenCalledWith('/home/user/file.bin', { format: 'bytes' });

    await handle.setTimeout(9876);
    await handle.kill();
    expect(h.setTimeout).toHaveBeenLastCalledWith(9876);
    expect(h.kill).toHaveBeenCalledOnce();
  });

  it('precreates credential files privately and fails when chmod cannot be confirmed', async () => {
    h.runCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'denied', exitCode: 1 });
    const handle = await new E2bProvider({ apiKey: 'key' }).create({ key: 'session:dev' });

    await expect(handle.writeFile?.('/workspace/secret/token.json', Uint8Array.from([1]), { mode: 0o600 }))
      .rejects.toThrow('denied');

    expect(h.runCommand.mock.calls[0]?.[0]).toContain('install -m 600');
    expect(h.writeFile).toHaveBeenCalledOnce();
  });
});
