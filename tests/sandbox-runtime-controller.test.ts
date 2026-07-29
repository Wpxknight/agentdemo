import { describe, expect, it, vi } from 'vitest';
import { sandboxIdentityKey } from '../packages/sandbox-runtime/src/keys.js';
import { SandboxRuntimeController } from '../packages/sandbox-runtime/src/runtime-controller.js';
import { executeAcquiredSandbox } from '../packages/sandbox-runtime/src/runtime.js';
import type { DesktopHandle } from '../packages/sandbox-runtime/src/desktop.js';
import { buildSandboxProfileTools } from '../src/tools/sandbox-profiles.js';
import type { SandboxProfile } from '../packages/sandbox-runtime/src/profiles.js';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from '../packages/sandbox-runtime/src/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function desktopHandle(id: string, killed: string[]): DesktopHandle {
  return {
    sandboxId: id,
    startStream: vi.fn(async () => 'https://preview.test'),
    streamUrl: vi.fn(() => 'https://preview.test'),
    launch: vi.fn(async () => {}),
    leftClick: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    screenshot: vi.fn(async () => new Uint8Array()),
    kill: vi.fn(async () => { killed.push(id); }),
  };
}

function provider(prefix: string) {
  let sequence = 0;
  const killed: string[] = [];
  const handles = new Map<string, SandboxHandle>();
  const createHandle = (spec: SandboxSpec): SandboxHandle => {
    const sandboxId = `${prefix}-${++sequence}`;
    const handle: SandboxHandle = {
      sandboxId,
      runCode: vi.fn(async () => ({ stdout: prefix, stderr: '', exitCode: 0 })),
      runCommand: vi.fn(async () => ({ stdout: prefix, stderr: '', exitCode: 0 })),
      readFile: vi.fn(async () => new Uint8Array()),
      setTimeout: vi.fn(async () => {}),
      kill: vi.fn(async () => { killed.push(sandboxId); }),
    };
    handles.set(spec.key, handle);
    return handle;
  };
  const instance: SandboxProvider = {
    create: vi.fn(async (spec) => createHandle(spec)),
    connect: vi.fn(async (_id, spec) => createHandle(spec)),
  };
  return { instance, killed, handles };
}

const userA = { tenantId: 'tenant-a', userId: 'user-a', role: 'user' as const };
const platformAdmin = { tenantId: 'tenant-a', userId: 'admin-a', role: 'platform_admin' as const };
const authorizedProfiles: SandboxProfile[] = [
  {
    id: 'reader-id',
    name: 'code',
    template: 'reader-template',
    description: 'Reader profile',
    envType: 'code',
    runtimeRole: 'sandbox-reader',
    desktop: false,
    privileged: false,
    capabilities: ['shell'],
  },
  {
    id: 'diag-id',
    name: 'netdiag',
    template: 'diag-template',
    description: 'Diagnostic profile',
    envType: 'code',
    runtimeRole: 'sandbox-diag',
    desktop: false,
    privileged: true,
    capabilities: ['diagnostics'],
  },
];
const spec = (sessionId: string) => ({
  key: `tenant-a:user-a:${sessionId}`,
  metadata: { tenantId: 'tenant-a', userId: 'user-a', sessionId },
});

