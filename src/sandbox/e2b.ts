import { Sandbox } from '@e2b/code-interpreter';
import { AiosE2bProvider } from './aios-e2b.js';
import type { AiosE2bProviderOptions } from './aios-e2b.js';
import type {
  ExecResult,
  RunCodeOpts,
  RunCommandOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.js';
import { joinLogText } from './output.js';

export interface E2bProviderOptions {
  /** E2B API key；缺省读 E2B_API_KEY 环境变量。 */
  apiKey?: string;
  /** 自定义 E2B API 域名（自托管 / 集群内网关）。 */
  domain?: string;
  /** 配置时改走 AIOS Lifecycle REST；未配置时保持官方 E2B SDK 路径。 */
  aios?: AiosE2bProviderOptions;
}

type E2bCreateOptions = {
  apiKey?: string;
  domain?: string;
  template?: string;
  timeoutMs?: number;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
};

/** 把 E2B Sandbox 实例适配为统一的 SandboxHandle。 */
class E2bHandle implements SandboxHandle {
  constructor(private readonly sbx: Sandbox) {}

  get sandboxId(): string {
    return this.sbx.sandboxId;
  }

  async runCode(code: string, opts?: RunCodeOpts): Promise<ExecResult> {
    const onOutput = opts?.onOutput;
    const exec = await this.sbx.runCode(code, {
      language: opts?.language as never,
      onStdout: onOutput ? (m) => onOutput({ stream: 'stdout', text: m.line }) : undefined,
      onStderr: onOutput ? (m) => onOutput({ stream: 'stderr', text: m.line }) : undefined,
    });
    return {
      stdout: joinLogText(exec.logs.stdout),
      stderr: joinLogText(exec.logs.stderr),
      error: exec.error ? `${exec.error.name}: ${exec.error.value}` : undefined,
    };
  }

  async runCommand(command: string, opts?: RunCommandOpts): Promise<ExecResult> {
    const onOutput = opts?.onOutput;
    const res = await this.sbx.commands.run(command, {
      timeoutMs: opts?.timeoutMs,
      onStdout: onOutput ? (data: string) => onOutput({ stream: 'stdout', text: data }) : undefined,
      onStderr: onOutput ? (data: string) => onOutput({ stream: 'stderr', text: data }) : undefined,
    });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      error: res.error,
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.sbx.files.read(path, { format: 'bytes' });
  }

  async setTimeout(ms: number): Promise<void> {
    await this.sbx.setTimeout(ms);
  }

  async kill(): Promise<void> {
    await this.sbx.kill();
  }
}

/** 基于 @e2b/code-interpreter 的沙箱后端：新建 / 连接远端。 */
export class E2bProvider implements SandboxProvider {
  private readonly aios?: AiosE2bProvider;

  constructor(private readonly opts: E2bProviderOptions = {}) {
    this.aios = opts.aios
      ? new AiosE2bProvider({ ...opts.aios, apiKey: opts.aios.apiKey ?? opts.apiKey })
      : undefined;
  }

  private connectOpts(spec: SandboxSpec) {
    return {
      apiKey: this.opts.apiKey ?? process.env.E2B_API_KEY,
      domain: spec.domain ?? this.opts.domain,
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (this.aios) return this.aios.create(spec);
    const metadata = {
      ...spec.metadata,
      ...(spec.namespace ? { namespace: spec.namespace } : {}),
      ...(spec.serviceAccount ? { serviceAccount: spec.serviceAccount } : {}),
    };
    const opts: E2bCreateOptions = {
      ...this.connectOpts(spec),
      template: spec.template,
      timeoutMs: spec.timeoutMs,
      envs: spec.envs,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
    const sbx = await Sandbox.create(opts);
    return new E2bHandle(sbx);
  }

  async connect(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> {
    if (this.aios) return this.aios.connect(sandboxId, spec);
    const sbx = await Sandbox.connect(sandboxId, this.connectOpts(spec));
    if (spec.timeoutMs) await sbx.setTimeout(spec.timeoutMs); // 续命防回收
    return new E2bHandle(sbx);
  }
}
