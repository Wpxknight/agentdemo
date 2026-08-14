import { describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { access, link, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '../packages/sandbox-runtime/src/lifecycle.js';
import { LocalSandboxProvider } from '../packages/sandbox-runtime/src/local.js';
import { SandboxRuntime } from '../packages/sandbox-runtime/src/runtime.js';
import { OpenSandboxDesktopProvider } from '../packages/sandbox-runtime/src/opensandbox-desktop.js';
import { buildSandboxTools } from '../src/tools/builtin.js';
import { buildSandboxProfileTools } from '../src/tools/sandbox-profiles.js';
import type {
  ExecResult,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from '../packages/sandbox-runtime/src/types.js';

function deferredHandle() {
  let resolve!: (handle: SandboxHandle) => void;
  const promise = new Promise<SandboxHandle>((res) => { resolve = res; });
  return { promise, resolve };
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** 一个可控的 mock 沙箱句柄 + provider，记录调用次数。 */
function mockProvider() {
  let seq = 0;
  const killed: string[] = [];
  const makeHandle = (id: string): SandboxHandle => ({
    sandboxId: id,
    runCode: vi.fn(
      async (code: string): Promise<ExecResult> => ({ stdout: `code:${code}`, stderr: '' }),
    ),
    runCommand: vi.fn(
      async (cmd: string): Promise<ExecResult> => ({
        stdout: `out:${cmd}`,
        stderr: '',
        exitCode: cmd.includes('fail') ? 1 : 0,
        error: cmd.includes('fail') ? 'boom' : undefined,
      }),
    ),
    setTimeout: vi.fn(async () => {}),
    readFile: vi.fn(async () => new Uint8Array()),
    kill: vi.fn(async () => {
      killed.push(id);
    }),
  });

  const provider: SandboxProvider = {
    create: vi.fn(async (_spec: SandboxSpec) => makeHandle(`new-${++seq}`)),
    connect: vi.fn(async (sandboxId: string) => makeHandle(sandboxId)),
  };
  return { provider, killed };
}

describe('SandboxManager', () => {
  it('reports inflight activity and rejects new work after draining starts', async () => {
    let release!: (handle: SandboxHandle) => void;
    const creating = new Promise<SandboxHandle>((resolve) => { release = resolve; });
    const provider: SandboxProvider = {
      create: vi.fn(async () => creating),
      connect: vi.fn(async () => creating),
    };
    const mgr = new SandboxManager({ provider });
    const pending = mgr.get({ key: 'started' });

    expect(mgr.activity()).toEqual({ active: 0, inflight: 1, cleanup: 0 });
    mgr.beginDrain();
    await expect(mgr.get({ key: 'new' })).rejects.toThrow(/draining|禁用/);

    const handle = mockProvider().provider.create({ key: 'unused' });
    release(await handle);
    await pending;
    expect(mgr.activity()).toEqual({ active: 1, inflight: 0, cleanup: 0 });
  });

  it('filters listings and session disposal by tenant and user', async () => {
    const { provider, killed } = mockProvider();
    const mgr = new SandboxManager({ provider });
    await mgr.get({
      key: 'tenant-a:user-a:same',
      metadata: { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'same' },
    });
    await mgr.get({
      key: 'tenant-b:user-b:same',
      metadata: { tenantId: 'tenant-b', userId: 'user-b', sessionId: 'same' },
    });

    expect(mgr.list({ tenantId: 'tenant-a', userId: 'user-a', role: 'user' })).toHaveLength(1);
    expect(mgr.list({ tenantId: 'tenant-a', userId: 'admin', role: 'platform_admin' })).toHaveLength(2);

    const disposed = await mgr.disposeSession(
      { tenantId: 'tenant-a', userId: 'user-a', role: 'user' },
      'same',
    );
    expect(disposed).toEqual(['tenant-a:user-a:same']);
    expect(killed).toEqual(['new-1']);
    expect(mgr.size()).toBe(1);
  });

  it('caches by key: repeated get creates only once', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });

    const a = await mgr.get({ key: 's1' });
    const b = await mgr.get({ key: 's1' });

    expect(a).toBe(b);
    expect(provider.create).toHaveBeenCalledOnce();
    expect(mgr.size()).toBe(1);
  });

  it('dedups concurrent get for same key', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });

    const [a, b] = await Promise.all([mgr.get({ key: 's1' }), mgr.get({ key: 's1' })]);

    expect(a).toBe(b);
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it('connects to remote when sandboxId given', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });

    const h = await mgr.get({ key: 's1', sandboxId: 'remote-x' });

    expect(provider.connect).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled();
    expect(h.sandboxId).toBe('remote-x');
  });

  it('sweep reclaims idle sandboxes and keeps fresh ones', async () => {
    const { provider, killed } = mockProvider();
    let clock = 1_000;
    const mgr = new SandboxManager({ provider, idleMs: 100, now: () => clock });

    await mgr.get({ key: 'old' });
    clock += 50;
    await mgr.get({ key: 'fresh' }); // fresh used at 1050

    clock += 80; // now 1130: old idle 130>100, fresh idle 80<=100
    const reclaimed = await mgr.sweep();

    expect(reclaimed).toEqual(['old']);
    expect(killed).toEqual(['new-1']);
    expect(mgr.has('old')).toBe(false);
    expect(mgr.has('fresh')).toBe(true);
  });

  it('does not sweep an idle sandbox while an active operation is still using it', async () => {
    const { provider, killed } = mockProvider();
    const active = deferredVoid();
    let clock = 0;
    const mgr = new SandboxManager({ provider, idleMs: 10, now: () => clock });
    await mgr.get({ key: 'browser' });

    clock = 11;
    const operation = mgr.use('browser', async () => active.promise);
    await expect(mgr.sweep()).resolves.toEqual([]);
    expect(killed).toEqual([]);
    expect(mgr.activity().inflight).toBe(1);

    clock = 20;
    active.resolve();
    await operation;
    expect(mgr.activity().inflight).toBe(0);

    clock = 29;
    await expect(mgr.sweep()).resolves.toEqual([]);
    clock = 30;
    await expect(mgr.sweep()).resolves.toEqual(['browser']);
    expect(killed).toEqual(['new-1']);
  });

  it('renews backend timeout on reuse', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider, timeoutMs: 5_000 });

    const h = await mgr.get({ key: 's1' }); // 新建：不续期
    expect(h.setTimeout).not.toHaveBeenCalled();

    await mgr.get({ key: 's1' }); // 复用：按 timeoutMs 续期
    await mgr.get({ key: 's1' });
    expect(h.setTimeout).toHaveBeenCalledTimes(2);
    expect(h.setTimeout).toHaveBeenLastCalledWith(5_000);
  });

  it('lists active sandboxes with session bindings and timestamps', async () => {
    const { provider } = mockProvider();
    let clock = 1_000;
    const mgr = new SandboxManager({ provider, now: () => clock });

    await mgr.get({ key: 'sess-a' });
    clock = 2_000;
    await mgr.get({ key: 'sess-b:prod', template: 'fabric-node', metadata: { cluster: 'prod' } });

    expect(mgr.list()).toEqual([
      expect.objectContaining({
        id: 'new-1',
        sandboxId: 'new-1',
        key: 'sess-a',
        sessionId: 'sess-a',
        status: 'ready',
        type: 'session',
        createdAt: new Date(1_000).toISOString(),
        lastUsedAt: new Date(1_000).toISOString(),
      }),
      expect.objectContaining({
        id: 'new-2',
        sandboxId: 'new-2',
        key: 'sess-b:prod',
        sessionId: 'sess-b',
        status: 'ready',
        type: 'fabric-node',
        metadata: { cluster: 'prod' },
        createdAt: new Date(2_000).toISOString(),
        lastUsedAt: new Date(2_000).toISOString(),
      }),
    ]);
  });

  it('lists profile metadata for active sandboxes', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });

    await mgr.get({
      key: 'sess-a:profile:netdiag',
      profile: 'netdiag',
      template: 'aiop/opensandbox-netdiag:dev',
      domain: 'opensandbox-netdiag.opensandbox-system.svc:80',
      metadata: { sessionId: 'sess-a', profile: 'netdiag', privileged: 'true', capabilities: 'kubectl,tcpdump' },
    });

    expect(mgr.list()).toEqual([
      expect.objectContaining({
        key: 'sess-a:profile:netdiag',
        sessionId: 'sess-a',
        type: 'netdiag',
        profile: 'netdiag',
        image: 'aiop/opensandbox-netdiag:dev',
        domain: 'opensandbox-netdiag.opensandbox-system.svc:80',
        privileged: true,
        capabilities: ['kubectl', 'tcpdump'],
      }),
    ]);
  });

  it('disposeSession kills the default key and all cluster keys', async () => {
    const { provider, killed } = mockProvider();
    const mgr = new SandboxManager({ provider });

    await mgr.get({ key: 'sess' }); // 默认会话沙箱
    await mgr.get({ key: 'sess:prod' }); // 集群键
    await mgr.get({ key: 'sess:dev' });
    await mgr.get({ key: 'other' }); // 别的会话，不应被清

    const keys = await mgr.disposeSession('sess');

    expect(keys.sort()).toEqual(['sess', 'sess:dev', 'sess:prod']);
    expect(killed.length).toBe(3);
    expect(mgr.has('sess')).toBe(false);
    expect(mgr.has('sess:prod')).toBe(false);
    expect(mgr.has('other')).toBe(true);
  });

  it('disposeAll kills a handle that completes after disposal without caching it', async () => {
    const creating = deferredHandle();
    const killed: string[] = [];
    const provider: SandboxProvider = {
      create: vi.fn(async () => creating.promise),
      connect: vi.fn(async () => creating.promise),
    };
    const mgr = new SandboxManager({ provider });
    const pending = mgr.get({ key: 'late' });

    await mgr.disposeAll();
    creating.resolve({
      sandboxId: 'late',
      runCode: vi.fn(async () => ({ stdout: '', stderr: '' })),
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      setTimeout: vi.fn(async () => {}),
      readFile: vi.fn(async () => new Uint8Array()),
      kill: vi.fn(async () => { killed.push('late'); }),
    });

    await expect(pending).rejects.toThrow(/disposed/);
    expect(killed).toEqual(['late']);
    expect(mgr.size()).toBe(0);
  });

  it('serializes overlapping sweeps until pending kills complete', async () => {
    const killing = deferredVoid();
    const { provider } = mockProvider();
    let now = 10;
    const mgr = new SandboxManager({ provider, idleMs: 1, now: () => now });
    const handle = await mgr.get({ key: 'old' });
    vi.mocked(handle.kill).mockImplementation(async () => killing.promise);
    now = 12;

    const first = mgr.sweep();
    const second = mgr.sweep();
    expect(mgr.activity().cleanup).toBe(1);
    killing.resolve();

    await expect(first).resolves.toEqual(['old']);
    await expect(second).resolves.toEqual(['old']);
    expect(handle.kill).toHaveBeenCalledOnce();
    expect(mgr.activity().cleanup).toBe(0);
  });

  it('disposeSession invalidates a matching in-flight create', async () => {
    const creating = deferredHandle();
    const killed: string[] = [];
    const provider: SandboxProvider = {
      create: vi.fn(async () => creating.promise),
      connect: vi.fn(async () => creating.promise),
    };
    const mgr = new SandboxManager({ provider });
    const pending = mgr.get({
      key: 'tenant-a:user-a:late-session',
      metadata: { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'late-session' },
    });
    await mgr.disposeSession({ tenantId: 'tenant-a', userId: 'user-a', role: 'user' }, 'late-session');
    creating.resolve({
      sandboxId: 'late-session',
      runCode: vi.fn(async () => ({ stdout: '', stderr: '' })),
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
      setTimeout: vi.fn(async () => {}),
      readFile: vi.fn(async () => new Uint8Array()),
      kill: vi.fn(async () => { killed.push('late-session'); }),
    });

    await expect(pending).rejects.toThrow(/session is disposed/);
    expect(killed).toEqual(['late-session']);
    expect(mgr.size()).toBe(0);
  });

  it('disposeAll kills everything', async () => {
    const { provider, killed } = mockProvider();
    const mgr = new SandboxManager({ provider });
    await mgr.get({ key: 'a' });
    await mgr.get({ key: 'b' });

    await mgr.disposeAll();

    expect(killed.sort()).toEqual(['new-1', 'new-2']);
    expect(mgr.size()).toBe(0);
  });

  it('merges concurrent disposeAll calls until active kills finish', async () => {
    const killing = deferredVoid();
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const handle = await mgr.get({ key: 'active' });
    vi.mocked(handle.kill).mockImplementation(async () => killing.promise);

    const first = mgr.disposeAll();
    const second = mgr.disposeAll();
    expect(first).toBe(second);
    expect(mgr.activity().cleanup).toBe(1);

    killing.resolve();
    await Promise.all([first, second]);
    expect(handle.kill).toHaveBeenCalledOnce();
    expect(mgr.activity().cleanup).toBe(0);
  });
});

