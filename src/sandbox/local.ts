import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ExecResult,
  OutputSink,
  RunCodeOpts,
  RunCommandOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.js';

function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; onOutput?: OutputSink },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; opts.onOutput?.({ stream: 'stdout', text: String(chunk) }); });
    child.stderr.on('data', (chunk) => { stderr += chunk; opts.onOutput?.({ stream: 'stderr', text: String(chunk) }); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 127, error: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 124 : 1),
        error: timedOut ? 'process timed out' : undefined,
      });
    });
  });
}

function codeCommand(language: string | undefined, file: string): { command: string; args: string[] } {
  const lang = (language || 'python').toLowerCase();
  if (['javascript', 'js', 'node'].includes(lang)) return { command: 'node', args: [file] };
  if (['bash', 'sh', 'shell'].includes(lang)) return { command: 'bash', args: [file] };
  return { command: 'python3', args: [file] };
}

function codeFile(language: string | undefined): string {
  const lang = (language || 'python').toLowerCase();
  if (['javascript', 'js', 'node'].includes(lang)) return 'main.js';
  if (['bash', 'sh', 'shell'].includes(lang)) return 'main.sh';
  return 'main.py';
}

class LocalSandboxHandle implements SandboxHandle {
  readonly sandboxId: string;
  private killed = false;

  constructor(private readonly dir: string, key: string) {
    this.sandboxId = `local-${key.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${Date.now().toString(36)}`;
  }

  async runCode(code: string, opts?: RunCodeOpts): Promise<ExecResult> {
    if (this.killed) return { stdout: '', stderr: '', exitCode: 1, error: 'sandbox already killed' };
    const fileName = codeFile(opts?.language);
    const file = path.join(this.dir, fileName);
    await writeFile(file, code);
    const cmd = codeCommand(opts?.language, file);
    return runProcess(cmd.command, cmd.args, { cwd: this.dir, onOutput: opts?.onOutput });
  }

  async runCommand(command: string, opts?: RunCommandOpts): Promise<ExecResult> {
    if (this.killed) return { stdout: '', stderr: '', exitCode: 1, error: 'sandbox already killed' };
    return runProcess('bash', ['-lc', command], { cwd: this.dir, timeoutMs: opts?.timeoutMs, onOutput: opts?.onOutput });
  }

  async readFile(p: string): Promise<Uint8Array> {
    if (this.killed) throw new Error('sandbox already killed');
    // 相对路径按沙箱工作目录解析（命令默认 cwd 即此目录）；绝对路径原样读取。
    const target = path.isAbsolute(p) ? p : path.resolve(this.dir, p);
    return readFile(target);
  }

  async setTimeout(_ms: number): Promise<void> {
    return;
  }

  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** 本地开发用沙箱：在临时目录中执行命令/代码，不提供强隔离。 */
export class LocalSandboxProvider implements SandboxProvider {
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const dir = await mkdtemp(path.join(tmpdir(), 'aiop-local-sandbox-'));
    return new LocalSandboxHandle(dir, spec.key);
  }

  async connect(_sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> {
    return this.create(spec);
  }
}
