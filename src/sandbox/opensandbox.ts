import { Sandbox } from '@alibaba-group/opensandbox';
import type { ConnectionConfigOptions, Execution, ExecutionHandlers } from '@alibaba-group/opensandbox';
import type {
  ExecResult,
  OutputSink,
  RunCodeOpts,
  RunCommandOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.js';
import { joinLogText } from './output.js';

/**
 * OpenSandbox（阿里开源沙箱）后端：通过 @alibaba-group/opensandbox SDK
 * 对接其 Lifecycle + execd API，适配为统一的 SandboxProvider/SandboxHandle，
 * 与 E2bProvider 可互换（由 config.sandbox.provider 选择）。
 */
export interface OpenSandboxProviderOptions {
  /** Lifecycle API 域名（host[:port]，无 scheme）；缺省由 SDK 取 env / localhost:8080。 */
  domain?: string;
  /** http / https；缺省由 SDK 推断（默认 http）。 */
  protocol?: 'http' | 'https';
  /** API key（请求头 OPEN-SANDBOX-API-KEY）。 */
  apiKey?: string;
  /** 未指定 template 时的默认镜像。 */
  defaultImage?: string;
  /** 单请求超时（秒）。 */
  requestTimeoutSeconds?: number;
}

const DEFAULT_IMAGE = 'opensandbox/code-interpreter:latest';

/** 语言 → 解释器二进制（runCode 经命令执行）。 */
const INTERPRETERS: Record<string, string> = {
  python: 'python3', py: 'python3', python3: 'python3',
  javascript: 'node', js: 'node', node: 'node',
  bash: 'bash', sh: 'sh', shell: 'bash',
};

/** 把统一的 OutputSink 适配为 SDK 的 ExecutionHandlers（onStdout/onStderr 流式回调）。 */
function streamHandlers(onOutput?: OutputSink): ExecutionHandlers | undefined {
  if (!onOutput) return undefined;
  return {
    onStdout: (m) => onOutput({ stream: 'stdout', text: m.text }),
    onStderr: (m) => onOutput({ stream: 'stderr', text: m.text }),
  };
}

function toExecResult(exec: Execution): ExecResult {
  return {
    stdout: joinLogText(exec.logs.stdout.map((m) => m.text)),
    stderr: joinLogText(exec.logs.stderr.map((m) => m.text)),
    exitCode: exec.exitCode ?? undefined,
    error: exec.error ? `${exec.error.name}: ${exec.error.value}` : undefined,
  };
}

/** 把 OpenSandbox Sandbox 实例适配为统一的 SandboxHandle。 */
class OpenSandboxHandle implements SandboxHandle {
  constructor(private readonly sbx: Sandbox) {}

  get sandboxId(): string {
    return this.sbx.id;
  }

  async runCode(code: string, opts?: RunCodeOpts): Promise<ExecResult> {
    const interp = INTERPRETERS[(opts?.language ?? 'python').toLowerCase()] ?? 'python3';
    // 源码 base64 后经管道喂给解释器 stdin，规避引号 / 换行转义问题
    const b64 = Buffer.from(code, 'utf8').toString('base64');
    const exec = await this.sbx.commands.run(
      `echo ${b64} | base64 -d | ${interp}`,
      undefined,
      streamHandlers(opts?.onOutput),
    );
    return toExecResult(exec);
  }

  async runCommand(command: string, opts?: RunCommandOpts): Promise<ExecResult> {
    const exec = await this.sbx.commands.run(
      command,
      { timeoutSeconds: opts?.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : undefined },
      streamHandlers(opts?.onOutput),
    );
    return toExecResult(exec);
  }

  async setTimeout(ms: number): Promise<void> {
    await this.sbx.renew(Math.ceil(ms / 1000)); // 续期防回收
  }

  async kill(): Promise<void> {
    try {
      await this.sbx.kill();
    } finally {
      await this.sbx.close(); // 释放客户端 HTTP 资源
    }
  }
}

export class OpenSandboxProvider implements SandboxProvider {
  constructor(private readonly opts: OpenSandboxProviderOptions = {}) {}

  private connConfig(spec: SandboxSpec): ConnectionConfigOptions {
    return {
      domain: spec.domain ?? this.opts.domain,
      protocol: this.opts.protocol,
      apiKey: this.opts.apiKey,
      requestTimeoutSeconds: this.opts.requestTimeoutSeconds,
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const metadata = {
      ...(spec.key ? { aiop_key: spec.key } : {}),
      ...spec.metadata,
      ...(spec.namespace ? { namespace: spec.namespace } : {}),
      ...(spec.serviceAccount ? { serviceAccount: spec.serviceAccount } : {}),
    };
    const sbx = await Sandbox.create({
      connectionConfig: this.connConfig(spec),
      image: spec.template ?? this.opts.defaultImage ?? DEFAULT_IMAGE,
      timeoutSeconds: spec.timeoutMs ? Math.ceil(spec.timeoutMs / 1000) : undefined,
      env: spec.envs,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    });
    return new OpenSandboxHandle(sbx);
  }

  async connect(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> {
    const sbx = await Sandbox.connect({ connectionConfig: this.connConfig(spec), sandboxId });
    if (spec.timeoutMs) await sbx.renew(Math.ceil(spec.timeoutMs / 1000));
    return new OpenSandboxHandle(sbx);
  }
}