describe('production sandbox tools', () => {
  it('executes through SandboxRuntime controls and aborts the managed handle', async () => {
    const abort = new AbortController();
    const kill = vi.fn(async () => undefined);
    const handle: SandboxHandle = {
      sandboxId: 'managed',
      runCode: vi.fn(async () => new Promise<ExecResult>(() => undefined)),
      runCommand: vi.fn(async () => new Promise<ExecResult>(() => undefined)),
      readFile: vi.fn(async () => new Uint8Array()),
      setTimeout: vi.fn(async () => undefined),
      kill,
    };
    const acquisition = { handle, spec: { key: 'tenant:user:session' }, markCredentialInjected() {} };
    const manager = {
      acquire: vi.fn(async () => acquisition), acquireSpec: vi.fn(async () => acquisition),
      get: vi.fn(async () => handle), has: vi.fn(() => true), touch: vi.fn(() => true),
      use: vi.fn(async (_key, action) => action()), markCredentialInjected: vi.fn(), size: vi.fn(() => 1),
      list: vi.fn(() => []), dispose: vi.fn(async () => undefined),
      disposeSession: vi.fn(async () => []), disposeAll: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof buildSandboxTools>[0];
    const runCommand = buildSandboxTools(manager).find((tool) => tool.name === 'sbx__run_command')!;

    const execution = runCommand.execute({ command: 'wait' }, {
      sessionId: 'session', tenantId: 'tenant', userId: 'user', role: 'user', signal: abort.signal,
    });
    abort.abort();

    await expect(Promise.race([
      execution,
      new Promise((_, reject) => setTimeout(() => reject(new Error('runtime abort missing')), 100)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    expect(kill).toHaveBeenCalledOnce();
  });
});

describe('LocalSandboxProvider structured execution', () => {
  it('keeps argv, cwd, and env separate from shell parsing', async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.create({ key: 'structured-local' });
    await handle.writeFile?.('workspace/script.js', new TextEncoder().encode('process.stdout.write(process.argv[2]+":"+process.env.TOKEN)'));
    await expect(handle.executeCommand!({
      program: process.execPath, args: ['script.js', 'two words'], cwd: 'workspace', env: { TOKEN: 'secret' },
    })).resolves.toMatchObject({ stdout: 'two words:secret', exitCode: 0 });
    await handle.kill();
  });

  it.each(['abort', 'timeout', 'stop'] as const)('%s terminates the active local process tree promptly', async (mode) => {
    const runtime = new SandboxRuntime({ providerName: 'local', provider: new LocalSandboxProvider() });
    const lease = await runtime.acquire({ spec: { key: `local-child-${mode}` } });
    const started = deferred<{ parentPid: number; descendantPid: number }>();
    let output = '';
    const abort = new AbortController();
    const execution = runtime.execute({
      lease,
      command: 'sleep 60 & child=$!; printf "%s %s\\n" "$$" "$child"; wait',
      ...(mode === 'abort' ? { signal: abort.signal } : {}),
      ...(mode === 'timeout' ? { timeoutMs: 1000 } : {}),
      onOutput: ({ text }) => {
        output += text;
        const match = /^(\d+) (\d+)$/m.exec(output);
        if (!match) return;
        const parentPid = Number.parseInt(match[1]!, 10);
        const descendantPid = Number.parseInt(match[2]!, 10);
        if (validTestChildPid(parentPid) && validTestChildPid(descendantPid)) {
          started.resolve({ parentPid, descendantPid });
        }
      },
    });
    const pids = await started.promise;

    try {
      if (mode === 'abort') abort.abort();
      if (mode === 'stop') await expectSettlesPromptly(runtime.stop({ lease }));
      if (mode === 'abort') {
        await expect(expectSettlesPromptly(execution)).rejects.toMatchObject({ name: 'AbortError' });
      } else {
        await expectSettlesPromptly(execution, mode === 'timeout' ? 2_000 : 500);
      }

      await vi.waitFor(() => {
        expect(processExists(pids.parentPid)).toBe(false);
        expect(processExists(pids.descendantPid)).toBe(false);
      });
    } finally {
      await Promise.all([cleanupTestChild(pids.parentPid), cleanupTestChild(pids.descendantPid)]);
      await runtime.release({ lease });
    }
  });
});

async function expectSettlesPromptly<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local process tree did not settle promptly')), timeoutMs)),
  ]);
}

function validTestChildPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

async function cleanupTestChild(pid: number): Promise<void> {
  if (!validTestChildPid(pid) || !processExists(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await vi.waitFor(() => expect(processExists(pid)).toBe(false));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

describe('sandbox tools', () => {
  const ctx = { sessionId: 'sess-1' };

  it('sbx:run_code returns stdout', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const [runCode] = buildSandboxTools(mgr);

    const res = await runCode!.execute({ code: 'print(1)' }, ctx);

    expect(res.content).toBe('code:print(1)');
    expect(res.isError).toBeFalsy();
  });

  it('sbx__run_command flags non-zero exit as error', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const tools = buildSandboxTools(mgr);
    const runCommand = tools.find((t) => t.name === 'sbx__run_command')!;

    const res = await runCommand.execute({ command: 'do-fail' }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content).toContain('boom');
    expect(res.content).toContain('exit code');
  });

  it('sbx:run_code validates required arg', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const [runCode] = buildSandboxTools(mgr);

    await expect(runCode!.execute({}, ctx)).rejects.toThrow(/code/);
  });

  it('isolates same-named sessions by tenant and user identity', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const [runCode] = buildSandboxTools(mgr);

    await runCode!.execute({ code: 'print("a")' }, {
      sessionId: 'same', tenantId: 'tenant-a', userId: 'user-a', role: 'user',
    });
    await runCode!.execute({ code: 'print("b")' }, {
      sessionId: 'same', tenantId: 'tenant-b', userId: 'user-b', role: 'user',
    });

    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(mgr.list().map((item) => item.key)).toEqual([
      '["tenant-a","user-a","same"]',
      '["tenant-b","user-b","same"]',
    ]);
    expect(mgr.list()[0]?.metadata).toMatchObject({
      tenantId: 'tenant-a', userId: 'user-a', sessionId: 'same',
    });
  });

  it('isolates sandbox tools by session and exposes both bindings', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const [runCode] = buildSandboxTools(mgr);

    await runCode!.execute({ code: 'print("a")' }, { sessionId: 'session-a' });
    await runCode!.execute({ code: 'print("b")' }, { sessionId: 'session-b' });

    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(mgr.list().map((item) => [item.key, item.sessionId, item.id])).toEqual([
      ['session-a', 'session-a', 'new-1'],
      ['session-b', 'session-b', 'new-2'],
    ]);
  });

  it('lets the agent list profiles and run commands in the selected sandbox profile', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const tools = buildSandboxProfileTools(mgr, [
      {
        id: 'code', name: 'code',
        description: '普通代码沙箱',
        envType: 'code', runtimeRole: 'sandbox-reader',
        image: 'aiop/opensandbox-code:dev',
        desktop: false,
        privileged: false,
        capabilities: ['python', 'shell'],
      },
      {
        id: 'netdiag', name: 'netdiag',
        description: '网络排查沙箱',
        envType: 'code', runtimeRole: 'sandbox-diag',
        image: 'aiop/opensandbox-netdiag:dev',
        desktop: false,
        privileged: true,
        capabilities: ['kubectl', 'tcpdump'],
      },
    ]);
    const listProfiles = tools.find((tool) => tool.name === 'sandbox_list_profiles')!;
    const runCommand = tools.find((tool) => tool.name === 'sandbox_run_command')!;

    const listed = await listProfiles.execute({}, ctx);
    expect(listed.content).toContain('netdiag');
    expect(listed.content).toContain('tcpdump');

    const res = await runCommand.execute({
      profile: 'netdiag', command: 'kubectl get pods', timeoutMs: 600_000,
    }, ctx);

    expect(res.content).toContain('out:kubectl get pods');
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      key: 'sess-1:profile:netdiag',
      profile: 'netdiag',
      template: 'aiop/opensandbox-netdiag:dev',
      metadata: expect.objectContaining({ sessionId: 'sess-1', profile: 'netdiag', privileged: 'true' }),
    }));
    const created = await vi.mocked(provider.create).mock.results[0]!.value;
    expect(created.runCommand).toHaveBeenCalledWith('kubectl get pods', expect.objectContaining({ timeoutMs: 600_000 }));
    expect(mgr.list()[0]).toMatchObject({ profile: 'netdiag', sessionId: 'sess-1' });
    await expect(runCommand.execute({
      profile: 'netdiag', command: 'true', timeoutMs: 900_001,
    }, ctx)).rejects.toThrow(/timeoutMs/);
  });

  it('normalizes but ignores placement routing for non-AIOS profile tools', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const tools = buildSandboxProfileTools(mgr, [{
      id: 'code', name: 'code', description: 'code', envType: 'code', runtimeRole: 'sandbox-reader',
      image: 'code-image', desktop: false, privileged: false, capabilities: ['shell'],
    }]);
    const run = tools.find((tool) => tool.name === 'sandbox_run_command')!;
    await run.execute({ profile: 'code', command: 'true', clusterName: 'pc1' }, ctx);
    await run.execute({ profile: 'code', command: 'true', clusterName: 'pc2' }, ctx);
    await run.execute({ profile: 'code', command: 'true', clusterName: 'pc1' }, ctx);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(mgr.list().map((item) => item.key)).toEqual(['sess-1:profile:code']);
    await expect(run.execute({
      profile: 'code', command: 'true', clusterName: 'pc1', clusterId: '35',
    }, ctx)).resolves.toMatchObject({ isError: false });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
});

