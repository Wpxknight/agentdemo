import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AcquireSandboxInput,
  DownloadFile,
  SandboxCommand,
  SandboxHandle,
  SandboxOutput,
  SandboxProvider,
  UploadFile,
} from '@aiop/sandbox-core';

interface LocalHandle extends SandboxHandle { root: string }

export class LocalSandboxProvider implements SandboxProvider {
  private readonly handles = new Map<string, LocalHandle>();

  async acquire(input: AcquireSandboxInput): Promise<SandboxHandle> {
    const root = await mkdtemp(join(tmpdir(), 'aiop-sandbox-local-'));
    const handle: LocalHandle = { id: randomUUID(), provider: 'local', profile: input.profile, root };
    this.handles.set(handle.id, handle);
    return publicHandle(handle);
  }

  async *execute(handle: SandboxHandle, command: SandboxCommand): AsyncIterable<SandboxOutput> {
    const local = this.requireHandle(handle);
    const cwd = command.cwd ? safePath(local.root, command.cwd) : local.root;
    const child = spawn(command.program, [...(command.args ?? [])], {
      cwd,
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const queue: SandboxOutput[] = [];
    let done = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const push = (item: SandboxOutput) => { queue.push(item); wake?.(); wake = undefined; };
    child.stdout.on('data', (chunk: Buffer) => push({ stream: 'stdout', text: chunk.toString('utf8') }));
    child.stderr.on('data', (chunk: Buffer) => push({ stream: 'stderr', text: chunk.toString('utf8') }));
    child.on('error', (error) => { failure = error; done = true; wake?.(); });
    child.on('close', (code) => { push({ stream: code === 0 ? 'stdout' : 'stderr', text: '', exitCode: code ?? -1 }); done = true; wake?.(); });
    const timeout = command.timeoutMs && command.timeoutMs > 0
      ? setTimeout(() => child.kill('SIGKILL'), command.timeoutMs) : undefined;
    timeout?.unref?.();
    try {
      while (!done || queue.length) {
        if (!queue.length) await new Promise<void>((resolveWake) => { wake = resolveWake; });
        while (queue.length) yield queue.shift()!;
      }
      if (failure) throw failure;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (!done) child.kill('SIGKILL');
    }
  }

  async upload(handle: SandboxHandle, file: UploadFile): Promise<void> {
    const target = safePath(this.requireHandle(handle).root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }

  async download(handle: SandboxHandle, path: string): Promise<DownloadFile> {
    const target = safePath(this.requireHandle(handle).root, path);
    return { path, content: new Uint8Array(await readFile(target)) };
  }

  async release(handle: SandboxHandle): Promise<void> {
    const local = this.requireHandle(handle);
    this.handles.delete(handle.id);
    if (!local.root.startsWith(join(tmpdir(), 'aiop-sandbox-local-'))) throw new Error('Refusing unsafe sandbox cleanup');
    await rm(local.root, { recursive: true, force: true });
  }

  private requireHandle(handle: SandboxHandle): LocalHandle {
    const local = this.handles.get(handle.id);
    if (!local || handle.provider !== 'local') throw new Error(`Sandbox handle is unavailable: ${handle.id}`);
    return local;
  }
}

function safePath(root: string, requested: string): string {
  if (isAbsolute(requested)) throw new Error('Sandbox paths must be relative');
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    if (!rel) return target;
    throw new Error('Sandbox path escapes root');
  }
  return target;
}

function publicHandle(handle: LocalHandle): SandboxHandle {
  return { id: handle.id, provider: handle.provider, profile: handle.profile };
}
