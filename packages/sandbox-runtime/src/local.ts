import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localWorkspacePath } from './workspace-path.js';
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

export const LOCAL_SYNC_MAX_GENERATIONS = 16;
export const LOCAL_SYNC_MAX_BYTES = 256 * 1024 * 1024;

export interface LocalSandboxProviderOptions {
  platform?: NodeJS.Platform;
  procFdAvailable?: () => Promise<boolean>;
  maxSyncGenerations?: number;
  maxSyncBytes?: number;
}

interface LocalSandboxLimits {
  maxSyncGenerations: number;
  maxSyncBytes: number;
}

function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; onOutput?: OutputSink; env?: Readonly<Record<string, string>> },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
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
  readonly supportsSecretFiles = false;
  private killed = false;
  private syncGenerations = 0;
  private syncBytes = 0;

  constructor(private readonly dir: string, key: string, private readonly limits: LocalSandboxLimits) {
    this.sandboxId = `local-${key.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${Date.now().toString(36)}`;
  }

  workspacePath(relativePath = ''): string {
    return localWorkspacePath(relativePath);
  }

  async runCode(code: string, opts?: RunCodeOpts): Promise<ExecResult> {
    if (this.killed) return { stdout: '', stderr: '', exitCode: 1, error: 'sandbox already killed' };
    const fileName = codeFile(opts?.language);
    await this.writeFile(fileName, Buffer.from(code, 'utf8'));
    const cmd = codeCommand(opts?.language, fileName);
    return runProcess(cmd.command, cmd.args, { cwd: this.dir, onOutput: opts?.onOutput });
  }

  async runCommand(command: string, opts?: RunCommandOpts): Promise<ExecResult> {
    if (this.killed) return { stdout: '', stderr: '', exitCode: 1, error: 'sandbox already killed' };
    return runProcess('bash', ['-lc', command], { cwd: this.dir, timeoutMs: opts?.timeoutMs, onOutput: opts?.onOutput });
  }

  async executeCommand(command: SandboxCommand, opts?: RunCommandOpts): Promise<ExecResult> {
    if (this.killed) return { stdout: '', stderr: '', exitCode: 1, error: 'sandbox already killed' };
    const cwd = command.cwd ? path.resolve(this.dir, command.cwd) : this.dir;
    const relative = path.relative(this.dir, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('sandbox cwd escapes sandbox root');
    }
    return runProcess(command.program, [...(command.args ?? [])], {
      cwd, env: command.env, timeoutMs: command.timeoutMs ?? opts?.timeoutMs, onOutput: opts?.onOutput,
    });
  }

  async readFile(p: string): Promise<Uint8Array> {
    if (this.killed) throw new Error('sandbox already killed');
    return this.withSandboxParent(p, false, async (parent, name) => {
      const file = await this.openFileAt(parent, name, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        return await file.readFile();
      } finally {
        await file.close();
      }
    });
  }

  async writeFile(p: string, content: Uint8Array, options?: { mode?: number }): Promise<void> {
    if (this.killed) throw new Error('sandbox already killed');
    await this.withSandboxParent(p, true, async (parent, name) => {
      const mode = options?.mode ?? 0o666;
      const tempName = `.aiop-write-${randomUUID()}.tmp`;
      const tempPath = this.pathAt(parent, tempName);
      try {
        const file = await open(
          tempPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode,
        );
        try {
          await file.writeFile(content);
          if (options?.mode !== undefined) await file.chmod(options.mode);
          await file.sync();
        } finally {
          await file.close();
        }
        await this.throwIfSymlink(this.pathAt(parent, name));
        await rename(tempPath, this.pathAt(parent, name));
        await parent.sync();
      } finally {
        await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    });
  }

  async reserveSyncGeneration(bytes: number): Promise<void> {
    if (this.killed) throw new Error('sandbox already killed');
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('local sandbox sync bytes must be non-negative');
    if (this.syncGenerations >= this.limits.maxSyncGenerations) {
      throw new Error(`local sandbox sync generation quota exceeded (${this.limits.maxSyncGenerations})`);
    }
    if (bytes > this.limits.maxSyncBytes - this.syncBytes) {
      throw new Error(`local sandbox sync byte quota exceeded (${this.limits.maxSyncBytes} bytes)`);
    }
    this.syncGenerations += 1;
    this.syncBytes += bytes;
  }

  async setTimeout(_ms: number): Promise<void> {
    return;
  }

  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    await rm(this.dir, { recursive: true, force: true });
  }

  private sandboxPathParts(requested: string): string[] {
    const normalized = requested.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.includes('..')) throw new Error('sandbox path escapes sandbox root');
    let relativePath = normalized;
    if (path.posix.isAbsolute(normalized)) {
      if (normalized === '/workspace') relativePath = 'workspace';
      else if (normalized.startsWith('/workspace/')) relativePath = `workspace/${normalized.slice('/workspace/'.length)}`;
      else throw new Error('unsupported sandbox absolute path');
    }
    const target = path.resolve(this.dir, relativePath);
    const relativeTarget = path.relative(this.dir, target);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
      throw new Error('sandbox path escapes sandbox root');
    }
    const parts = relativeTarget.split(path.sep).filter(Boolean);
    if (!parts.length) throw new Error('sandbox file path is required');
    return parts;
  }

  private async withSandboxParent<T>(
    requested: string,
    createParents: boolean,
    operation: (parent: FileHandle, name: string) => Promise<T>,
  ): Promise<T> {
    const parts = this.sandboxPathParts(requested);
    const name = parts.pop()!;
    let current = await open(
      this.dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      for (const segment of parts) {
        const next = await this.openDirectoryAt(current, segment, createParents);
        const previous = current;
        current = next;
        await previous.close();
      }
      return await operation(current, name);
    } finally {
      await current.close().catch(() => undefined);
    }
  }

  private async openDirectoryAt(parent: FileHandle, name: string, create: boolean): Promise<FileHandle> {
    const target = this.pathAt(parent, name);
    for (;;) {
      try {
        return await open(
          target,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && create) {
          try {
            await mkdir(target, { mode: 0o700 });
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
          }
          continue;
        }
        await this.throwIfSymlink(target);
        throw error;
      }
    }
  }

  private async openFileAt(parent: FileHandle, name: string, flags: number, mode?: number): Promise<FileHandle> {
    const target = this.pathAt(parent, name);
    try {
      return await open(target, flags, mode);
    } catch (error) {
      await this.throwIfSymlink(target);
      throw error;
    }
  }

  private pathAt(parent: FileHandle, name: string): string {
    return `/proc/self/fd/${parent.fd}/${name}`;
  }

  private async throwIfSymlink(target: string): Promise<void> {
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new Error('sandbox path contains symbolic link');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** 本地开发用沙箱：在临时目录中执行命令/代码，不提供强隔离。 */
export class LocalSandboxProvider implements SandboxProvider {
  private readonly platform: NodeJS.Platform;
  private readonly procFdAvailable: () => Promise<boolean>;
  private readonly limits: LocalSandboxLimits;

  constructor(options: LocalSandboxProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.procFdAvailable = options.procFdAvailable ?? (async () => {
      try {
        await access('/proc/self/fd');
        return true;
      } catch {
        return false;
      }
    });
    this.limits = {
      maxSyncGenerations: options.maxSyncGenerations ?? LOCAL_SYNC_MAX_GENERATIONS,
      maxSyncBytes: options.maxSyncBytes ?? LOCAL_SYNC_MAX_BYTES,
    };
    if (!Number.isSafeInteger(this.limits.maxSyncGenerations) || this.limits.maxSyncGenerations < 1) {
      throw new Error('local sandbox maxSyncGenerations must be a positive integer');
    }
    if (!Number.isSafeInteger(this.limits.maxSyncBytes) || this.limits.maxSyncBytes < 1) {
      throw new Error('local sandbox maxSyncBytes must be a positive integer');
    }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.rejectUnsupportedResources(spec);
    await this.requireSupportedPlatform();
    const dir = await mkdtemp(path.join(tmpdir(), 'aiop-local-sandbox-'));
    return new LocalSandboxHandle(dir, spec.key, this.limits);
  }

  async connect(_sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle> {
    return this.create(spec);
  }

  private rejectUnsupportedResources(spec: SandboxSpec): void {
    for (const field of ['cpu', 'memoryMb', 'network'] as const) {
      if (spec[field] !== undefined) {
        throw new Error(`LocalSandboxProvider ${field} isolation is not supported`);
      }
    }
  }

  private async requireSupportedPlatform(): Promise<void> {
    if (this.platform !== 'linux') {
      throw new Error('LocalSandboxProvider 仅支持启用 procfs 的 Linux 平台');
    }
    if (!await this.procFdAvailable()) {
      throw new Error('LocalSandboxProvider 需要可用的 procfs 路径 /proc/self/fd');
    }
  }
}