describe('LocalSandboxProvider', () => {
  it.each([
    ['cpu', { cpu: 1 }],
    ['memoryMb', { memoryMb: 512 }],
    ['network', { network: 'none' as const }],
  ])('explicitly rejects unsupported %s isolation for create and connect', async (field, resource) => {
    const provider = new LocalSandboxProvider();
    const spec = { key: `local-unsupported-${field}`, ...resource };

    await expect(provider.create(spec)).rejects.toThrow(new RegExp(`LocalSandboxProvider.*${field}.*not support`, 'i'));
    await expect(provider.connect('local-existing', spec))
      .rejects.toThrow(new RegExp(`LocalSandboxProvider.*${field}.*not support`, 'i'));
  });

  it('executes shell commands in a disposable local sandbox', async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.create({ key: 'local-test' });
    try {
      const res = await handle.runCommand('printf local-ok');

      expect(res).toMatchObject({ stdout: 'local-ok', stderr: '', exitCode: 0 });
    } finally {
      await handle.kill();
    }
  });

  it('executes JavaScript code and returns stdout', async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.create({ key: 'local-code-test' });
    try {
      const res = await handle.runCode('console.log("js-ok")', { language: 'javascript' });

      expect(res.stdout.trim()).toBe('js-ok');
      expect(res.exitCode).toBe(0);
    } finally {
      await handle.kill();
    }
  });

  it('maps sandbox workspace paths inside its disposable root and removes them on kill', async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.create({ key: 'local-workspace-test' });
    const sandboxPath = `/workspace/${handle.sandboxId}/credentials/token.json`;
    const workspaceFile = handle.workspacePath?.(`${handle.sandboxId}/credentials/token.json`);
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();
    expect(handle.supportsSecretFiles).toBe(false);
    expect(workspaceFile).toBe(`workspace/${handle.sandboxId}/credentials/token.json`);
    await handle.writeFile?.(sandboxPath, Buffer.from('secret'), { mode: 0o600 });

    const hostFile = join(sandboxRoot, workspaceFile!);
    expect(await readFile(hostFile, 'utf8')).toBe('secret');
    expect((await stat(hostFile)).mode & 0o777).toBe(0o600);
    const command = await handle.runCommand(`test -f '${workspaceFile}' && printf mapped`);
    expect(command).toMatchObject({ stdout: 'mapped', exitCode: 0 });
    await expect(access(sandboxPath)).rejects.toThrow();

    await handle.kill();
    await expect(access(sandboxRoot)).rejects.toThrow();
  });

  it('rejects local sandbox path traversal and non-workspace host absolute paths', async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.create({ key: 'local-containment-test' });
    try {
      expect(() => handle.workspacePath?.('../escape')).toThrow('escapes sandbox root');
      await expect(handle.writeFile?.('/workspace/../escape', Buffer.from('no'))).rejects.toThrow('escapes sandbox root');
      await expect(handle.readFile('/etc/passwd')).rejects.toThrow('unsupported sandbox absolute path');
    } finally {
      await handle.kill();
    }
  });

  it('rejects parent and final symlinks without changing host files', async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), 'aiop-local-symlink-host-'));
    const parentTarget = join(hostRoot, 'parent.txt');
    const finalTarget = join(hostRoot, 'final.txt');
    await writeFile(parentTarget, 'parent-original');
    await writeFile(finalTarget, 'final-original');
    const handle = await new LocalSandboxProvider().create({ key: 'local-symlink-test' });
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();
    await mkdir(join(sandboxRoot, 'workspace'), { recursive: true });
    await symlink(hostRoot, join(sandboxRoot, 'workspace', 'parent-link'));
    await symlink(finalTarget, join(sandboxRoot, 'workspace', 'final-link'));
    try {
      await expect(handle.writeFile?.('workspace/parent-link/parent.txt', Buffer.from('changed')))
        .rejects.toThrow('symbolic link');
      await expect(handle.readFile('workspace/parent-link/parent.txt')).rejects.toThrow('symbolic link');
      await expect(handle.writeFile?.('workspace/final-link', Buffer.from('changed')))
        .rejects.toThrow('symbolic link');
      await expect(handle.readFile('workspace/final-link')).rejects.toThrow('symbolic link');
      await expect(readFile(parentTarget, 'utf8')).resolves.toBe('parent-original');
      await expect(readFile(finalTarget, 'utf8')).resolves.toBe('final-original');
    } finally {
      await handle.kill();
    }
    await expect(access(sandboxRoot)).rejects.toThrow();
    await expect(readFile(parentTarget, 'utf8')).resolves.toBe('parent-original');
    await expect(readFile(finalTarget, 'utf8')).resolves.toBe('final-original');
  });

  it('keeps file operations anchored when a checked parent is replaced before open', async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), 'aiop-local-race-host-'));
    const hostFile = join(hostRoot, 'victim.txt');
    await writeFile(hostFile, 'host-original');
    let swapped = false;
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const [target, flags] = args;
          if (!swapped && String(target).includes('/.aiop-write-')
            && typeof flags === 'number' && (flags & constants.O_EXCL) !== 0) {
            swapped = true;
            await actual.rename(sandboxParent, `${sandboxParent}-checked`);
            await actual.symlink(hostRoot, sandboxParent);
          }
          return actual.open(...args);
        },
      };
    });
    const { LocalSandboxProvider: FreshLocalSandboxProvider } = await import('../packages/sandbox-runtime/src/local.js');
    const handle = await new FreshLocalSandboxProvider().create({ key: 'local-parent-race-test' });
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();
    const sandboxParent = join(sandboxRoot, 'workspace', 'parent');
    await mkdir(sandboxParent, { recursive: true });
    await writeFile(join(sandboxParent, 'victim.txt'), 'sandbox-original');
    try {
      await handle.writeFile?.('workspace/parent/victim.txt', Buffer.from('sandbox-changed'));

      expect(swapped).toBe(true);
      await expect(readFile(hostFile, 'utf8')).resolves.toBe('host-original');
      await expect(readFile(`${sandboxParent}-checked/victim.txt`, 'utf8')).resolves.toBe('sandbox-changed');
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      await handle.kill();
    }
    await expect(readFile(hostFile, 'utf8')).resolves.toBe('host-original');
  });

  it('atomically replaces a sandbox hardlink without truncating the host inode', async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), 'aiop-local-hardlink-host-'));
    const hostFile = join(hostRoot, 'host.txt');
    await writeFile(hostFile, 'host-original');
    const handle = await new LocalSandboxProvider().create({ key: 'local-hardlink-write' });
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();
    const sandboxFile = join(sandboxRoot, 'workspace', 'hard.txt');
    await mkdir(join(sandboxRoot, 'workspace'), { recursive: true });
    await link(hostFile, sandboxFile);
    const originalInode = (await stat(hostFile)).ino;
    try {
      await handle.writeFile?.('workspace/hard.txt', Buffer.from('sandbox-new'));

      await expect(readFile(hostFile, 'utf8')).resolves.toBe('host-original');
      await expect(readFile(sandboxFile, 'utf8')).resolves.toBe('sandbox-new');
      expect((await stat(sandboxFile)).ino).not.toBe(originalInode);
    } finally {
      await handle.kill();
    }
  });

  it('runCode replaces a hardlinked code entry without modifying the host file', async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), 'aiop-local-hardlink-code-host-'));
    const hostFile = join(hostRoot, 'main.py');
    await writeFile(hostFile, 'print("host-original")\n');
    const handle = await new LocalSandboxProvider().create({ key: 'local-hardlink-code' });
    const sandboxRoot = (await handle.runCommand('pwd')).stdout.trim();
    await link(hostFile, join(sandboxRoot, 'main.py'));
    const originalInode = (await stat(hostFile)).ino;
    try {
      const result = await handle.runCode('print("sandbox-new")', { language: 'python' });

      expect(result).toMatchObject({ stdout: 'sandbox-new\n', exitCode: 0 });
      await expect(readFile(hostFile, 'utf8')).resolves.toBe('print("host-original")\n');
      await expect(readFile(join(sandboxRoot, 'main.py'), 'utf8')).resolves.toBe('print("sandbox-new")');
      expect((await stat(join(sandboxRoot, 'main.py'))).ino).not.toBe(originalInode);
    } finally {
      await handle.kill();
    }
  });

  it('rejects unsupported platforms and missing procfs before creating a local sandbox', async () => {
    type TestOptions = {
      platform: NodeJS.Platform;
      procFdAvailable: () => Promise<boolean>;
    };
    const Provider = LocalSandboxProvider as unknown as new (options: TestOptions) => LocalSandboxProvider;
    const createAndCleanup = async (options: TestOptions) => {
      const handle = await new Provider(options).create({ key: 'local-platform-check' });
      await handle.kill();
    };

    await expect(createAndCleanup({ platform: 'darwin', procFdAvailable: async () => true }))
      .rejects.toThrow(/Linux.*procfs|支持.*Linux/i);
    await expect(createAndCleanup({ platform: 'linux', procFdAvailable: async () => false }))
      .rejects.toThrow(/procfs|\/proc\/self\/fd/i);
  });
});

