import { createHash } from 'node:crypto';
import { posix } from 'node:path';
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
const K8S_LABEL_VALUE = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

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

function safeK8sLabelValue(value: string): string {
  if (K8S_LABEL_VALUE.test(value)) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  const suffix = `-${hash}`;
  const budget = 63 - suffix.length;
  const normalized = value
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');
  const prefix = (normalized || 'value')
    .slice(0, budget)
    .replace(/[^A-Za-z0-9]+$/, '') || 'value';
  return `${prefix}${suffix}`;
}

function safeMetadataValues(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, safeK8sLabelValue(value)]),
  );
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

  async readFile(path: string): Promise<Uint8Array> {
    return this.sbx.files.readBytes(path);
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
    await this.sbx.files.writeFiles([{ path, data: content }]);
    if (options?.mode !== undefined) {
      const secured = await this.runCommand(`chmod ${options.mode.toString(8)} ${quotedPath}`);
      if (secured.error || secured.exitCode !== 0) {
        throw new Error(secured.error || secured.stderr || '凭据文件权限设置失败');
      }
    }
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
    const metadata = safeMetadataValues({
      ...(spec.key ? { aiop_key: spec.key } : {}),
      ...spec.metadata,
      ...(spec.namespace ? { namespace: spec.namespace } : {}),
      ...(spec.serviceAccount ? { serviceAccount: spec.serviceAccount } : {}),
    });
    const sbx = await Sandbox.create({
      connectionConfig: this.connConfig(spec),
      image: spec.template ?? this.opts.defaultImage ?? DEFAULT_IMAGE,
      timeoutSeconds: spec.timeoutMs ? Math.ceil(spec.timeoutMs / 1000) : undefined,
      env: spec.envs,
      metadata: Object.keys(metadata).length ? metadata : undefined,
      volumes: spec.volumes?.length
        ? spec.volumes.map((v) => ({
            name: v.name,
            host: { path: v.hostPath },
            mountPath: v.mountPath,
            ...(v.readOnly ? { readOnly: true } : {}),
          }))
        : undefined,
    });
    return new OpenSandboxHandle(sbx);
  }

  async connect(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> {
    const sbx = await Sandbox.connect({ connectionConfig: this.connConfig(spec), sandboxId });
    if (spec.timeoutMs) await sbx.renew(Math.ceil(spec.timeoutMs / 1000));
    return new OpenSandboxHandle(sbx);
  }
}
