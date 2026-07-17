const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

const REQUEST_FAILED_MESSAGE = 'AIOS Lifecycle request failed';
const RESPONSE_TOO_LARGE_MESSAGE = 'AIOS Lifecycle response exceeded size limit';

export class AiosLifecycleHttpError extends Error {
  constructor(readonly status: number) {
    super(`AIOS Lifecycle request failed (HTTP ${status})`);
    this.name = 'AiosLifecycleHttpError';
  }
}

export interface AiosLifecycleHttpOptions {
  lifecycleUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface AiosLifecycleRequestInit {
  method?: string;
  body?: unknown;
}

export interface AiosLifecycleRequestOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`AIOS ${name} must be a positive number`);
  }
  return value;
}

async function readBoundedBody(response: Response, maxResponseBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxResponseBytes) {
    throw new Error(RESPONSE_TOO_LARGE_MESSAGE);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(RESPONSE_TOO_LARGE_MESSAGE);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === RESPONSE_TOO_LARGE_MESSAGE) throw error;
    throw new Error(REQUEST_FAILED_MESSAGE);
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export class AiosLifecycleHttpClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly lifecycleUrl: string;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;

  constructor(opts: AiosLifecycleHttpOptions) {
    const apiKey = opts.apiKey ?? process.env.AIOS_SANDBOX_KEY ?? '';
    if (!apiKey.trim()) throw new Error('AIOS Sandbox Key is required');
    const lifecycleUrl = opts.lifecycleUrl.trim();
    if (!lifecycleUrl) throw new Error('AIOS Lifecycle URL is required');

    this.apiKey = apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.lifecycleUrl = lifecycleUrl.replace(/\/+$/, '');
    this.timeoutMs = positiveNumber(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.maxResponseBytes = positiveNumber(
      opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    );
  }

  async requestJson<T>(
    path: string,
    init: AiosLifecycleRequestInit = {},
    allowedStatuses: readonly number[] = [],
    requestOptions: AiosLifecycleRequestOptions = {},
  ): Promise<{ body: T; status: number }> {
    const timeoutMs = requestOptions.timeoutMs === undefined
      ? this.timeoutMs
      : positiveNumber(requestOptions.timeoutMs, 'request timeoutMs');
    const maxResponseBytes = requestOptions.maxResponseBytes === undefined
      ? this.maxResponseBytes
      : positiveNumber(requestOptions.maxResponseBytes, 'request maxResponseBytes');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchResponse(path, init, controller.signal);
      if (!response.ok && !allowedStatuses.includes(response.status)) {
        throw new AiosLifecycleHttpError(response.status);
      }
      if (response.status === 204) return { body: undefined as T, status: response.status };

      const bytes = await readBoundedBody(response, maxResponseBytes);
      try {
        const body = JSON.parse(new TextDecoder().decode(bytes)) as T;
        return { body, status: response.status };
      } catch {
        throw new Error(`AIOS Lifecycle returned an invalid JSON response (HTTP ${response.status})`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchResponse(
    path: string,
    init: AiosLifecycleRequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    let body: string | undefined;
    try {
      body = init.body === undefined ? undefined : JSON.stringify(init.body);
      return await this.fetchImpl(`${this.lifecycleUrl}${path.startsWith('/') ? path : `/${path}`}`, {
        method: init.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.apiKey },
        redirect: 'error',
        signal,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new Error(REQUEST_FAILED_MESSAGE);
    }
  }
}