describe('OpenSandboxDesktopProvider', () => {
  it('reuses the same session sandbox as code tools', async () => {
    const handle: SandboxHandle = {
      sandboxId: 'shared-sandbox',
      runCode: vi.fn(async (code: string) => ({ stdout: `code:${code}`, stderr: '', exitCode: 0 })),
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      setTimeout: vi.fn(async () => {}),
      readFile: vi.fn(async () => new Uint8Array()),
      kill: vi.fn(async () => {}),
    };
    const provider: SandboxProvider = {
      create: vi.fn(async () => handle),
      connect: vi.fn(async () => handle),
    };
    const manager = new SandboxManager({ provider });
    const [runCode] = buildSandboxTools(manager);

    await runCode!.execute({ code: 'print("same")' }, { sessionId: 'sess-k8s' });
    const desktops = new OpenSandboxDesktopProvider(manager);
    const desktop = await desktops.create({ key: 'sess-k8s', timeoutMs: 60_000 });
    await desktop.launch('google-chrome', 'https://example.com');

    expect(provider.create).toHaveBeenCalledOnce();
    expect(handle.runCode).toHaveBeenCalledOnce();
    expect(handle.runCommand).toHaveBeenCalled();
    expect(handle.runCommand).toHaveBeenCalledWith(expect.stringContaining('/ms-playwright'), { timeoutMs: 30_000 });
    const startCommand = vi.mocked(handle.runCommand).mock.calls[0]?.[0] as string;
    expect(startCommand).toContain('Xvfb');
    expect(startCommand).toContain('DISPLAY');
    expect(startCommand).not.toContain('--headless');
    expect(desktop.sandboxId).toBe('shared-sandbox');
  });

  it('returns screenshot bytes from the sandbox-local CDP helper output', async () => {
    const png = Buffer.from([1, 2, 3, 4]);
    const runCommand = vi.fn(async (command: string): Promise<ExecResult> => {
      if (command.includes('Page.captureScreenshot')) {
        return { stdout: `__AIOP_SCREENSHOT__${png.toString('base64')}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const handle: SandboxHandle = {
      sandboxId: 'shot-sandbox',
      runCode: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      runCommand,
      setTimeout: vi.fn(async () => {}),
      readFile: vi.fn(async () => new Uint8Array()),
      kill: vi.fn(async () => {}),
    };
    const provider: SandboxProvider = {
      create: vi.fn(async () => handle),
      connect: vi.fn(async () => handle),
    };
    const manager = new SandboxManager({ provider });
    const desktop = await new OpenSandboxDesktopProvider(manager).create({ key: 'shot-session' });

    const shot = await desktop.screenshot();

    expect([...shot]).toEqual([1, 2, 3, 4]);
    expect(runCommand).toHaveBeenCalledWith(expect.stringContaining('Page.captureScreenshot'), { timeoutMs: 15_000 });
  });
});
