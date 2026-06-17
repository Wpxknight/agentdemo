/**
 * 沙箱抽象层：SandboxManager / 工具只依赖这些接口，
 * 具体由 E2bProvider（@e2b/code-interpreter）或测试 mock 实现，
 * 从而 agent / 工具与 E2B SDK 解耦、可在无 API key 时单测。
 */

/** 代码 / 命令执行结果。 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  /** 命令退出码；run_code 一般无退出码。 */
  exitCode?: number;
  /** 执行期错误（异常 / 非零退出）的可读信息。 */
  error?: string;
}

/** 一个沙箱的创建 / 连接规格。 */
export interface SandboxSpec {
  /** 逻辑缓存键：同一 (session × cluster) 复用同一个沙箱。 */
  key: string;
  /** 连接远端既有沙箱时提供其 id；不提供则新建。 */
  sandboxId?: string;
  /** 模板 / 镜像（动态拉起到集群内部时使用）。 */
  template?: string;
  /** 沙箱存活超时(ms)，到期被 E2B 回收。 */
  timeoutMs?: number;
  /** 覆盖 E2B 控制面域名（多集群：每集群一个控制面）。 */
  domain?: string;
  /** 注入沙箱的环境变量（如 in-cluster 标记）。 */
  envs?: Record<string, string>;
}

/** 一个已就绪沙箱的统一句柄。 */
export interface SandboxHandle {
  readonly sandboxId: string;
  /** 在沙箱里执行代码（默认 python）。 */
  runCode(code: string, opts?: { language?: string }): Promise<ExecResult>;
  /** 在沙箱里执行 shell 命令。 */
  runCommand(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** 续命，防止被回收。 */
  setTimeout(ms: number): Promise<void>;
  /** 销毁沙箱。 */
  kill(): Promise<void>;
}

/** 沙箱后端：负责新建 / 连接。 */
export interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  connect(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle>;
}
