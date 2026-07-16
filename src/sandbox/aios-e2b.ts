import type {
  ExecResult,
  OutputSink,
  RunCodeOpts,
  RunCommandOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.js';

const READY_PROBE = 'true';
const CODE_INTERPRETER_TEMPLATE = 'code-interpreter';
const DEFAULT_READY_ATTEMPTS = 20;
const DEFAULT_READY_DELAY_MS = 500;

/** AIOS Lifecycle REST API 所需的固定调度位置。 */
export interface AiosSandboxPlacement {
  clusterId: string;
  namespace?: string;
}

export interface AiosE2bProviderOptions {
  /** AIOS Lifecycle API 完整 URL（含 http(s) scheme）。 */
  lifecycleUrl: string;
  /** AIOS Sandbox Key；缺省读 AIOS_SANDBOX_KEY，不回退 E2B_API_KEY。 */
  apiKey?: string;
  /** Generic Key 创建所需的固定调度位置。 */
  placement: AiosSandboxPlacement;
  /** 可注入 HTTP 客户端，供测试 mock Lifecycle 请求。 */
  fetch?: typeof globalThis.fetch;
  /** readiness probe 最大次数；仅供测试或特殊部署调整。 */
  readinessAttempts?: number;
  /** readiness probe 重试间隔(ms)。 */
  readinessDelayMs?: number;
  /** 可注入等待函数，避免测试实际等待。 */
  sleep?: (ms: number) => Promise<void>;
}

type SandboxResponse = { sandboxID?: string; id?: string };
type CommandResponse = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
};
type FileReadResponse = { content?: string; encoding?: string };

class LifecycleHttpError extends Error {
  constructor(readonly status: number) {
    super(`AIOS Lifecycle request failed (HTTP ${status})`);
    this.name = 'LifecycleHttpError';
  }
}

function timeoutSeconds(ms?: number): number | undefined {
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}

function interpreter(language?: string): string {
  const normalized = (language ?? 'python').toLowerCase();
  if (['javascript', 'js', 'node'].includes(normalized)) return 'node';
  if (['bash', 'sh', 'shell'].includes(normalized)) return normalized === 'sh' ? 'sh' : 'bash';
  return 'python3';
}

