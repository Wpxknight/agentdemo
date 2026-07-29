import {
  AiosLifecycleHttpClient,
  AiosLifecycleHttpError,
} from './aios-http.js';
import { posix } from 'node:path';
import { remoteWorkspacePath } from './workspace-path.js';
import type { AiosLifecycleHttpOptions } from './aios-http.js';
import type {
  ExecResult,
  OutputSink,
  RunCodeOpts,
  RunCommandOpts,
  SandboxCommand,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.js';

const READY_PROBE = 'true';
const DEFAULT_READY_ATTEMPTS = 20;
const DEFAULT_READY_DELAY_MS = 500;
const COMMAND_TRANSPORT_GRACE_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const FILE_RESPONSE_BYTES = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64 * 1024;

/** AIOS Lifecycle REST API 所需的固定调度位置。 */
export interface AiosSandboxPlacement {
  clusterId: string;
  namespace?: string;
}

export interface AiosE2bProviderOptions extends AiosLifecycleHttpOptions {
  /** Generic Key 创建所需的固定调度位置。 */
  placement: AiosSandboxPlacement;
  /** 当前 Runtime generation 从 AIOS 目录加载的模板 ID。 */
  allowedTemplateIds: ReadonlySet<string>;
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
  readonly supportsSecretFiles = true;

  constructor(
    readonly sandboxId: string,
    private readonly provider: AiosE2bProvider,
  ) {}

  workspacePath(relativePath = ''): string {
    return remoteWorkspacePath(relativePath);
  }

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

  async executeCommand(command: SandboxCommand, opts?: RunCommandOpts): Promise<ExecResult> {
    return this.runCommand(structuredCommand(command), {
      timeoutMs: command.timeoutMs ?? opts?.timeoutMs,
      onOutput: opts?.onOutput,
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this.provider.request<FileReadResponse>(
      `/sandboxes/${encodeURIComponent(this.sandboxId)}/filesystem/read`,
      { method: 'POST', body: { path, encoding: 'base64' } },
      { maxResponseBytes: FILE_RESPONSE_BYTES },
    );
    if (response.encoding !== 'base64' || typeof response.content !== 'string') {
      throw new Error('AIOS Lifecycle returned an invalid file response');
    }
    return Uint8Array.from(Buffer.from(response.content, 'base64'));
  }

  async writeFile(path: string, content: Uint8Array, options?: { mode?: number }): Promise<void> {
    const quotedPath = `'${path.replace(/'/g, `'"'"'`)}'`;
    if (options?.mode !== undefined) {
      const quotedDir = `'${posix.dirname(path).replace(/'/g, `'"'"'`)}'`;
      const prepared = await this.runCommand(
        `mkdir -p ${quotedDir} && install -m ${options.mode.toString(8)} /dev/null ${quotedPath}`,
      );
      if (prepared.error || prepared.exitCode !== 0) {
        throw new Error(prepared.error || prepared.stderr || '凭据文件安全初始化失败');
      }
    }
    await this.provider.request(`/sandboxes/${encodeURIComponent(this.sandboxId)}/filesystem/write`, {
      method: 'POST',
      body: { path, encoding: 'base64', content: Buffer.from(content).toString('base64') },
    });
    if (options?.mode !== undefined) {
      const secured = await this.runCommand(`chmod ${options.mode.toString(8)} ${quotedPath}`);
      if (secured.error || secured.exitCode !== 0) {
        throw new Error(secured.error || secured.stderr || '凭据文件权限设置失败');
      }
    }
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
      if (err instanceof AiosLifecycleHttpError && err.status === 404) return;
      throw err;
    }
  }
}

/** 通过 AIOS E2B-compatible Lifecycle REST API 创建和连接沙箱。 */
export class AiosE2bProvider implements SandboxProvider {
  private readonly http: AiosLifecycleHttpClient;
  private readonly readinessAttempts: number;
  private readonly readinessDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AiosE2bProviderOptions) {
    if (!opts.placement.clusterId) throw new Error('AIOS placement.clusterId is required');
    this.http = new AiosLifecycleHttpClient(opts);
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
    const template = this.assertTemplateAllowed(spec);
    if (spec.volumes?.length) throw new Error('AIOS Lifecycle mode does not support sandbox volumes');
    const timeout = timeoutSeconds(spec.timeoutMs);
    const response = await this.request<SandboxResponse>('/sandboxes', {
      method: 'POST',
      body: {
        template,
        ...(timeout === undefined ? {} : { timeout }),
        ...(spec.envs === undefined ? {} : { env: spec.envs }),
        ...(spec.metadata === undefined ? {} : { metadata: spec.metadata }),
        ...(spec.cpu === undefined && spec.memoryMb === undefined ? {} : {
          resources: {
            ...(spec.cpu === undefined ? {} : { cpu: spec.cpu }),
            ...(spec.memoryMb === undefined ? {} : { memoryMb: spec.memoryMb }),
          },
        }),
        ...(spec.network === undefined ? {} : { network: spec.network }),
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
    this.assertTemplateAllowed(spec);
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
    const response = await this.http.requestJson<CommandResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
      { method: 'POST', body: { command, ...(timeout === undefined ? {} : { timeout }) } },
      [408],
      { timeoutMs: (timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS) + COMMAND_TRANSPORT_GRACE_MS },
    );
    return response.status === 408 ? { ...response.body, timedOut: true } : response.body;
  }

  async request<T = unknown>(
    path: string,
    init: { method: string; body?: unknown },
    requestOptions: { timeoutMs?: number; maxResponseBytes?: number } = {},
  ): Promise<T> {
    return (await this.http.requestJson<T>(path, init, [], requestOptions)).body;
  }

  private assertTemplateAllowed(spec: SandboxSpec): string {
    const template = spec.template;
    if (!template || !this.opts.allowedTemplateIds.has(template)) {
      throw new Error('AIOS template is not present in the current AIOS template catalog');
    }
    return template;
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
        if (!(err instanceof AiosLifecycleHttpError) || err.status !== 409) throw err;
      }
      if (attempt + 1 < this.readinessAttempts) await this.sleep(this.readinessDelayMs);
    }
    throw new Error(`AIOS sandbox did not become ready: ${String(lastError)}`);
  }

}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function structuredCommand(command: SandboxCommand): string {
  const invocation = [command.program, ...(command.args ?? [])].map(shellQuote).join(' ');
  const env = Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  const withEnv = env ? `env ${env} ${invocation}` : invocation;
  return command.cwd ? `cd ${shellQuote(command.cwd)} && ${withEnv}` : withEnv;
}
