import { Sandbox } from '@e2b/code-interpreter';
import type { ExecResult, SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';

export interface E2bProviderOptions {
  /** E2B API key；缺省读 E2B_API_KEY 环境变量。 */
  apiKey?: string;
  /** 自定义 E2B API 域名（自托管 / 集群内网关）。 */
  domain?: string;
}

/** 把 E2B Sandbox 实例适配为统一的 SandboxHandle。 */
class E2bHandle implements SandboxHandle {
  constructor(private readonly sbx: Sandbox) {}

  get sandboxId(): string {
    return this.sbx.sandboxId;
  }

  async runCode(code: string, opts?: { language?: string }): Promise<ExecResult> {
    const exec = await this.sbx.runCode(code, {
      language: opts?.language as never,
    });
    return {
      stdout: exec.logs.stdout.join(''),
      stderr: exec.logs.stderr.join(''),
      error: exec.error ? `${exec.error.name}: ${exec.error.value}` : undefined,
    };
  }

  async runCommand(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const res = await this.sbx.commands.run(command, {
      timeoutMs: opts?.timeoutMs,
    });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      error: res.error,
    };
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
  constructor(private readonly opts: E2bProviderOptions = {}) {}

  private get connectOpts() {
    return {
      apiKey: this.opts.apiKey ?? process.env.E2B_API_KEY,
      domain: this.opts.domain,
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sbx = await Sandbox.create({
      ...this.connectOpts,
      template: spec.template,
      timeoutMs: spec.timeoutMs,
      envs: spec.envs,
    });
    return new E2bHandle(sbx);
  }

  async connect(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> {
    const sbx = await Sandbox.connect(sandboxId, this.connectOpts);
    if (spec.timeoutMs) await sbx.setTimeout(spec.timeoutMs); // 续命防回收
    return new E2bHandle(sbx);
  }
}
