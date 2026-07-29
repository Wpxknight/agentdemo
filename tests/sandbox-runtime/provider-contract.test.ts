import { describe, expect, it, vi } from 'vitest';
import {
  SandboxRuntime,
  type ExecResult,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
} from '../../packages/sandbox-runtime/src/index.js';

interface ContractHarness {
  runtime: SandboxRuntime;
  killed: ReturnType<typeof vi.fn>;
}

function contractHarness(providerName: string): ContractHarness {
  const killed = vi.fn(async (_sandboxId: string) => undefined);
  const handles = new Map<string, SandboxHandle>();
  const createHandle = (spec: SandboxSpec): SandboxHandle => {
    const sandboxId = `${providerName}-${spec.key}`;
    const handle: SandboxHandle = {
      sandboxId,
      runCode: async (code, options) => {
        options?.onOutput?.({ stream: 'stdout', text: code });
        return { stdout: code, stderr: '' };
      },
      runCommand: async (command, options): Promise<ExecResult> => {
        if (command === 'wait-for-abort' || command === 'wait-for-timeout') return new Promise(() => undefined);
        options?.onOutput?.({ stream: 'stdout', text: 'out' });
        options?.onOutput?.({ stream: 'stderr', text: 'err' });
        if (command === 'timeout') {
          return { stdout: '', stderr: '', exitCode: 124, error: 'process timed out' };
        }
        return { stdout: undefined, stderr: undefined, exitCode: 0 } as unknown as ExecResult;
      },
      readFile: async () => new Uint8Array(),
      setTimeout: async () => undefined,
      kill: async () => { await killed(sandboxId); handles.delete(sandboxId); },
    };
    handles.set(sandboxId, handle);
    return handle;
  };
  const provider: SandboxProvider = {
    create: async (spec) => createHandle(spec),
    connect: async (sandboxId, spec) => {
      const handle = createHandle(spec);
      Object.defineProperty(handle, 'sandboxId', { value: sandboxId });
      return handle;
    },
  };
  return { runtime: new SandboxRuntime({ provider, providerName }), killed };
}

describe.each(['local', 'e2b', 'opensandbox', 'aios'])('%s SandboxRuntime contract', (providerName) => {
  it('acquires, executes, normalizes output, stops and releases leases', async () => {
    const { runtime, killed } = contractHarness(providerName);
    const lease = await runtime.acquire({ spec: { key: 'session-a', profile: 'code' } });

    expect(lease).toMatchObject({ provider: providerName, sandboxId: `${providerName}-session-a`, profile: 'code' });
    const chunks: Array<{ stream: string; text: string }> = [];
    await expect(runtime.execute({ lease, command: 'echo ok', onOutput: (chunk) => chunks.push(chunk) }))
      .resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(chunks).toEqual([
      { stream: 'stdout', text: 'out' },
      { stream: 'stderr', text: 'err' },
    ]);

    await runtime.stop({ lease });
    await runtime.release({ lease });
    expect(killed).toHaveBeenCalledTimes(1);
    await expect(runtime.execute({ lease, command: 'echo again' })).rejects.toThrow('lease is not active');
  });

  it('normalizes provider timeouts', async () => {
    const { runtime } = contractHarness(providerName);
    const lease = await runtime.acquire({ spec: { key: 'timeout' } });
    const execution = runtime.execute({ lease, command: 'wait-for-timeout', timeoutMs: 5 });
    const bounded = Promise.race([
      execution,
      new Promise((_, reject) => setTimeout(() => reject(new Error('runtime timeout missing')), 100)),
    ]);
    await expect(bounded).resolves.toEqual({
      stdout: '', stderr: '', exitCode: 124, error: 'command timed out', timedOut: true,
    });
  });

  it('aborts execution and stops the provider handle', async () => {
    const { runtime, killed } = contractHarness(providerName);
    const lease = await runtime.acquire({ spec: { key: 'abort' } });
    const abort = new AbortController();
    const execution = runtime.execute({ lease, command: 'wait-for-abort', signal: abort.signal });
    abort.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(killed).toHaveBeenCalledTimes(1);
  });

  it('reconciles leases that are no longer desired', async () => {
    const { runtime } = contractHarness(providerName);
    const keep = await runtime.acquire({ spec: { key: 'keep' } });
    const stale = await runtime.acquire({ spec: { key: 'stale' } });

    await expect(runtime.reconcile({ activeLeaseIds: [keep.id] })).resolves.toEqual({
      activeLeaseIds: [keep.id],
      releasedLeaseIds: [stale.id],
    });
  });
});