function emitOutput(onOutput: OutputSink | undefined, result: ExecResult): void {
  if (!onOutput) return;
  if (result.stdout) onOutput({ stream: 'stdout', text: result.stdout });
  if (result.stderr) onOutput({ stream: 'stderr', text: result.stderr });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** AIOS Lifecycle REST 的 SandboxHandle 适配器。 */
class AiosE2bHandle implements SandboxHandle {
  constructor(
    readonly sandboxId: string,
    private readonly provider: AiosE2bProvider,
  ) {}

  async runCode(code: string, opts?: RunCodeOpts): Promise<ExecResult> {
    // Lifecycle 仅支持 buffered commands；编码后经 stdin 传入，避免引号和换行转义。
    const encoded = Buffer.from(code, 'utf8').toString('base64');
    return this.runCommand(`printf '%s' ${encoded} | base64 -d | ${interpreter(opts?.language)}`, opts);
  }

  async runCommand(command: string, opts?: RunCommandOpts): Promise<ExecResult> {
    const response = await this.provider.command(this.sandboxId, command, opts?.timeoutMs);
    const result: ExecResult = {
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      exitCode: response.exitCode,
      ...(response.timedOut ? { error: 'command timed out' } : {}),
    };
    emitOutput(opts?.onOutput, result);
    return result;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this.provider.request<FileReadResponse>(
      `/sandboxes/${encodeURIComponent(this.sandboxId)}/filesystem/read`,
      { method: 'POST', body: { path, encoding: 'base64' } },
    );
    if (response.encoding !== 'base64' || typeof response.content !== 'string') {
      throw new Error('AIOS Lifecycle returned an invalid file response');
    }
    return Uint8Array.from(Buffer.from(response.content, 'base64'));
  }

  async setTimeout(ms: number): Promise<void> {
    await this.provider.request(
      `/sandboxes/${encodeURIComponent(this.sandboxId)}/timeout`,
      { method: 'POST', body: { timeout: timeoutSeconds(ms) } },
    );
  }

  async kill(): Promise<void> {
    try {
      await this.provider.request(`/sandboxes/${encodeURIComponent(this.sandboxId)}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof LifecycleHttpError && err.status === 404) return;
      throw err;
    }
  }
}

/** 通过 AIOS E2B-compatible Lifecycle REST API 创建和连接沙箱。 */
export class AiosE2bProvider implements SandboxProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly lifecycleUrl: string;
  private readonly readinessAttempts: number;
  private readonly readinessDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AiosE2bProviderOptions) {
    this.apiKey = opts.apiKey ?? process.env.AIOS_SANDBOX_KEY ?? '';
    if (!this.apiKey) throw new Error('AIOS Sandbox Key is required');
    if (!opts.lifecycleUrl) throw new Error('AIOS Lifecycle URL is required');
    if (!opts.placement.clusterId) throw new Error('AIOS placement.clusterId is required');
    this.lifecycleUrl = opts.lifecycleUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.readinessAttempts = opts.readinessAttempts ?? DEFAULT_READY_ATTEMPTS;
    this.readinessDelayMs = opts.readinessDelayMs ?? DEFAULT_READY_DELAY_MS;
    if (!Number.isInteger(this.readinessAttempts) || this.readinessAttempts < 1) {
      throw new Error('AIOS readinessAttempts must be a positive integer');
    }
    if (!Number.isFinite(this.readinessDelayMs) || this.readinessDelayMs < 0) {
      throw new Error('AIOS readinessDelayMs must be a non-negative number');
    }
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.volumes?.length) throw new Error('AIOS Lifecycle mode does not support sandbox volumes');
    if (spec.template !== CODE_INTERPRETER_TEMPLATE) {
      throw new Error(`AIOS Lifecycle mode requires template=${CODE_INTERPRETER_TEMPLATE}`);
    }
    const timeout = timeoutSeconds(spec.timeoutMs);
    const response = await this.request<SandboxResponse>('/sandboxes', {
      method: 'POST',
      body: {
        ...(spec.template === undefined ? {} : { template: spec.template }),
        ...(timeout === undefined ? {} : { timeout }),
        ...(spec.envs === undefined ? {} : { env: spec.envs }),
        ...(spec.metadata === undefined ? {} : { metadata: spec.metadata }),
        placement: this.opts.placement,
      },
    });
    const sandboxId = response.sandboxID ?? response.id;
    if (!sandboxId) throw new Error('AIOS Lifecycle create response did not contain a sandbox ID');
    const handle = new AiosE2bHandle(sandboxId, this);
    try {
      await this.waitUntilReady(handle);
      return handle;
    } catch (err) {
      await handle.kill().catch(() => {});
      throw err;
    }
  }

  async connect(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.volumes?.length) throw new Error('AIOS Lifecycle mode does not support sandbox volumes');
    const timeout = timeoutSeconds(spec.timeoutMs);
    await this.request<SandboxResponse>(`/sandboxes/${encodeURIComponent(sandboxId)}/connect`, {
      method: 'POST',
      body: timeout === undefined ? {} : { timeout },
    });
    const handle = new AiosE2bHandle(sandboxId, this);
    await this.waitUntilReady(handle);
    return handle;
  }

  async command(sandboxId: string, command: string, timeoutMs?: number): Promise<CommandResponse> {
    const timeout = timeoutSeconds(timeoutMs);
    const response = await this.fetchJson<CommandResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
      { method: 'POST', body: { command, ...(timeout === undefined ? {} : { timeout }) } },
      [408],
    );
    return response.status === 408 ? { ...response.body, timedOut: true } : response.body;
  }

  async request<T = unknown>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    return (await this.fetchJson<T>(path, init)).body;
  }

  private async waitUntilReady(handle: AiosE2bHandle): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.readinessAttempts; attempt += 1) {
      try {
        const result = await handle.runCommand(READY_PROBE);
        if (result.exitCode === undefined || result.exitCode === 0) return;
        lastError = new Error(`AIOS sandbox readiness probe exited with code ${result.exitCode}`);
      } catch (err) {
        lastError = err;
        if (!(err instanceof LifecycleHttpError) || err.status !== 409) throw err;
      }
      if (attempt + 1 < this.readinessAttempts) await this.sleep(this.readinessDelayMs);
    }
    throw new Error(`AIOS sandbox did not become ready: ${String(lastError)}`);
  }

  private async fetchJson<T>(
    path: string,
    init: { method: string; body?: unknown },
    allowedStatuses: number[] = [],
  ): Promise<{ body: T; status: number }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.lifecycleUrl}${path}`, {
        method: init.method,
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.apiKey },
        redirect: 'error',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new Error('AIOS Lifecycle request failed');
    }
    if (!response.ok && !allowedStatuses.includes(response.status)) throw new LifecycleHttpError(response.status);
    if (response.status === 204) return { body: undefined as T, status: response.status };
    try {
      return { body: await response.json() as T, status: response.status };
    } catch {
      throw new Error(`AIOS Lifecycle returned an invalid response (HTTP ${response.status})`);
    }
  }
}
