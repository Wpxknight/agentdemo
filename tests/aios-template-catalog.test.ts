import { describe, expect, it, vi } from 'vitest';
import { logger } from '../packages/sandbox-runtime/src/logger.js';
import {
  AiosLifecycleHttpClient,
  AiosLifecycleHttpError,
} from '../packages/sandbox-runtime/src/aios-http.js';
import { AiosTemplateCatalog } from '../packages/sandbox-runtime/src/aios-template-catalog.js';

const API_KEY = 'complete-test-key';

function template(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    templateID: 'code-id',
    names: ['code-interpreter'],
    aliases: ['code'],
    buildStatus: 'ready',
    cpuCount: 2,
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

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function catalogWithResponse(body: unknown, overrides: Record<string, unknown> = {}) {
  const fetch = vi.fn(async () => jsonResponse(200, body)) as unknown as typeof globalThis.fetch;
  return {
    catalog: new AiosTemplateCatalog({
      lifecycleUrl: 'https://lifecycle.example.test/',
      apiKey: API_KEY,
      fetch,
      ...overrides,
    }),
    fetch,
  };
}

function streamedResponse(chunks: string[], headers?: Record<string, string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

describe('AiosTemplateCatalog', () => {
  it('normalizes, deduplicates, sorts, and fingerprints valid ready AIOS templates', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { catalog } = catalogWithResponse([
      template({
        templateID: 'diag-id',
        names: ['netdig'],
        aliases: ['diagnostics'],
        aios: {
          description: 'Network diagnostics',
          envType: 'code',
          runtimeRole: 'sandbox-diag',
          image: 'netdig:latest',
          defaultTimeoutHours: 0,
        },
      }),
      template({
        templateID: 'browser-id',
        names: [' browser '],
        aliases: ['web', ' web ', ''],
        aios: {
          description: 'Browser sandbox',
          envType: 'browser',
          runtimeRole: 'sandbox-reader',
          image: 'browser:latest',
          defaultTimeoutHours: 2,
        },
      }),
      template({
        templateID: 'browser-id',
        names: ['duplicate-browser'],
        aliases: [],
        aios: {
          description: 'Duplicate must not replace the first entry',
          envType: 'browser',
          runtimeRole: 'sandbox-reader',
          image: 'duplicate:latest',
          defaultTimeoutHours: 3,
        },
      }),
      template({ templateID: 'code-id' }),
      template({ templateID: 'pending-id', buildStatus: 'building' }),
      template({
        templateID: API_KEY,
        aios: {
          description: 'Malformed metadata',
          envType: 'code',
          runtimeRole: 'sandbox-reader',
          image: 'invalid:latest',
          defaultTimeoutHours: 1,
          unexpected: true,
        },
      }),
      { templateID: 'missing-metadata', names: ['invalid'], aliases: [], buildStatus: 'ready' },
    ]);

    const snapshot = await catalog.load();

    expect(snapshot.templates.map((item) => item.templateId)).toEqual([
      'browser-id',
      'code-id',
      'diag-id',
    ]);
    expect(snapshot.templates[0]).toEqual({
      templateId: 'browser-id',
      name: 'browser',
      aliases: ['web'],
      description: 'Browser sandbox',
      envType: 'browser',
      runtimeRole: 'sandbox-reader',
      image: 'browser:latest',
      defaultTimeoutMs: 7_200_000,
    });
    expect(snapshot.templates[2]).not.toHaveProperty('defaultTimeoutMs');
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.loadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const warnings = JSON.stringify(warn.mock.calls);
    expect(warnings).not.toContain(API_KEY);
    expect(warnings).not.toContain('Malformed metadata');
    expect(warnings).toContain('[redacted]');
    for (const [details] of warn.mock.calls) {
      expect(Object.keys(details as Record<string, unknown>).sort()).toEqual(
        expect.arrayContaining(['index', 'validationClass']),
      );
      expect(Object.keys(details as Record<string, unknown>))
        .toEqual(expect.not.arrayContaining(['apiKey', 'body', 'issues']));
    }
    warn.mockRestore();
  });

  it('computes the same fingerprint for canonical entries in a different order', async () => {
    const firstEntries = [
      template({ templateID: 'b-id', names: ['same-name'], aliases: ['zeta', 'alpha'] }),
      template({ templateID: 'a-id', names: ['same-name'], aliases: ['beta', 'alpha'] }),
    ];
    const secondEntries = [...firstEntries].reverse().map((entry) => ({
      ...entry,
      aliases: [...entry.aliases as string[]].reverse(),
    }));
    const first = await catalogWithResponse(firstEntries).catalog.load();
    const second = await catalogWithResponse(secondEntries).catalog.load();

    expect(first.templates.map((item) => item.templateId)).toEqual(['a-id', 'b-id']);
    expect(second.templates).toEqual(first.templates);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('ignores a ready template without a non-empty display name', async () => {
    const { catalog } = catalogWithResponse([
      template({ templateID: 'nameless-id', names: [' ', ''] }),
      template({ templateID: 'code-id' }),
    ]);

    await expect(catalog.load()).resolves.toMatchObject({
      templates: [expect.objectContaining({ templateId: 'code-id', name: 'code-interpreter' })],
    });
  });

  it('rejects a catalog with no usable ready templates', async () => {
    await expect(catalogWithResponse([]).catalog.load())
      .rejects.toThrow('AIOS Lifecycle template catalog has no usable templates');
    await expect(catalogWithResponse([
      template({ templateID: 'pending-id', buildStatus: 'building' }),
      template({ templateID: 'nameless-id', names: [' '] }),
    ]).catalog.load()).rejects.toThrow('AIOS Lifecycle template catalog has no usable templates');
  });

  it('rejects a non-array top-level response', async () => {
    const { catalog } = catalogWithResponse({ templates: [template()] });

    await expect(catalog.load()).rejects.toThrow('AIOS Lifecycle returned an invalid template catalog');
  });
});

describe('AiosLifecycleHttpClient safety', () => {
  it('sends authenticated JSON requests with redirects disabled and an abort signal', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://lifecycle.example.test/templates');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('x-api-key')).toBe(API_KEY);
      return jsonResponse(200, []);
    }) as unknown as typeof globalThis.fetch;
    const client = new AiosLifecycleHttpClient({
      lifecycleUrl: 'https://lifecycle.example.test///',
      apiKey: API_KEY,
      fetch,
    });

    await expect(client.requestJson('/templates')).resolves.toEqual({ body: [], status: 200 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('supports request-level timeout and response-size overrides', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      let calls = 0;
      const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        calls++;
        signals.push(init!.signal!);
        if (calls === 1) {
          return Promise.resolve(jsonResponse(200, { payload: 'x'.repeat(20) }));
        }
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
          void resolve;
        });
      }) as unknown as typeof globalThis.fetch;
      const client = new AiosLifecycleHttpClient({
        lifecycleUrl: 'https://lifecycle.example.test',
        apiKey: API_KEY,
        fetch,
        timeoutMs: 10,
        maxResponseBytes: 10,
      });

      await expect(client.requestJson('/large', {}, [], { maxResponseBytes: 100 }))
        .resolves.toMatchObject({ status: 200 });
      const pending = client.requestJson('/slow', {}, [], { timeoutMs: 25 })
        .catch((error: unknown) => String(error));
      await vi.advanceTimersByTimeAsync(10);
      expect(signals[1]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(15);
      await expect(pending).resolves.toContain('AIOS Lifecycle request failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns allowed non-success statuses and handles empty responses', async () => {
    const responses = [jsonResponse(408, { timedOut: true }), new Response(undefined, { status: 204 })];
    const fetch = vi.fn(async () => responses.shift()!) as unknown as typeof globalThis.fetch;
    const client = new AiosLifecycleHttpClient({
      lifecycleUrl: 'https://lifecycle.example.test',
      apiKey: API_KEY,
      fetch,
    });

    await expect(client.requestJson('/commands', { method: 'POST', body: {} }, [408]))
      .resolves.toEqual({ body: { timedOut: true }, status: 408 });
    await expect(client.requestJson('/sandboxes/id', { method: 'DELETE' }))
      .resolves.toEqual({ body: undefined, status: 204 });
  });

  it('sanitizes HTTP, network, and malformed JSON errors', async () => {
    const unauthorized = new AiosLifecycleHttpClient({
      lifecycleUrl: 'https://lifecycle.example.test',
      apiKey: API_KEY,
      fetch: vi.fn(async () => jsonResponse(401, { message: `bad key ${API_KEY}` })) as unknown as typeof globalThis.fetch,
    });
    const httpError = await unauthorized.requestJson('/templates').catch((error: unknown) => error);
    expect(httpError).toBeInstanceOf(AiosLifecycleHttpError);
    expect(httpError).toMatchObject({ status: 401 });
    expect(String(httpError)).toBe('AiosLifecycleHttpError: AIOS Lifecycle request failed (HTTP 401)');
    expect(String(httpError)).not.toContain(API_KEY);

    const offline = new AiosLifecycleHttpClient({
      lifecycleUrl: 'https://lifecycle.example.test',
      apiKey: API_KEY,
      fetch: vi.fn(async () => { throw new Error(`request failed for ${API_KEY}`); }) as unknown as typeof globalThis.fetch,
    });
    await expect(offline.requestJson('/templates')).rejects.toThrow('AIOS Lifecycle request failed');
    const networkError = await offline.requestJson('/templates').catch((error: unknown) => String(error));
    expect(networkError).not.toContain(API_KEY);

    const malformed = new AiosLifecycleHttpClient({
      lifecycleUrl: 'https://lifecycle.example.test',
      apiKey: API_KEY,
      fetch: vi.fn(async () => new Response(`{"key":"${API_KEY}"`, { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    const parseError = await malformed.requestJson('/templates').catch((error: unknown) => String(error));
    expect(parseError).toContain('AIOS Lifecycle returned an invalid JSON response');
    expect(parseError).not.toContain(API_KEY);
  });

  it('rejects content-length and streamed bodies above the configured limit', async () => {
    const declared = new AiosLifecycleHttpClient({
      lifecycleUrl: 'https://lifecycle.example.test',
      apiKey: API_KEY,
      maxResponseBytes: 10,
      fetch: vi.fn(async () => streamedResponse(['[]'], { 'content-length': '11' })) as unknown as typeof globalThis.fetch,
    });
    await expect(declared.requestJson('/templates'))
      .rejects.toThrow('AIOS Lifecycle response exceeded size limit');

    const streamed = new AiosLifecycleHttpClient({
      lifecycleUrl: 'https://lifecycle.example.test',
      apiKey: API_KEY,
      maxResponseBytes: 5,
      fetch: vi.fn(async () => streamedResponse(['[', '12345', ']'])) as unknown as typeof globalThis.fetch,
    });
    await expect(streamed.requestJson('/templates'))
      .rejects.toThrow('AIOS Lifecycle response exceeded size limit');
  });

  it('aborts requests after the configured timeout with a sanitized error', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(`timed out with ${API_KEY}`)), { once: true });
      })) as unknown as typeof globalThis.fetch;
      const client = new AiosLifecycleHttpClient({
        lifecycleUrl: 'https://lifecycle.example.test',
        apiKey: API_KEY,
        fetch,
        timeoutMs: 25,
      });

      const request = client.requestJson('/templates').catch((caught: unknown) => String(caught));
      await vi.advanceTimersByTimeAsync(25);
      const error = await request;
      expect(error).toContain('AIOS Lifecycle request failed');
      expect(error).not.toContain(API_KEY);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires safe positive client configuration', () => {
    const base = { lifecycleUrl: 'https://lifecycle.example.test', apiKey: API_KEY };
    expect(() => new AiosLifecycleHttpClient({ ...base, apiKey: '   ' })).toThrow('AIOS Sandbox Key is required');
    expect(() => new AiosLifecycleHttpClient({ ...base, lifecycleUrl: '   ' })).toThrow('AIOS Lifecycle URL is required');
    expect(() => new AiosLifecycleHttpClient({ ...base, timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => new AiosLifecycleHttpClient({ ...base, maxResponseBytes: 0 })).toThrow(/maxResponseBytes/);
  });
});
