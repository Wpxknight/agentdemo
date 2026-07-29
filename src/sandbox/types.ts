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

/** 挂载进沙箱的卷（宿主机 hostPath 绑定）。仅 opensandbox 后端支持；local/e2b 忽略。 */
export interface SandboxVolume {
  /** 卷名（沙箱内唯一）。 */
  name: string;
  /** 宿主机绝对路径。 */
  hostPath: string;
  /** 沙箱容器内挂载点（绝对路径）。 */
  mountPath: string;
  readOnly?: boolean;
}

/** 一个沙箱的创建 / 连接规格。 */
export interface SandboxSpec {
  /** 逻辑缓存键：同一 (session × cluster) 复用同一个沙箱。 */
  key: string;
  /** 沙箱模板/profile 名称，用于 UI 展示和会话内多沙箱隔离。 */
  profile?: string;
  /** 连接远端既有沙箱时提供其 id；不提供则新建。 */
  sandboxId?: string;
  /** 模板 / 镜像（动态拉起到集群内部时使用）。 */
  template?: string;
  /** 动态拉起到目标集群时使用的命名空间。 */
  namespace?: string;
  /** 动态拉起到目标集群时绑定的 ServiceAccount。 */
  serviceAccount?: string;
  /** 透传给沙箱控制面的元数据，用于审计 / 调度 / 自托管控制面扩展。 */
  metadata?: Record<string, string>;
  /** 沙箱存活超时(ms)，到期被 E2B 回收。 */
  timeoutMs?: number;
  /** 覆盖 E2B 控制面域名（多集群：每集群一个控制面）。 */
  domain?: string;
  /** 注入沙箱的环境变量（如 in-cluster 标记）。 */
  envs?: Record<string, string>;
  /** 创建时挂载的卷（如用户绑定的主机主目录）。带卷的沙箱不走预热池（卷必须创建时生效）。 */
  volumes?: SandboxVolume[];
}

/** 沙箱执行过程中的实时输出分片（用于前端终端预览）。 */
export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

/** 实时输出回调：执行期逐段回传 stdout/stderr。 */
export type OutputSink = (chunk: OutputChunk) => void;

export interface RunCodeOpts {
  language?: string;
  /** 提供时逐段回传 stdout/stderr（流式预览）；不影响最终 ExecResult。 */
  onOutput?: OutputSink;
}

export interface RunCommandOpts {
  timeoutMs?: number;
  /** 提供时逐段回传 stdout/stderr（流式预览）；不影响最终 ExecResult。 */
  onOutput?: OutputSink;
}

/** 一个已就绪沙箱的统一句柄。 */
export interface SandboxHandle {
  readonly sandboxId: string;
  /** Returns a command-visible path beneath this sandbox's workspace root. */
  workspacePath?(relativePath?: string): string;
  /** 在沙箱里执行代码（默认 python）。 */
  runCode(code: string, opts?: RunCodeOpts): Promise<ExecResult>;
  /** 在沙箱里执行 shell 命令。 */
  runCommand(command: string, opts?: RunCommandOpts): Promise<ExecResult>;
  /** 读取沙箱内文件的原始字节（用于导出 / 下载）。文件不存在或不可读时抛错。 */
  readFile(path: string): Promise<Uint8Array>;
  /** Writes bytes without placing file contents in a shell command or command log. */
  writeFile?(path: string, content: Uint8Array, options?: { mode?: number }): Promise<void>;
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
