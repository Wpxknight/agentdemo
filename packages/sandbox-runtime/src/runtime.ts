import { randomUUID } from 'node:crypto';
import type {
  DownloadFile,
  ExecResult,
  OutputSink,
  SandboxCommand,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
  UploadFile,
} from './types.js';
import type { IdentityContext } from '@aiop/control-contracts';
import type { SandboxAcquisition } from './acquisition.js';

export interface AcquireSandboxRuntimeInput {
  spec?: SandboxSpec;
  identity?: IdentityContext;
  profile?: string;
  cpu?: number;
  memoryMb?: number;
  network?: 'none' | 'restricted' | 'full';
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxLease {
  id: string;
  sandboxId: string;
  provider: string;
  profile?: string;
}

export interface ExecuteSandboxInput {
  lease: SandboxLease;
  command?: string | SandboxCommand;
  code?: string;
  language?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: OutputSink;
}

export interface SandboxExecutionResult extends ExecResult {
  timedOut?: boolean;
}

export interface ReleaseSandboxInput {
  lease: SandboxLease;
}

export interface UploadSandboxInput { lease: SandboxLease; file: UploadFile; signal?: AbortSignal }
export interface DownloadSandboxInput { lease: SandboxLease; path: string; signal?: AbortSignal }

export interface ReconcileSandboxInput {
  activeLeaseIds: readonly string[];
}

export interface ReconcileSandboxResult {
  activeLeaseIds: string[];
  releasedLeaseIds: string[];
}

export interface SandboxRuntimeOptions {
  provider: SandboxProvider;
  providerName: string;
}

interface LeaseEntry {
  lease: SandboxLease;
  handle: SandboxHandle;
  active: boolean;
  invalidate?: () => void;
  invalidated?: boolean;
}

export class SandboxRuntime {
  private readonly leases = new Map<string, LeaseEntry>();

  constructor(private readonly options: SandboxRuntimeOptions) {}

  async acquire(input: AcquireSandboxRuntimeInput): Promise<SandboxLease> {
    throwIfAborted(input.signal);
    const spec = acquireSpec(input);
    const task = spec.sandboxId
      ? input.signal
        ? this.options.provider.connect(spec.sandboxId, spec, { signal: input.signal })
        : this.options.provider.connect(spec.sandboxId, spec)
      : input.signal
        ? this.options.provider.create(spec, { signal: input.signal })
        : this.options.provider.create(spec);
    const handle = await acquireHandle(task, input.signal);
    return this.register(handle, spec);
  }

  async adopt(input: {
    handle: SandboxHandle;
    spec: SandboxSpec;
    signal?: AbortSignal;
    invalidate?: () => void;
  }): Promise<SandboxLease> {
    if (input.signal?.aborted) {
      input.invalidate?.();
      await input.handle.kill().catch(() => undefined);
      throw abortError();
    }
    return this.register(input.handle, input.spec, input.invalidate);
  }

  private register(handle: SandboxHandle, spec: SandboxSpec, invalidate?: () => void): SandboxLease {
    const lease: SandboxLease = {
      id: randomUUID(),
      sandboxId: handle.sandboxId,
      provider: this.options.providerName,
      ...(spec.profile ? { profile: spec.profile } : {}),
    };
    this.leases.set(lease.id, { lease, handle, active: true, invalidate });
    return { ...lease };
  }

  async execute(input: ExecuteSandboxInput): Promise<SandboxExecutionResult> {
    const entry = this.requireActive(input.lease);
    if (input.signal?.aborted) await this.abortEntry(entry);
    if ((input.command === undefined) === (input.code === undefined)) {
      throw new Error('exactly one of command or code is required');
    }
    const task = input.code !== undefined
      ? entry.handle.runCode(input.code, { language: input.language, onOutput: input.onOutput })
      : typeof input.command === 'string'
        ? entry.handle.runCommand(input.command, { timeoutMs: input.timeoutMs, onOutput: input.onOutput })
        : entry.handle.executeCommand
          ? entry.handle.executeCommand(input.command!, {
              timeoutMs: input.command!.timeoutMs ?? input.timeoutMs, onOutput: input.onOutput,
            })
          : entry.handle.runCommand(shellCommand(input.command!), {
              timeoutMs: input.command!.timeoutMs ?? input.timeoutMs, onOutput: input.onOutput,
            });
    const result = await this.raceControls(task, input.signal, input.timeoutMs, entry);
    return normalizeExecutionResult(result);
  }

