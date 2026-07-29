import { describe, expect, it, vi } from 'vitest';
import { AiosE2bProvider } from '../packages/sandbox-runtime/src/aios-e2b.js';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  body?: unknown;
}

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  });
}

function queuedFetch(responses: Response[]) {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      ...(init?.signal ? { signal: init.signal } : {}),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    const response = responses.shift();
    if (!response) throw new Error('unexpected fetch request');
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

function provider(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return new AiosE2bProvider({
    lifecycleUrl: 'http://aios.local:8080/',
    apiKey: 'secret-aios-key',
    placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
    allowedTemplateIds: new Set(['code-id', 'browser-id', 'diag-id']),
    fetch,
    readinessDelayMs: 0,
    sleep: vi.fn(async () => {}),
    ...overrides,
  });
}

describe('AiosE2bProvider', () => {
  it.each([
    ['create', '/sandboxes'],
    ['connect', '/sandboxes/remote/connect'],
  ] as const)('propagates an external abort signal through %s lifecycle requests', async (mode, suffix) => {
    let transportSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain(suffix);
      transportSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as unknown as typeof globalThis.fetch;
    const p = provider(fetch);
    const abort = new AbortController();
    const acquisition = mode === 'create'
      ? p.create({ key: 'abort-create', template: 'code-id' }, { signal: abort.signal })
      : p.connect('remote', { key: 'abort-connect', template: 'code-id' }, { signal: abort.signal });

    await vi.waitFor(() => expect(transportSignal).toBeInstanceOf(AbortSignal));
    expect(transportSignal?.aborted).toBe(false);
    abort.abort();
    await expect(Promise.race([
      acquisition,
      new Promise((_, reject) => setTimeout(() => reject(new Error('AIOS acquisition abort was not prompt')), 100)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(true);
  });

  it('rejects invalid readiness retry settings', () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    expect(() => provider(fetch, { readinessAttempts: 0 })).toThrow(/readinessAttempts/);
    expect(() => provider(fetch, { readinessDelayMs: -1 })).toThrow(/readinessDelayMs/);
  });

  it('creates an allowlisted browser template with fixed placement, converts timeout, and retries readiness', async () => {
    const { fetch, requests } = queuedFetch([
      jsonResponse(201, { sandboxID: 'sb-aios', state: 'starting' }),
      jsonResponse(409, { code: 'sandbox_not_ready' }),
      jsonResponse(200, { stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    ]);
    const sleep = vi.fn(async () => {});
    const p = provider(fetch, { sleep, readinessAttempts: 3 });

    const handle = await p.create({
      key: 'session:browser',
      template: 'browser-id',
      timeoutMs: 1501,
      envs: { A: 'one' },
      metadata: { sessionId: 'session', profile: 'code' },
      namespace: 'must-not-be-placement',
      serviceAccount: 'must-not-be-overridden',
    });

    expect(handle.sandboxId).toBe('sb-aios');
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      url: 'http://aios.local:8080/sandboxes',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'secret-aios-key',
      },
      body: {
        template: 'browser-id',
        timeout: 2,
        env: { A: 'one' },
        metadata: { sessionId: 'session', profile: 'code' },
        placement: { clusterId: 'local', namespace: 'aios-sandbox-local' },
      },
    });
    expect(requests[0].body).not.toHaveProperty('namespace');
    expect(requests[0].body).not.toHaveProperty('serviceAccount');
    expect(requests.slice(1).map((request) => request.body)).toEqual([
      { command: 'true' },
      { command: 'true' },
    ]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('deletes a newly-created sandbox when readiness never completes', async () => {
    const { fetch, requests } = queuedFetch([
      jsonResponse(201, { sandboxID: 'sb-stuck' }),
      jsonResponse(409, { code: 'sandbox_not_ready' }),
      jsonResponse(409, { code: 'sandbox_not_ready' }),
      jsonResponse(204),
    ]);
    const p = provider(fetch, { readinessAttempts: 2 });

    await expect(p.create({ key: 'session:code', template: 'code-id' }))
      .rejects.toThrow(/did not become ready/);
    expect(requests.at(-1)).toMatchObject({
      url: 'http://aios.local:8080/sandboxes/sb-stuck',
      method: 'DELETE',
    });
  });

  it('connects, renews the timeout, and verifies readiness', async () => {
    const { fetch, requests } = queuedFetch([
      jsonResponse(200, { sandboxID: 'sb-existing', state: 'running' }),
      jsonResponse(200, { stdout: '', stderr: '', exitCode: 0 }),
    ]);
    const p = provider(fetch);

    const handle = await p.connect('sb-existing', {
      key: 'session:code',
      template: 'code-id',
      timeoutMs: 60_001,
    });

    expect(handle.sandboxId).toBe('sb-existing');
    expect(requests[0]).toMatchObject({
      url: 'http://aios.local:8080/sandboxes/sb-existing/connect',
      method: 'POST',
      body: { timeout: 61 },
    });
    expect(requests[1].body).toEqual({ command: 'true' });
  });

  it('preserves nonzero exits and emits buffered output after the command response', async () => {
    const { fetch } = queuedFetch([
      jsonResponse(201, { id: 'sb-command' }),
      jsonResponse(200, { stdout: '', stderr: '', exitCode: 0 }),
      jsonResponse(200, { stdout: 'out', stderr: 'err', exitCode: 7, timedOut: false }),
    ]);
    const output: unknown[] = [];
    const handle = await provider(fetch).create({ key: 'session:code', template: 'code-id' });

    await expect(handle.runCommand('exit 7', {
      timeoutMs: 1001,
      onOutput: (chunk) => output.push(chunk),
    })).resolves.toEqual({ stdout: 'out', stderr: 'err', exitCode: 7 });
    expect(output).toEqual([
      { stream: 'stdout', text: 'out' },
      { stream: 'stderr', text: 'err' },
    ]);
  });

  it('preserves resource/network acquisition and structured command fields', async () => {
    const { fetch, requests } = queuedFetch([
      jsonResponse(201, { id: 'sb-structured' }),
      jsonResponse(200, { stdout: '', stderr: '', exitCode: 0 }),
      jsonResponse(200, { stdout: 'ok', stderr: '', exitCode: 0 }),
    ]);
    const handle = await provider(fetch).create({
      key: 'structured', template: 'code-id', cpu: 2, memoryMb: 2048, network: 'restricted',
    });
    await handle.executeCommand!({
      program: 'node', args: ['a b'], cwd: '/workspace', env: { TOKEN: 'x' }, timeoutMs: 1234,
    });

    expect(requests[0].body).toMatchObject({
      resources: { cpu: 2, memoryMb: 2048 }, network: 'restricted',
    });
    expect(requests[2].body).toEqual({
      command: "cd '/workspace' && env TOKEN='x' 'node' 'a b'", timeout: 2,
    });
  });

  it('keeps the transport request alive for the caller command timeout plus grace', async () => {
    vi.useFakeTimers();
    try {
      let recorded: RecordedRequest | undefined;
      const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        recorded = {
          url: String(input),
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          ...(init?.signal ? { signal: init.signal } : {}),
          ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
        };
        init?.signal?.addEventListener('abort', () => reject(new Error('transport aborted')), { once: true });
        setTimeout(() => resolve(jsonResponse(200, { stdout: 'done', stderr: '', exitCode: 0 })), 11_000);
      })) as unknown as typeof globalThis.fetch;
      const p = provider(fetch, { timeoutMs: 10_000 });

      const command = p.command('sb-command', 'sleep 30', 30_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(recorded?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(command).resolves.toMatchObject({ stdout: 'done', exitCode: 0 });
      expect(recorded?.body).toEqual({ command: 'sleep 30', timeout: 30 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the partial result from an HTTP 408 command timeout', async () => {
    const { fetch } = queuedFetch([
      jsonResponse(201, { sandboxID: 'sb-timeout' }),
      jsonResponse(200, { stdout: '', stderr: '', exitCode: 0 }),
      jsonResponse(408, { stdout: 'partial', stderr: 'timed out', exitCode: 137, timedOut: true }),
    ]);
    const handle = await provider(fetch).create({ key: 'session:code', template: 'code-id' });

    await expect(handle.runCommand('sleep 10', { timeoutMs: 20 }))
      .resolves.toEqual({
        stdout: 'partial',
        stderr: 'timed out',
        exitCode: 137,
        error: 'command timed out',
      });
  });

  it('runs code through an encoded interpreter command', async () => {
    const { fetch, requests } = queuedFetch([
      jsonResponse(201, { sandboxID: 'sb-code' }),
      jsonResponse(200, { stdout: '', stderr: '', exitCode: 0 }),
      jsonResponse(200, { stdout: '42\n', stderr: '', exitCode: 0 }),
    ]);
    const handle = await provider(fetch).create({ key: 'session:code', template: 'code-id' });
    expect(handle.workspacePath?.('skills/demo')).toBe('/workspace/skills/demo');
    expect(handle.supportsSecretFiles).toBe(true);
    expect(() => handle.workspacePath?.('../escape')).toThrow('escapes sandbox root');

    await expect(handle.runCode('console.log(42)', { language: 'javascript' }))
      .resolves.toEqual({ stdout: '42\n', stderr: '', exitCode: 0 });
    const command = (requests[2].body as { command: string }).command;
    expect(command).toContain(Buffer.from('console.log(42)', 'utf8').toString('base64'));
    expect(command).toMatch(/base64 -d \| node$/);
  });

  it('allows base64 file responses large enough for the export download limit', async () => {
    const content = Buffer.alloc(800_000, 7);
    const { fetch } = queuedFetch([
      jsonResponse(201, { sandboxID: 'sb-large' }),
      jsonResponse(200, { stdout: '', stderr: '', exitCode: 0 }),
      jsonResponse(200, {
        path: '/workspace/large.bin',
        encoding: 'base64',
        content: content.toString('base64'),
      }),
    ]);
    const handle = await provider(fetch).create({ key: 'session:code', template: 'code-id' });

    await expect(handle.readFile('/workspace/large.bin')).resolves.toEqual(Uint8Array.from(content));
  });

  it('reads base64 files, updates timeout, and treats a repeated 404 kill as success', async () => {
    const content = Uint8Array.from([0, 1, 2, 255]);
    const { fetch, requests } = queuedFetch([
      jsonResponse(201, { sandboxID: 'sb-files' }),
      jsonResponse(200, { stdout: '', stderr: '', exitCode: 0 }),
      jsonResponse(200, { path: '/workspace/file.bin', encoding: 'base64', content: Buffer.from(content).toString('base64') }),
      jsonResponse(200, { sandboxID: 'sb-files' }),
      jsonResponse(404, { code: 'not_found' }),
    ]);
    const handle = await provider(fetch).create({ key: 'session:code', template: 'code-id' });

    await expect(handle.readFile('/workspace/file.bin')).resolves.toEqual(content);
    await handle.setTimeout(1);
    await expect(handle.kill()).resolves.toBeUndefined();

    expect(requests[2].body).toEqual({ path: '/workspace/file.bin', encoding: 'base64' });
    expect(requests[3]).toMatchObject({
      url: 'http://aios.local:8080/sandboxes/sb-files/timeout',
      method: 'POST',
      body: { timeout: 1 },
    });
  });

  it('disables redirects on authenticated Lifecycle requests', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return jsonResponse(401, { code: 'redirect_blocked' });
    }) as unknown as typeof globalThis.fetch;

    await expect(provider(fetch).create({ key: 'session:code', template: 'code-id' }))
      .rejects.toThrow(/HTTP 401/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects missing, unknown, or volume-backed create specs before any HTTP request', async () => {
    const unused = vi.fn() as unknown as typeof globalThis.fetch;
    const p = provider(unused);

    await expect(p.create({ key: 'session:missing' }))
      .rejects.toThrow(/not present in the current AIOS template catalog/);
    await expect(p.create({ key: 'session:unknown', template: 'unknown-id' }))
      .rejects.toThrow(/not present in the current AIOS template catalog/);
    await expect(p.create({
      key: 'session:code',
      template: 'code-id',
      volumes: [{ name: 'home', hostPath: '/home/user', mountPath: '/mnt/home' }],
    })).rejects.toThrow(/does not support sandbox volumes/);
    expect(unused).not.toHaveBeenCalled();
  });

  it('rejects missing, unknown, or volume-backed connect specs before any HTTP request', async () => {
    const unused = vi.fn() as unknown as typeof globalThis.fetch;
    const p = provider(unused);

    await expect(p.connect('sb-existing', { key: 'session:missing' }))
      .rejects.toThrow(/not present in the current AIOS template catalog/);
    await expect(p.connect('sb-existing', { key: 'session:unknown', template: 'unknown-id' }))
      .rejects.toThrow(/not present in the current AIOS template catalog/);
    await expect(p.connect('sb-existing', {
      key: 'session:code',
      template: 'code-id',
      volumes: [{ name: 'home', hostPath: '/home/user', mountPath: '/mnt/home' }],
    })).rejects.toThrow(/does not support sandbox volumes/);
    expect(unused).not.toHaveBeenCalled();
  });

  it('never leaks the key in HTTP or network errors', async () => {
    const unauthorized = provider(vi.fn(async () => jsonResponse(401, {
      message: 'bad key secret-aios-key',
    })) as unknown as typeof globalThis.fetch);
    const authError = await unauthorized.create({ key: 'session:code', template: 'code-id' })
      .catch((error: unknown) => String(error));
    expect(authError).toContain('HTTP 401');
    expect(authError).not.toContain('secret-aios-key');

    const offline = provider(vi.fn(async () => {
      throw new Error('request with secret-aios-key failed');
    }) as unknown as typeof globalThis.fetch);
    const networkError = await offline.create({ key: 'session:code', template: 'code-id' })
      .catch((error: unknown) => String(error));
    expect(networkError).toContain('AIOS Lifecycle request failed');
    expect(networkError).not.toContain('secret-aios-key');
  });
});
