import { randomUUID } from 'node:crypto';
import type {
  ExecResult,
  OutputSink,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from './types.js';

export interface AcquireSandboxRuntimeInput {
  spec: SandboxSpec;
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
  command?: string;
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
}

export class SandboxRuntime {
  private readonly leases = new Map<string, LeaseEntry>();

  constructor(private readonly options: SandboxRuntimeOptions) {}

  async acquire(input: AcquireSandboxRuntimeInput): Promise<SandboxLease> {
    throwIfAborted(input.signal);
    const handle = input.spec.sandboxId
      ? await this.options.provider.connect(input.spec.sandboxId, input.spec)
      : await this.options.provider.create(input.spec);
    if (input.signal?.aborted) {
      await handle.kill().catch(() => undefined);
      throw abortError();
    }
    const lease: SandboxLease = {
      id: randomUUID(),
      sandboxId: handle.sandboxId,
      provider: this.options.providerName,
      ...(input.spec.profile ? { profile: input.spec.profile } : {}),
    };
    this.leases.set(lease.id, { lease, handle, active: true });
    return { ...lease };
  }

  async execute(input: ExecuteSandboxInput): Promise<SandboxExecutionResult> {
    const entry = this.requireActive(input.lease);
    throwIfAborted(input.signal);
    if ((input.command === undefined) === (input.code === undefined)) {
      throw new Error('exactly one of command or code is required');
    }
    const task = input.code !== undefined
      ? entry.handle.runCode(input.code, { language: input.language, onOutput: input.onOutput })
      : entry.handle.runCommand(input.command!, { timeoutMs: input.timeoutMs, onOutput: input.onOutput });
    const result = await this.raceControls(task, input.signal, input.timeoutMs, entry);
    return normalizeExecutionResult(result);
  }

  async stop(input: ReleaseSandboxInput): Promise<void> {
    const entry = this.leases.get(input.lease.id);
    if (!entry || !entry.active) return;
    entry.active = false;
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
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controls: Array<Promise<ExecResult>> = [task];
    if (signal) {
      controls.push(new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          entry.active = false;
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
