import { posix } from 'node:path';
import { Sandbox } from '@e2b/code-interpreter';
import type {
  AcquireSandboxInput,
  DownloadFile,
  SandboxCommand,
  SandboxHandle,
  SandboxOutput,
  SandboxProvider,
  UploadFile,
} from '@aiop/agent-contracts';

interface E2BSandboxClient {
  sandboxId: string;
  commands: {
    run(command: string, options?: {
      cwd?: string;
      envs?: Record<string, string>;
      timeoutMs?: number;
      onStdout?: (text: string) => void | Promise<void>;
      onStderr?: (text: string) => void | Promise<void>;
    }): Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }>;
  };
  files: {
    write(path: string, content: ArrayBuffer): Promise<unknown>;
    read(path: string, options: { format: 'bytes' }): Promise<Uint8Array>;
  };
  kill(): Promise<unknown>;
}

export interface E2BSandboxSdkFactory {
  create(options: {
    apiKey?: string;
    domain?: string;
    template?: string;
    timeoutMs?: number;
    metadata: Record<string, string>;
    allowInternetAccess?: boolean;
  }): Promise<E2BSandboxClient>;
}

export interface E2BSandboxProviderOptions {
  apiKey?: string;
  domain?: string;
  template?: string;
  sdkFactory?: E2BSandboxSdkFactory;
}

interface ManagedE2BSandbox {
  client: E2BSandboxClient;
  handle: SandboxHandle;
}

export class E2BSandboxProvider implements SandboxProvider {
  private readonly handles = new Map<string, ManagedE2BSandbox>();
  private readonly factory: E2BSandboxSdkFactory;

  constructor(private readonly options: E2BSandboxProviderOptions = {}) {
    this.factory = options.sdkFactory ?? {
      create: async (input) => Sandbox.create(input),
    };
  }

  async acquire(input: AcquireSandboxInput): Promise<SandboxHandle> {
    const client = await this.factory.create({
      apiKey: this.options.apiKey,
      domain: this.options.domain,
      template: this.options.template,
      timeoutMs: input.timeoutMs,
      metadata: {
        tenantId: input.identity.tenantId,
        actorId: input.identity.actorId,
        profile: input.profile,
      },
      allowInternetAccess: input.network === undefined ? undefined : input.network === 'full',
    });
    const handle = { id: client.sandboxId, provider: 'e2b', profile: input.profile };
    this.handles.set(handle.id, { client, handle });
    return { ...handle };
  }

  async *execute(handle: SandboxHandle, command: SandboxCommand): AsyncIterable<SandboxOutput> {
    const client = this.requireHandle(handle).client;
    const queue = new OutputQueue();
    const execution = client.commands.run(shellCommand(command.program, command.args), {
      cwd: command.cwd ? safeSandboxPath(command.cwd) : undefined,
      envs: command.env ? { ...command.env } : undefined,
      timeoutMs: command.timeoutMs,
      onStdout: (text) => queue.push({ stream: 'stdout', text }),
      onStderr: (text) => queue.push({ stream: 'stderr', text }),
    });
    void execution.then(
      (result) => queue.end({ stream: result.exitCode === 0 ? 'stdout' : 'stderr', text: '', exitCode: result.exitCode }),
      (error) => queue.fail(error),
    );
    yield* queue;
  }

  async upload(handle: SandboxHandle, file: UploadFile): Promise<void> {
    const content = new Uint8Array(file.content);
    await this.requireHandle(handle).client.files.write(safeSandboxPath(file.path), content.slice().buffer);
  }

  async download(handle: SandboxHandle, path: string): Promise<DownloadFile> {
    const safe = safeSandboxPath(path);
    const content = await this.requireHandle(handle).client.files.read(safe, { format: 'bytes' });
    return { path, content: new Uint8Array(content) };
  }

  async release(handle: SandboxHandle): Promise<void> {
    const managed = this.requireHandle(handle);
    this.handles.delete(handle.id);
    await managed.client.kill();
  }

  private requireHandle(handle: SandboxHandle): ManagedE2BSandbox {
    const managed = this.handles.get(handle.id);
    if (!managed || handle.provider !== 'e2b') throw new Error(`Sandbox handle is unavailable: ${handle.id}`);
    return managed;
  }
}

class OutputQueue implements AsyncIterable<SandboxOutput> {
  private readonly items: SandboxOutput[] = [];
  private done = false;
  private error?: unknown;
  private wake?: () => void;

  push(item: SandboxOutput): void { this.items.push(item); this.wake?.(); this.wake = undefined; }
  end(item: SandboxOutput): void { this.push(item); this.done = true; this.wake?.(); }
  fail(error: unknown): void { this.error = error; this.done = true; this.wake?.(); }

  async *[Symbol.asyncIterator](): AsyncIterator<SandboxOutput> {
    while (!this.done || this.items.length) {
      if (!this.items.length) await new Promise<void>((resolve) => { this.wake = resolve; });
      while (this.items.length) yield this.items.shift()!;
    }
    if (this.error) throw this.error;
  }
}

function safeSandboxPath(path: string): string {
  if (!path || posix.isAbsolute(path)) throw new Error('Sandbox paths must be relative');
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('Sandbox path escapes root');
  return normalized;
}

function shellCommand(program: string, args: readonly string[] = []): string {
  return [program, ...args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' ');
}
