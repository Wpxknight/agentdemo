import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Sandbox } from '@alibaba-group/opensandbox';
import type {
  AcquireSandboxInput,
  DownloadFile,
  SandboxCommand,
  SandboxHandle,
  SandboxOutput,
  SandboxProvider,
  UploadFile,
} from '@aiop/sandbox-core';

interface OpenSandboxClient {
  id: string;
  commands: {
    run(
      command: string,
      options?: { workingDirectory?: string; timeoutSeconds?: number; envs?: Record<string, string> },
      handlers?: { onStdout?: (message: { text: string }) => void; onStderr?: (message: { text: string }) => void },
      signal?: AbortSignal,
    ): Promise<{ exitCode?: number | null; error?: unknown }>;
  };
  files: {
    writeFiles(files: Array<{ path: string; data: Uint8Array }>): Promise<unknown>;
    readBytes(path: string): Promise<Uint8Array>;
  };
  kill(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenSandboxSdkFactory {
  create(options: {
    connectionConfig?: { domain?: string; protocol?: 'http' | 'https'; apiKey?: string; requestTimeoutSeconds?: number };
    image: string;
    timeoutSeconds?: number;
    metadata: Record<string, string>;
    resource?: Record<string, string>;
    networkPolicy?: { defaultAction: 'allow' | 'deny' };
  }): Promise<OpenSandboxClient>;
}

export interface OpenSandboxProviderOptions {
  domain?: string;
  protocol?: 'http' | 'https';
  apiKey?: string;
  defaultImage?: string;
  requestTimeoutSeconds?: number;
  sdkFactory?: OpenSandboxSdkFactory;
}

interface ManagedOpenSandbox {
  client: OpenSandboxClient;
  handle: SandboxHandle;
}

const DEFAULT_IMAGE = 'opensandbox/code-interpreter:latest';

export class OpenSandboxProvider implements SandboxProvider {
  private readonly handles = new Map<string, ManagedOpenSandbox>();
  private readonly factory: OpenSandboxSdkFactory;

  constructor(private readonly options: OpenSandboxProviderOptions = {}) {
    this.factory = options.sdkFactory ?? {
      create: async (input) => Sandbox.create(input),
    };
  }

  async acquire(input: AcquireSandboxInput): Promise<SandboxHandle> {
    const client = await this.factory.create({
      connectionConfig: {
        domain: this.options.domain,
        protocol: this.options.protocol,
        apiKey: this.options.apiKey,
        requestTimeoutSeconds: this.options.requestTimeoutSeconds,
      },
      image: this.options.defaultImage ?? DEFAULT_IMAGE,
      timeoutSeconds: positiveSeconds(input.timeoutMs),
      metadata: safeMetadata({
        tenantId: input.identity.tenantId,
        actorId: input.identity.actorId,
        profile: input.profile,
      }),
      resource: input.cpu === undefined && input.memoryMb === undefined ? undefined : {
        ...(input.cpu === undefined ? {} : { cpu: String(input.cpu) }),
        ...(input.memoryMb === undefined ? {} : { memory: `${input.memoryMb}Mi` }),
      },
      networkPolicy: input.network === undefined ? undefined : {
        defaultAction: input.network === 'full' ? 'allow' : 'deny',
      },
    });
    const handle = { id: client.id, provider: 'opensandbox', profile: input.profile };
    this.handles.set(handle.id, { client, handle });
    return { ...handle };
  }

  async *execute(handle: SandboxHandle, command: SandboxCommand): AsyncIterable<SandboxOutput> {
    const managed = this.requireHandle(handle);
    const queue = new OutputQueue();
    const execution = managed.client.commands.run(
      shellCommand(command.program, command.args),
      {
        workingDirectory: command.cwd ? safeSandboxPath(command.cwd) : undefined,
        timeoutSeconds: positiveSeconds(command.timeoutMs),
        envs: command.env ? { ...command.env } : undefined,
      },
      {
        onStdout: (message) => queue.push({ stream: 'stdout', text: message.text }),
        onStderr: (message) => queue.push({ stream: 'stderr', text: message.text }),
      },
    );
    void execution.then(
      (result) => queue.end({ stream: result.exitCode === 0 ? 'stdout' : 'stderr', text: '', exitCode: result.exitCode ?? -1 }),
      (error) => queue.fail(error),
    );
    yield* queue;
  }

  async upload(handle: SandboxHandle, file: UploadFile): Promise<void> {
    await this.requireHandle(handle).client.files.writeFiles([{
      path: safeSandboxPath(file.path),
      data: new Uint8Array(file.content),
    }]);
  }

  async download(handle: SandboxHandle, path: string): Promise<DownloadFile> {
    const safe = safeSandboxPath(path);
    return { path, content: new Uint8Array(await this.requireHandle(handle).client.files.readBytes(safe)) };
  }

  async release(handle: SandboxHandle): Promise<void> {
    const managed = this.requireHandle(handle);
    this.handles.delete(handle.id);
    try {
      await managed.client.kill();
    } finally {
      await managed.client.close();
    }
  }

  private requireHandle(handle: SandboxHandle): ManagedOpenSandbox {
    const managed = this.handles.get(handle.id);
    if (!managed || handle.provider !== 'opensandbox') throw new Error(`Sandbox handle is unavailable: ${handle.id}`);
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

function positiveSeconds(milliseconds?: number): number | undefined {
  return milliseconds && milliseconds > 0 ? Math.ceil(milliseconds / 1_000) : undefined;
}

function safeMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, safeLabel(value)]));
}

function safeLabel(value: string): string {
  if (/^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(value)) return value;
  const suffix = `-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
  const normalized = value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') || 'value';
  return `${normalized.slice(0, 63 - suffix.length)}${suffix}`;
}
