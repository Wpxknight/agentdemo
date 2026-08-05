import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  SandboxRuntime,
  type SandboxCommand,
  type ExecResult,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
} from '../../packages/sandbox-runtime/src/index.js';

interface ContractHarness {
  runtime: SandboxRuntime;
  killed: ReturnType<typeof vi.fn>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function acquisitionHandle(id: string) {
  const kill = vi.fn(async () => undefined);
  const handle: SandboxHandle = {
    sandboxId: id,
    runCode: async () => ({ stdout: '', stderr: '' }),
    runCommand: async () => ({ stdout: '', stderr: '' }),
    readFile: async () => new Uint8Array(),
    setTimeout: async () => undefined,
    kill,
  };
  return { handle, kill };
}

it('runs the contract through each concrete provider adapter', async () => {
  const source = await readFile(new URL('./real-provider-contract.test.ts', import.meta.url), 'utf8');
  for (const provider of ['LocalSandboxProvider', 'E2bProvider', 'OpenSandboxProvider', 'AiosE2bProvider']) {
    expect(source).toContain(`new ${provider}`);
  }
});

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

describe('SandboxRuntime provider-neutral core contract', () => {
  const providerName = 'fake';
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

  it.each(['stop', 'release'] as const)('%s invalidates an adopted manager handle exactly once', async (action) => {
    const adopted = acquisitionHandle(`adopted-${action}`);
    const invalidate = vi.fn();
    const runtime = new SandboxRuntime({
      providerName: 'managed',
      provider: { create: async () => adopted.handle, connect: async () => adopted.handle },
    });
    const lease = await runtime.adopt({ handle: adopted.handle, spec: { key: `adopted-${action}` }, invalidate });

    await runtime[action]({ lease });
    await runtime.release({ lease });

    expect(invalidate).toHaveBeenCalledOnce();
    expect(adopted.kill).toHaveBeenCalledOnce();
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

  it('preserves resource requests, structured execution, and runtime file transfer', async () => {
    const executeCommand = vi.fn(async (command: SandboxCommand) => ({
      stdout: `${command.program}:${command.args?.join(',')}:${command.cwd}:${command.env?.TOKEN}`,
      stderr: '', exitCode: 0,
    }));
    const writeFile = vi.fn(async () => undefined);
    const readFile = vi.fn(async () => new Uint8Array([7, 8, 9]));
    const create = vi.fn(async (_spec: SandboxSpec): Promise<SandboxHandle> => ({
      sandboxId: 'structured', executeCommand, runCode: async () => ({ stdout: '', stderr: '' }),
      runCommand: async () => ({ stdout: '', stderr: '' }), readFile, writeFile,
      setTimeout: async () => undefined, kill: async () => undefined,
    }));
    const runtime = new SandboxRuntime({
      providerName,
      provider: { create, connect: async (_id, spec) => create(spec) },
    });
    const lease = await runtime.acquire({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      profile: 'ops', cpu: 2, memoryMb: 4096, network: 'restricted', timeoutMs: 5000,
    });

    await expect(runtime.execute({ lease, command: {
      program: 'node', args: ['script.js', 'two words'], cwd: 'workspace', env: { TOKEN: 'secret' },
    } })).resolves.toMatchObject({ stdout: 'node:script.js,two words:workspace:secret', exitCode: 0 });
    await runtime.upload({ lease, file: { path: 'input.bin', content: new Uint8Array([1, 2]) } });
    await expect(runtime.download({ lease, path: 'output.bin' }))
      .resolves.toEqual({ path: 'output.bin', content: new Uint8Array([7, 8, 9]) });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      cpu: 2, memoryMb: 4096, network: 'restricted', timeoutMs: 5000,
    }));
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      program: 'node', args: ['script.js', 'two words'], cwd: 'workspace', env: { TOKEN: 'secret' },
    }), expect.any(Object));
    expect(writeFile).toHaveBeenCalledWith('input.bin', new Uint8Array([1, 2]));
  });

  it.each([
    { mode: 'create' as const, spec: { key: 'abort-create' } },
    { mode: 'connect' as const, spec: { key: 'abort-connect', sandboxId: 'remote-id' } },
  ])('aborts a pending $mode promptly, forwards the signal, and kills a late handle', async ({ mode, spec }) => {
    const pending = deferred<SandboxHandle>();
    const late = acquisitionHandle(`late-${mode}`);
    let receivedSignal: AbortSignal | undefined;
    const provider = {
      create: vi.fn(async (_spec: SandboxSpec, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        return pending.promise;
      }),
      connect: vi.fn(async (_id: string, _spec: SandboxSpec, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        return pending.promise;
      }),
    } as SandboxProvider;
    const runtime = new SandboxRuntime({ providerName: 'abortable', provider });
    const abort = new AbortController();
    const acquisition = runtime.acquire({ spec, signal: abort.signal });

    abort.abort();
    await expect(Promise.race([
      acquisition,
      new Promise((_, reject) => setTimeout(() => reject(new Error('acquisition abort was not prompt')), 100)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    expect(receivedSignal).toBe(abort.signal);
    expect(mode === 'create' ? provider.create : provider.connect).toHaveBeenCalledOnce();

    pending.resolve(late.handle);
    await vi.waitFor(() => expect(late.kill).toHaveBeenCalledOnce());
  });
});
