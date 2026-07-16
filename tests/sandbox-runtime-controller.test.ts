import { describe, expect, it, vi } from 'vitest';
import { sandboxIdentityKey } from '../src/sandbox/keys.js';
import { SandboxRuntimeController } from '../src/sandbox/runtime-controller.js';
import type { DesktopHandle } from '../src/sandbox/desktop.js';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from '../src/sandbox/types.js';

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
const spec = (sessionId: string) => ({
  key: `tenant-a:user-a:${sessionId}`,
  metadata: { tenantId: 'tenant-a', userId: 'user-a', sessionId },
});

describe('SandboxRuntimeController', () => {
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