describe('SandboxRuntimeController', () => {
  it.each(['timeout', 'abort'] as const)('evicts a managed handle killed by execution %s', async (control) => {
    const backend = provider('controlled');
    vi.mocked(backend.instance.create).mockImplementation(async (sandboxSpec) => {
      const handle = await provider('handle').instance.create(sandboxSpec);
      vi.mocked(handle.runCommand).mockImplementation(async () => new Promise(() => undefined));
      return handle;
    });
    const controller = new SandboxRuntimeController();
    await controller.commit({ manager: { provider: backend.instance }, profiles: [] });
    const sandboxSpec = spec(`killed-${control}`);
    const acquired = await controller.acquireSpec({ ...userA, sessionId: `killed-${control}` }, sandboxSpec);
    const abort = new AbortController();
    const execution = executeAcquiredSandbox(acquired, {
      command: 'wait',
      ...(control === 'timeout' ? { timeoutMs: 5 } : { signal: abort.signal }),
    });
    if (control === 'abort') abort.abort();

    if (control === 'timeout') {
      await expect(execution).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    } else {
      await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    }
    await vi.waitFor(() => expect(acquired.handle.kill).toHaveBeenCalledOnce());

    const replacement = await controller.acquireSpec(
      { ...userA, sessionId: `killed-${control}` },
      sandboxSpec,
    );
    expect(replacement.handle).not.toBe(acquired.handle);
    expect(backend.instance.create).toHaveBeenCalledTimes(2);
    acquired.invalidate?.();
    await expect(controller.acquireSpec(
      { ...userA, sessionId: `killed-${control}` },
      sandboxSpec,
    )).resolves.toMatchObject({ handle: replacement.handle });
    expect(backend.instance.create).toHaveBeenCalledTimes(2);
    await controller.disposeAll();
  });

  it.each(['acquire', 'acquireSpec'] as const)('propagates ToolContext.signal through %s acquisition', async (method) => {
    const pending = deferred<SandboxHandle>();
    let receivedSignal: AbortSignal | undefined;
    let attempts = 0;
    const fresh = await provider('fresh').instance.create({ key: 'fresh' });
    const backend: SandboxProvider = {
      create: vi.fn(async (_spec: SandboxSpec, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        attempts += 1;
        return attempts === 1 ? pending.promise : fresh;
      }),
      connect: vi.fn(async () => pending.promise),
    } as SandboxProvider;
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: backend },
      profiles: [],
      resolveSpec: () => spec('signal'),
    });
    const abort = new AbortController();
    const ctx = { ...userA, sessionId: 'signal', signal: abort.signal };
    const acquisition = method === 'acquire'
      ? controller.acquire(ctx)
      : controller.acquireSpec(ctx, spec('signal'));

    await vi.waitFor(() => expect(receivedSignal).toBe(abort.signal));
    abort.abort();
    await expect(Promise.race([
      acquisition,
      new Promise((_, reject) => setTimeout(() => reject(new Error('controller abort was not prompt')), 100)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    const late = await provider('late').instance.create({ key: 'late' });
    pending.resolve(late);
    await vi.waitFor(() => expect(late.kill).toHaveBeenCalledOnce());
    await expect(controller.acquireSpec(
      { ...userA, sessionId: 'signal' },
      spec('signal'),
    )).resolves.toMatchObject({ handle: fresh });
    expect(backend.create).toHaveBeenCalledTimes(2);
    await controller.disposeAll();
  });

  it.each(['acquire', 'acquireSpec'] as const)('aborts %s while its spec source is still pending', async (method) => {
    const resolving = deferred<Partial<SandboxSpec>>();
    const backend = provider('unreached');
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: backend.instance },
      profiles: [],
      resolveSpec: () => resolving.promise,
    });
    const abort = new AbortController();
    const ctx = { ...userA, sessionId: 'pending-spec', signal: abort.signal };
    const acquisition = method === 'acquire'
      ? controller.acquire(ctx)
      : controller.acquireSpec(ctx, () => resolving.promise as Promise<SandboxSpec>);

    abort.abort();
    await expect(Promise.race([
      acquisition,
      new Promise((_, reject) => setTimeout(() => reject(new Error('spec resolution abort was not prompt')), 100)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.instance.create).not.toHaveBeenCalled();

    resolving.resolve(spec('pending-spec'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.instance.create).not.toHaveBeenCalled();
    await controller.disposeAll();
  });

  it('routes new sessions to the new generation while retaining old handles for disposal', async () => {
    const first = provider('first');
    const second = provider('second');
    const controller = new SandboxRuntimeController();

    await controller.commit({ manager: { provider: first.instance }, profiles: [] });
    const oldHandle = await controller.get(spec('old'));

    await controller.commit({ manager: { provider: second.instance }, profiles: [] });
    const newHandle = await controller.get(spec('new'));

    expect(oldHandle.sandboxId).toBe('first-1');
    expect(newHandle.sandboxId).toBe('second-1');
    expect(controller.list(userA).map((item) => item.sandboxId).sort()).toEqual(['first-1', 'second-1']);

    await controller.disposeSession(userA, 'old');
    expect(first.killed).toEqual(['first-1']);
    expect(second.killed).toEqual([]);
  });

  it('disables new work without killing active handles and rejects stale in-flight generation completion', async () => {
    let release!: (handle: SandboxHandle) => void;
    const pending = new Promise<SandboxHandle>((resolve) => { release = resolve; });
    const first = provider('first');
    vi.mocked(first.instance.create).mockImplementationOnce(async () => pending);
    const controller = new SandboxRuntimeController();
    await controller.commit({ manager: { provider: first.instance }, profiles: [] });

    const inflight = controller.get(spec('started'));
    await controller.commit(undefined);
    await expect(controller.get(spec('blocked'))).rejects.toThrow(/未启用|disabled/);

    release(await provider('late').instance.create({ key: 'late' }));
    await expect(inflight).resolves.toBeDefined();
    expect(controller.list(userA)).toHaveLength(1);
    await controller.disposeSession(userA, 'started');
    expect(controller.list(userA)).toEqual([]);
  });

  it('continues sweeping idle handles in a draining generation until it is empty', async () => {
    let now = 0;
    const first = provider('first');
    const second = provider('second');
    const disposed = vi.fn(async () => {});
    const controller = new SandboxRuntimeController();

    await controller.commit({
      manager: { provider: first.instance, idleMs: 1, now: () => now },
      profiles: [],
      sweepMs: 5,
      disposeResources: disposed,
    });
    await controller.get(spec('old'));
    await controller.commit({ manager: { provider: second.instance }, profiles: [] });

    now = 2;
    await vi.waitFor(() => {
      expect(first.killed).toEqual(['first-1']);
      expect(disposed).toHaveBeenCalledOnce();
    });
    expect(controller.list(userA)).toEqual([]);
    await controller.disposeAll();
  });

  it('refreshes browser activity so an actively reused desktop is not swept as idle', async () => {
    let now = 0;
    const backend = provider('browser-active');
    const desktopKills: string[] = [];
    const controller = new SandboxRuntimeController();
    const ctx = { ...userA, sessionId: 'active-browser' };

    await controller.commit({
      manager: { provider: backend.instance, idleMs: 10, now: () => now },
      profiles: [],
      sweepMs: 100_000,
      resolveDesktop: async (desktopCtx) => ({
        key: sandboxIdentityKey(desktopCtx),
        create: async () => {
          await controller.get({
            ...spec('active-browser'),
            key: sandboxIdentityKey(desktopCtx),
          });
          return desktopHandle('desktop-active', desktopKills);
        },
      }),
    });
    const desktop = await controller.desktop(ctx);
    now = 9;
    expect(await controller.desktop(ctx)).toBe(desktop);
    now = 11;

    const generation = controller as unknown as {
      current?: { manager: { sweep(): Promise<string[]> } };
    };
    await expect(generation.current!.manager.sweep()).resolves.toEqual([]);
    expect(backend.killed).toEqual([]);
    expect(desktopKills).toEqual([]);

    now = 20;
    await expect(generation.current!.manager.sweep()).resolves.toEqual([sandboxIdentityKey(ctx)]);
    expect(backend.killed).toEqual(['browser-active-1']);
    await controller.disposeAll();
  });

  it('evicts an idle desktop entry so a draining generation can finish cleanup', async () => {
    let now = 0;
    const first = provider('first');
    const second = provider('second');
    const disposed = vi.fn(async () => {});
    const desktopKills: string[] = [];
    const controller = new SandboxRuntimeController();
    const ctx = { ...userA, sessionId: 'idle-browser' };

    await controller.commit({
      manager: { provider: first.instance, idleMs: 1, now: () => now },
      profiles: [],
      sweepMs: 5,
      disposeResources: disposed,
      resolveDesktop: async (desktopCtx) => ({
        key: sandboxIdentityKey(desktopCtx),
        create: async () => {
          await controller.get({
            ...spec('idle-browser'),
            key: sandboxIdentityKey(desktopCtx),
          });
          return desktopHandle('desktop-idle', desktopKills);
        },
      }),
    });
    await controller.desktop(ctx);
    await controller.commit({ manager: { provider: second.instance }, profiles: [] });

    now = 2;
    await vi.waitFor(() => {
      expect(first.killed).toEqual(['first-1']);
      expect(desktopKills).toEqual(['desktop-idle']);
      expect(disposed).toHaveBeenCalledOnce();
    });
    await controller.disposeAll();
  });

  it('pins resolver and provider to the same generation across a settings switch', async () => {
    const first = provider('first');
    const second = provider('second');
    const resolving = deferred<Partial<SandboxSpec>>();
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: first.instance },
      profiles: [],
      resolveSpec: async () => resolving.promise,
    });

    const pending = controller.acquire({ ...userA, sessionId: 'pinned' });
    await controller.commit({
      manager: { provider: second.instance },
      profiles: [],
      resolveSpec: () => ({ key: 'new-generation', template: 'new-template' }),
    });
    resolving.resolve({ key: 'old-generation', template: 'old-template' });

    await expect(pending).resolves.toMatchObject({
      handle: { sandboxId: 'first-1' },
      spec: { key: 'old-generation', template: 'old-template' },
    });
    expect(first.instance.create).toHaveBeenCalledWith(expect.objectContaining({
      key: 'old-generation', template: 'old-template',
    }));
    expect(second.instance.create).not.toHaveBeenCalled();

    const current = await controller.acquire({ ...userA, sessionId: 'current' });
    expect(current.handle.sandboxId).toBe('second-1');
    expect(second.instance.create).toHaveBeenCalledWith(expect.objectContaining({
      key: 'new-generation', template: 'new-template',
    }));
    await controller.disposeAll();
  });

  it('does not orphan a desktop whose resolver completes after generation switch', async () => {
    const first = provider('first');
    const second = provider('second');
    const resolved = deferred<{ key: string; create: () => Promise<DesktopHandle> }>();
    const killed: string[] = [];
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: first.instance },
      profiles: [],
      resolveDesktop: async () => resolved.promise,
    });

    const desktop = controller.desktop({ ...userA, sessionId: 'old-desktop' });
    await controller.commit({ manager: { provider: second.instance }, profiles: [] });
    resolved.resolve({
      key: sandboxIdentityKey({ ...userA, sessionId: 'old-desktop' }),
      create: async () => desktopHandle('desktop-1', killed),
    });
    await expect(desktop).resolves.toMatchObject({ sandboxId: 'desktop-1' });

    await controller.disposeSession(userA, 'old-desktop');
    expect(killed).toEqual(['desktop-1']);
    await controller.disposeAll();
  });

  it('evicts rejected desktop creations so a retry can succeed', async () => {
    const backend = provider('desktop');
    let attempts = 0;
    const killed: string[] = [];
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: backend.instance },
      profiles: [],
      resolveDesktop: async () => ({
        key: 'desktop-retry',
        create: async () => {
          attempts++;
          if (attempts === 1) throw new Error('desktop create failed');
          return desktopHandle('desktop-ok', killed);
        },
      }),
    });

    const ctx = { ...userA, sessionId: 'retry' };
    await expect(controller.desktop(ctx)).rejects.toThrow('desktop create failed');
    await expect(controller.desktop(ctx)).resolves.toMatchObject({ sandboxId: 'desktop-ok' });
    expect(attempts).toBe(2);
    await controller.disposeAll();
    expect(killed).toEqual(['desktop-ok']);
  });

  it('invalidates only the targeted identity when same-named sessions overlap desktop creation', async () => {
    const backend = provider('desktop');
    const creatingA = deferred<DesktopHandle>();
    const startedA = deferred<void>();
    const killed: string[] = [];
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: backend.instance },
      profiles: [],
      resolveDesktop: async (ctx) => ({
        key: sandboxIdentityKey(ctx),
        create: async () => {
          if (ctx.tenantId === 'tenant-a') {
            startedA.resolve();
            return creatingA.promise;
          }
          return desktopHandle('desktop-b', killed);
        },
      }),
    });

    const ctxA = { ...userA, sessionId: 'same' };
    const ctxB = { tenantId: 'tenant-b', userId: 'user-b', role: 'user' as const, sessionId: 'same' };
    const desktopA = controller.desktop(ctxA);
    await startedA.promise;
    const desktopB = await controller.desktop(ctxB);
    const disposing = controller.disposeSession(userA, 'same');
    creatingA.resolve(desktopHandle('desktop-a', killed));

    await expect(desktopA).rejects.toThrow(/disposed/);
    await disposing;
    expect(killed).toEqual(['desktop-a']);
    expect(desktopB.sandboxId).toBe('desktop-b');
    expect(await controller.desktop(ctxB)).toBe(desktopB);
    await controller.disposeAll();
    expect(killed).toEqual(['desktop-a', 'desktop-b']);
  });

  it('kills a desktop created after its session is disposed', async () => {
    const backend = provider('desktop');
    const creating = deferred<DesktopHandle>();
    const started = deferred<void>();
    const killed: string[] = [];
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: backend.instance },
      profiles: [],
      resolveDesktop: async (ctx) => ({
        key: sandboxIdentityKey(ctx),
        create: async () => {
          started.resolve();
          return creating.promise;
        },
      }),
    });

    const ctx = { ...userA, sessionId: 'disposed' };
    const desktop = controller.desktop(ctx);
    await started.promise;
    const disposing = controller.disposeSession(userA, 'disposed');
    creating.resolve(desktopHandle('desktop-late', killed));

    await expect(desktop).rejects.toThrow(/disposed/);
    await disposing;
    expect(killed).toEqual(['desktop-late']);
    await controller.disposeAll();
  });

  it('does not block hard shutdown on a hung desktop create and kills a late result', async () => {
    const backend = provider('desktop');
    const creating = deferred<DesktopHandle>();
    const started = deferred<void>();
    const killed: string[] = [];
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: backend.instance },
      profiles: [],
      resolveDesktop: async (ctx) => ({
        key: sandboxIdentityKey(ctx),
        create: async () => {
          started.resolve();
          return creating.promise;
        },
      }),
    });

    const desktop = controller.desktop({ ...userA, sessionId: 'shutdown' });
    await started.promise;
    await controller.disposeAll();

    creating.resolve(desktopHandle('desktop-after-shutdown', killed));
    await expect(desktop).rejects.toThrow(/disposed/);
    expect(killed).toEqual(['desktop-after-shutdown']);
  });

  it('filters diagnostic profiles and rejects direct unauthorized acquisition before resolution', async () => {
    const backend = provider('authorized');
    const resolveSpec = vi.fn((_ctx, profileId?: string) => {
      const profile = authorizedProfiles.find((item) => item.id === (profileId ?? 'reader-id'))!;
      return { key: `profile:${profile.id}`, profile: profile.id, template: profile.template };
    });
    const controller = new SandboxRuntimeController();
    await controller.commit({ manager: { provider: backend.instance }, profiles: authorizedProfiles, resolveSpec });

    expect(controller.profiles(userA)).toEqual([
      expect.objectContaining({ id: 'reader-id', runtimeRole: 'sandbox-reader' }),
    ]);
    expect(controller.profiles(platformAdmin)).toHaveLength(2);
    await expect(controller.acquire({ ...userA, sessionId: 'blocked' }, 'diag-id'))
      .rejects.toThrow(/platform_admin|无权/);
    expect(resolveSpec).not.toHaveBeenCalled();
    expect(backend.instance.create).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized resolved profile before manager acquisition', async () => {
    const backend = provider('authorized');
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: backend.instance },
      profiles: authorizedProfiles,
      resolveSpec: () => ({ key: 'resolved-diag', profile: 'diag-id', template: 'diag-template' }),
    });

    await expect(controller.acquire({ ...userA, sessionId: 'blocked' }))
      .rejects.toThrow(/platform_admin|无权/);
    expect(backend.instance.create).not.toHaveBeenCalled();
  });

  it('lists only profiles visible to the tool caller', async () => {
    const backend = provider('authorized');
    const controller = new SandboxRuntimeController();
    await controller.commit({ manager: { provider: backend.instance }, profiles: authorizedProfiles });
    const tools = buildSandboxProfileTools(
      controller,
      (ctx) => controller.profileDefinitions({ role: ctx.role ?? 'user' }),
    );
    const list = tools.find((tool) => tool.def.name === 'sandbox_list_profiles')!;

    const userResult = await list.run({}, { ...userA, sessionId: 'user-list' });
    const adminResult = await list.run({}, { ...platformAdmin, sessionId: 'admin-list' });

    expect(userResult.content).toContain('Reader profile');
    expect(userResult.content).not.toContain('Diagnostic profile');
    expect(adminResult.content).toContain('Diagnostic profile');
  });

  it('exposes cloned catalog metadata and current desktop capability', async () => {
    const backend = provider('catalog');
    const controller = new SandboxRuntimeController();
    await controller.commit({
      manager: { provider: backend.instance },
      profiles: authorizedProfiles,
      catalog: {
        fingerprint: 'fingerprint-one',
        templateCount: 2,
        loadedAt: '2026-07-16T10:00:00.000Z',
      },
      resolveDesktop: async () => ({
        key: 'catalog-desktop',
        create: async () => desktopHandle('catalog-desktop', []),
      }),
    });

    expect(controller.desktopEnabled()).toBe(true);
    const info = controller.catalogInfo();
    expect(info).toEqual({
      fingerprint: 'fingerprint-one',
      templateCount: 2,
      loadedAt: '2026-07-16T10:00:00.000Z',
    });
    if (info) info.fingerprint = 'mutated';
    expect(controller.catalogInfo()?.fingerprint).toBe('fingerprint-one');

    await controller.commit({ manager: { provider: backend.instance }, profiles: [] });
    expect(controller.desktopEnabled()).toBe(false);
    expect(controller.catalogInfo()).toBeUndefined();
    await controller.disposeAll();
  });

  it('exposes current profiles dynamically and drains superseded warm pools', async () => {
    const first = provider('first');
    const second = provider('second');
    const drainFirst = vi.fn(async () => {});
    const drainSecond = vi.fn(async () => {});
    const controller = new SandboxRuntimeController();

    await controller.commit({
      manager: { provider: first.instance },
      profiles: [{
        name: 'browser', description: 'browser', desktop: true, privileged: false, capabilities: ['browser'],
      }],
      drainWarmPool: drainFirst,
    });
    expect(controller.profiles()).toEqual([expect.objectContaining({ name: 'browser' })]);

    await controller.commit({
      manager: { provider: second.instance },
      profiles: [{
        name: 'code', description: 'AIOS code', image: 'code-interpreter', desktop: false,
        privileged: false, capabilities: ['python', 'node', 'shell'],
      }],
      drainWarmPool: drainSecond,
    });

    expect(drainFirst).toHaveBeenCalledOnce();
    expect(drainSecond).not.toHaveBeenCalled();
    expect(controller.profiles()).toEqual([expect.objectContaining({
      name: 'code', image: 'code-interpreter', desktop: false,
    })]);
  });
});