  async upload(input: UploadSandboxInput): Promise<void> {
    const entry = this.requireActive(input.lease);
    if (input.signal?.aborted) await this.abortEntry(entry);
    if (!entry.handle.writeFile) throw new Error('sandbox does not support file uploads');
    await this.raceVoid(entry.handle.writeFile(input.file.path, input.file.content), input.signal, entry);
  }

  async download(input: DownloadSandboxInput): Promise<DownloadFile> {
    const entry = this.requireActive(input.lease);
    if (input.signal?.aborted) await this.abortEntry(entry);
    const content = await this.raceControls(entry.handle.readFile(input.path).then((bytes) => ({
      stdout: '', stderr: '', bytes,
    }) as ExecResult & { bytes: Uint8Array }), input.signal, undefined, entry) as ExecResult & { bytes: Uint8Array };
    return { path: input.path, content: content.bytes };
  }

  async stop(input: ReleaseSandboxInput): Promise<void> {
    const entry = this.leases.get(input.lease.id);
    if (!entry || !entry.active) return;
    entry.active = false;
    this.invalidate(entry);
    await entry.handle.kill();
  }

  async release(input: ReleaseSandboxInput): Promise<void> {
    const entry = this.leases.get(input.lease.id);
    if (!entry) return;
    try {
      await this.stop(input);
    } finally {
      this.leases.delete(input.lease.id);
    }
  }

  async reconcile(input: ReconcileSandboxInput): Promise<ReconcileSandboxResult> {
    const desired = new Set(input.activeLeaseIds);
    const releasedLeaseIds: string[] = [];
    for (const [leaseId, entry] of this.leases) {
      if (desired.has(leaseId) && entry.active) continue;
      await this.release({ lease: entry.lease });
      releasedLeaseIds.push(leaseId);
    }
    return {
      activeLeaseIds: [...this.leases.values()].filter((entry) => entry.active).map((entry) => entry.lease.id),
      releasedLeaseIds,
    };
  }

  private requireActive(lease: SandboxLease): LeaseEntry {
    const entry = this.leases.get(lease.id);
    if (!entry || !entry.active || entry.lease.sandboxId !== lease.sandboxId) {
      throw new Error(`sandbox lease is not active: ${lease.id}`);
    }
    return entry;
  }

  private async raceControls(
    task: Promise<ExecResult>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    entry: LeaseEntry,
  ): Promise<ExecResult> {
    if (signal?.aborted) await this.abortEntry(entry);
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controls: Array<Promise<ExecResult>> = [task];
    if (signal) {
      controls.push(new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          entry.active = false;
          this.invalidate(entry);
          void entry.handle.kill().catch(() => undefined);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }));
    }
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      controls.push(new Promise<ExecResult>((resolve) => {
        timer = setTimeout(() => {
          entry.active = false;
          this.invalidate(entry);
          void entry.handle.kill().catch(() => undefined).finally(() => resolve({
            stdout: '',
            stderr: '',
            exitCode: 124,
            error: 'command timed out',
          }));
        }, timeoutMs);
        timer.unref?.();
      }));
    }
    try {
      return await Promise.race(controls);
    } finally {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    }
  }

  private async raceVoid(task: Promise<void>, signal: AbortSignal | undefined, entry: LeaseEntry): Promise<void> {
    await this.raceControls(task.then(() => ({ stdout: '', stderr: '' })), signal, undefined, entry);
  }

  private invalidate(entry: LeaseEntry): void {
    if (entry.invalidated) return;
    entry.invalidated = true;
    entry.invalidate?.();
  }

  private async abortEntry(entry: LeaseEntry): Promise<never> {
    entry.active = false;
    this.invalidate(entry);
    await entry.handle.kill().catch(() => undefined);
    throw abortError();
  }
}

export async function executeAcquiredSandbox(
  acquired: Pick<SandboxAcquisition, 'handle' | 'spec' | 'invalidate'>,
  input: Omit<ExecuteSandboxInput, 'lease'>,
): Promise<SandboxExecutionResult> {
  return withAcquiredRuntime(acquired, input.signal, (runtime, lease) => runtime.execute({ ...input, lease }));
}

export async function downloadAcquiredSandbox(
  acquired: Pick<SandboxAcquisition, 'handle' | 'spec' | 'invalidate'>,
  input: Omit<DownloadSandboxInput, 'lease'>,
): Promise<DownloadFile> {
  return withAcquiredRuntime(acquired, input.signal, (runtime, lease) => runtime.download({ ...input, lease }));
}

export async function uploadAcquiredSandbox(
  acquired: Pick<SandboxAcquisition, 'handle' | 'spec' | 'invalidate'>,
  input: Omit<UploadSandboxInput, 'lease'>,
): Promise<void> {
  return withAcquiredRuntime(acquired, input.signal, (runtime, lease) => runtime.upload({ ...input, lease }));
}

async function withAcquiredRuntime<T>(
  acquired: Pick<SandboxAcquisition, 'handle' | 'spec' | 'invalidate'>,
  signal: AbortSignal | undefined,
  operation: (runtime: SandboxRuntime, lease: SandboxLease) => Promise<T>,
): Promise<T> {
  const runtime = new SandboxRuntime({
    providerName: 'managed',
    provider: { create: async () => acquired.handle, connect: async () => acquired.handle },
  });
  const lease = await runtime.adopt({ ...acquired, signal });
  return operation(runtime, lease);
}

function acquireSpec(input: AcquireSandboxRuntimeInput): SandboxSpec {
  if (input.spec) return { ...input.spec };
  if (!input.identity || !input.profile) throw new Error('identity and profile are required');
  return {
    key: `${input.identity.tenantId}:${input.identity.actorId}:${input.profile}:${randomUUID()}`,
    profile: input.profile,
    metadata: { tenantId: input.identity.tenantId, actorId: input.identity.actorId },
    ...(input.cpu === undefined ? {} : { cpu: input.cpu }),
    ...(input.memoryMb === undefined ? {} : { memoryMb: input.memoryMb }),
    ...(input.network === undefined ? {} : { network: input.network }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellCommand(command: SandboxCommand): string {
  const invocation = [command.program, ...(command.args ?? [])].map(shellQuote).join(' ');
  const environment = Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  const prefixed = environment ? `env ${environment} ${invocation}` : invocation;
  return command.cwd ? `cd ${shellQuote(command.cwd)} && ${prefixed}` : prefixed;
}

function normalizeExecutionResult(result: ExecResult): SandboxExecutionResult {
  const timedOut = Boolean(result.error && /timed out|timeout/i.test(result.error));
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.error ? { error: timedOut ? 'command timed out' : result.error } : {}),
    ...(timedOut ? { timedOut: true } : {}),
  };
}

function abortError(): DOMException {
  return new DOMException('The sandbox operation was aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function acquireHandle(task: Promise<SandboxHandle>, signal?: AbortSignal): Promise<SandboxHandle> {
  if (!signal) return task;
  if (signal.aborted) {
    void task.then((handle) => handle.kill().catch(() => undefined), () => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<SandboxHandle>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(async (handle) => {
      signal.removeEventListener('abort', onAbort);
      if (aborted || signal.aborted) {
        await handle.kill().catch(() => undefined);
        if (!aborted) reject(abortError());
        return;
      }
      resolve(handle);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      if (!aborted) reject(error);
    });
  });
}
