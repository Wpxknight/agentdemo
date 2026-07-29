import type { RequestContext, ToolContext } from './contracts.js';
import { logger } from './logger.js';
import {
  SandboxManager,
  type SandboxManagerLike,
  type SandboxManagerOptions,
  type SandboxSummary,
} from './lifecycle.js';
import type { DesktopHandle } from './desktop.js';
import { sandboxIdentityKey, sandboxIdentityMetadata } from './keys.js';
import {
  canUseSandboxProfile,
  findSandboxProfile,
  publicSandboxProfiles,
  visibleSandboxProfiles,
  type PublicSandboxProfile,
  type SandboxProfile,
} from './profiles.js';
import type { SandboxHandle, SandboxSpec } from './types.js';
import type { SandboxAcquisition, SandboxAcquirer, SpecResolver } from './acquisition.js';

const log = logger.child({ mod: 'sandbox-runtime' });

export interface SandboxCatalogGenerationInfo {
  fingerprint: string;
  templateCount: number;
  loadedAt: string;
}

export interface SandboxGenerationInput {
  manager: SandboxManagerOptions | SandboxManager;
  profiles: SandboxProfile[];
  catalog?: SandboxCatalogGenerationInfo;
  resolveSpec?: SpecResolver;
  sweepMs?: number;
  drainWarmPool?: () => Promise<void>;
  resolveDesktop?: (ctx: ToolContext) => Promise<{ key: string; create: () => Promise<DesktopHandle> }>;
  /** 候选 generation 未 commit 时释放 prepare 阶段创建的资源（如 warm pool）。 */
  disposePrepared?: () => Promise<void>;
  disposeResources?: () => Promise<void>;
}

interface DesktopEntry {
  promise: Promise<DesktopHandle>;
  sessionKeys: string[];
  handle?: DesktopHandle;
  killed: boolean;
}

interface SandboxGeneration {
  id: number;
  manager: SandboxManager;
  profiles: SandboxProfile[];
  catalog?: SandboxCatalogGenerationInfo;
  resolveSpec: SpecResolver;
  drainWarmPool?: () => Promise<void>;
  drainPromise?: Promise<void>;
  resolveDesktop?: (ctx: ToolContext) => Promise<{ key: string; create: () => Promise<DesktopHandle> }>;
  desktops: Map<string, DesktopEntry>;
  operations: number;
  sessionEpochs: Map<string, number>;
  disposed: boolean;
  cleanupPromise?: Promise<void>;
  disposeResources?: () => Promise<void>;
  sweepTimer?: ReturnType<typeof setInterval>;
}

export class SandboxRuntimeController implements SandboxAcquirer {
  private current?: SandboxGeneration;
  private readonly draining = new Set<SandboxGeneration>();
  private sequence = 0;
  private disposed = false;

  enabled(): boolean {
    return Boolean(this.current) && !this.disposed;
  }

  codeEnabled(): boolean {
    return Boolean(this.current?.profiles.some((profile) => profile.envType !== 'browser'))
      && !this.disposed;
  }

  desktopEnabled(): boolean {
    return Boolean(this.current?.resolveDesktop) && !this.disposed;
  }

  catalogInfo(): SandboxCatalogGenerationInfo | undefined {
    const catalog = this.current?.catalog;
    return catalog ? { ...catalog } : undefined;
  }

  profileDefinitions(ctx: Pick<RequestContext, 'role'> = { role: 'platform_admin' }): SandboxProfile[] {
    return visibleSandboxProfiles(this.current?.profiles ?? [], ctx.role ?? 'user').map((profile) => ({
      ...profile,
      capabilities: [...profile.capabilities],
      ...(profile.envs ? { envs: { ...profile.envs } } : {}),
    }));
  }

  profiles(ctx: Pick<RequestContext, 'role'> = { role: 'platform_admin' }): PublicSandboxProfile[] {
    return publicSandboxProfiles(visibleSandboxProfiles(this.current?.profiles ?? [], ctx.role ?? 'user'));
  }

  async desktop(ctx: ToolContext): Promise<DesktopHandle> {
    const generation = this.pinCurrent('browser sandbox is disabled');
    const sessionKeys = this.sessionKeys(ctx, ctx.sessionId);
    const sessionEpochs = this.captureSessionEpochs(generation, sessionKeys);
    try {
      if (!generation.resolveDesktop) throw new Error('browser sandbox is disabled');
      const resolved = await generation.resolveDesktop(ctx);
      this.assertOperationValid(generation, sessionEpochs);

      let entry = generation.desktops.get(resolved.key);
      if (!entry) {
        entry = {
          promise: Promise.resolve(undefined as never),
          sessionKeys,
          killed: false,
        };
        const created = resolved.create()
          .then(async (handle) => {
            entry!.handle = handle;
            if (!this.operationValid(generation, sessionEpochs) || entry!.killed) {
              await this.killDesktop(entry!);
              throw new Error('browser sandbox session is disposed');
            }
            return handle;
          })
          .catch((err) => {
            if (generation.desktops.get(resolved.key) === entry) {
              generation.desktops.delete(resolved.key);
            }
            throw err;
          });
        entry.promise = created;
        generation.desktops.set(resolved.key, entry);
      }
      generation.manager.touch(resolved.key);
      return await entry.promise;
    } finally {
      await this.unpin(generation);
    }
  }

  async acquire(ctx: ToolContext, profile?: string): Promise<SandboxAcquisition> {
    const generation = this.pinCurrent();
    const sessionKeys = this.sessionKeys(ctx, ctx.sessionId);
    const sessionEpochs = this.captureSessionEpochs(generation, sessionKeys);
    try {
      const role = ctx.role ?? 'user';
      if (profile) findSandboxProfile(generation.profiles, profile, role);
      const spec = await raceAbort(this.resolveSpec(generation, ctx, profile), ctx.signal);
      const resolvedProfile = spec.profile
        ? findSandboxProfile(generation.profiles, spec.profile, role)
        : undefined;
      if (resolvedProfile && !canUseSandboxProfile(resolvedProfile, role)) {
        throw new Error('当前身份无权使用该沙箱模板；sandbox-diag 仅 platform_admin 可用');
      }
      this.assertOperationValid(generation, sessionEpochs);
      const handle = await generation.manager.get(spec, { signal: ctx.signal });
      if (!this.operationValid(generation, sessionEpochs)) {
        generation.manager.evict(spec.key, handle);
        await handle.kill().catch(() => {});
        throw new Error('sandbox session is disposed');
      }
      return {
        handle,
        spec,
        invalidate: () => generation.manager.evict(spec.key, handle),
        markCredentialInjected: () => generation.manager.markCredentialInjected(spec.key),
      };
    } finally {
      await this.unpin(generation);
    }
  }

  async acquireSpec(
    ctx: ToolContext,
    source: SandboxSpec | (() => SandboxSpec | Promise<SandboxSpec>),
  ): Promise<SandboxAcquisition> {
    const generation = this.pinCurrent();
    const sessionKeys = this.sessionKeys(ctx, ctx.sessionId);
    const sessionEpochs = this.captureSessionEpochs(generation, sessionKeys);
    try {
      const spec = typeof source === 'function'
        ? await raceAbort(Promise.resolve().then(source), ctx.signal)
        : source;
      this.assertOperationValid(generation, sessionEpochs);
      const handle = await generation.manager.get(spec, { signal: ctx.signal });
      if (!this.operationValid(generation, sessionEpochs)) {
        generation.manager.evict(spec.key, handle);
        await handle.kill().catch(() => {});
        throw new Error('sandbox session is disposed');
      }
      return {
        handle,
        spec,
        invalidate: () => generation.manager.evict(spec.key, handle),
        markCredentialInjected: () => generation.manager.markCredentialInjected(spec.key),
      };
    } finally {
      await this.unpin(generation);
    }
  }

  async commit(input?: SandboxGenerationInput): Promise<void> {
    if (this.disposed) throw new Error('sandbox runtime controller is disposed');
    const next = input ? this.createGeneration(input) : undefined;
    const previous = this.current;
    this.current = next;
    if (!previous) return;

    // 先移入 draining；已经 pin 住 previous 的 resolver/profile 操作可以继续使用同一 manager。
    // 最后一个 pin 释放时才 beginDrain，避免切换中的异步 resolver 取得正确 generation 却被 manager 拒绝。
    this.draining.add(previous);
    await this.startDrainIfIdle(previous);
  }

  async get(spec: SandboxSpec): Promise<SandboxHandle> {
    const generation = this.pinCurrent();
    try {
      return await generation.manager.get(spec);
    } finally {
      await this.unpin(generation);
    }
  }

  has(key: string): boolean {
    return this.generations().some((generation) => generation.manager.has(key));
  }

  touch(key: string): boolean {
    let touched = false;
    for (const generation of this.generations()) {
      touched = generation.manager.touch(key) || touched;
    }
    return touched;
  }

  async use<T>(key: string, action: () => Promise<T>): Promise<T> {
    const generation = this.generations().find((item) => item.manager.has(key));
    if (!generation) {
      throw new Error('sandbox is not available');
    }
    return generation.manager.use(key, action);
  }

  markCredentialInjected(key: string): void {
    for (const generation of this.generations()) {
      generation.manager.markCredentialInjected(key);
    }
  }

  size(): number {
    return this.generations().reduce((size, generation) => size + generation.manager.size(), 0);
  }

  list(ctx?: RequestContext): SandboxSummary[] {
    return this.generations().flatMap((generation) => generation.manager.list(ctx));
  }

  async dispose(key: string): Promise<void> {
    await Promise.all(this.generations().map((generation) => generation.manager.dispose(key)));
    await this.cleanupDraining();
  }

  async disposeSession(ctx: RequestContext, sessionId: string): Promise<string[]>;
  async disposeSession(sessionId: string): Promise<string[]>;
  async disposeSession(ctxOrSessionId: RequestContext | string, sessionId?: string): Promise<string[]> {
    const targetSessionId = typeof ctxOrSessionId === 'string' ? ctxOrSessionId : sessionId!;
    const results = await Promise.all(this.generations().map(async (generation) => {
      const sessionKeys = this.sessionKeys(ctxOrSessionId, targetSessionId);
      for (const key of sessionKeys) {
        generation.sessionEpochs.set(key, (generation.sessionEpochs.get(key) ?? 0) + 1);
      }
      await Promise.all([...generation.desktops.entries()]
        .filter(([, desktop]) => desktop.sessionKeys.some((key) => sessionKeys.includes(key)))
        .map(async ([key, desktop]) => {
          generation.desktops.delete(key);
          await this.killDesktop(desktop);
        }));
      return typeof ctxOrSessionId === 'string'
        ? generation.manager.disposeSession(ctxOrSessionId)
        : generation.manager.disposeSession(ctxOrSessionId, sessionId!);
    }));
    await this.cleanupDraining();
    return results.flat();
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const all = this.generations();
    this.current = undefined;
    this.draining.clear();
    await Promise.all(all.map(async (generation) => {
      generation.disposed = true;
      if (generation.sweepTimer) clearInterval(generation.sweepTimer);
      await Promise.resolve()
        .then(() => generation.drainWarmPool?.())
        .catch(() => {});
      await Promise.all([...generation.desktops.values()].map((desktop) => this.killDesktop(desktop)));
      generation.desktops.clear();
      await generation.manager.disposeAll();
      await Promise.resolve()
        .then(() => generation.disposeResources?.())
        .catch(() => {});
    }));
  }

  private createGeneration(input: SandboxGenerationInput): SandboxGeneration {
    const generation: SandboxGeneration = {
      id: ++this.sequence,
      manager: input.manager instanceof SandboxManager ? input.manager : new SandboxManager(input.manager),
      profiles: input.profiles.map((profile) => ({
        ...profile,
        capabilities: [...profile.capabilities],
        ...(profile.envs ? { envs: { ...profile.envs } } : {}),
      })),
      ...(input.catalog ? { catalog: { ...input.catalog } } : {}),
      resolveSpec: input.resolveSpec ?? ((ctx) => ({ key: sandboxIdentityKey(ctx), metadata: sandboxIdentityMetadata(ctx) })),
      drainWarmPool: input.drainWarmPool,
      resolveDesktop: input.resolveDesktop,
      desktops: new Map(),
      operations: 0,
      sessionEpochs: new Map(),
      disposed: false,
      disposeResources: input.disposeResources,
    };
    if (input.sweepMs) {
      generation.sweepTimer = setInterval(() => {
        void generation.manager.sweep()
          .then(async (reclaimedKeys) => {
            await this.evictDesktops(generation, reclaimedKeys);
            await this.cleanupGeneration(generation);
          })
          .catch((err) => log.warn({ generation: generation.id, err: String(err) }, 'sandbox sweep failed'));
      }, input.sweepMs);
      generation.sweepTimer.unref?.();
    }
    return generation;
  }

  private generations(): SandboxGeneration[] {
    return [...(this.current ? [this.current] : []), ...this.draining];
  }

  private async killDesktop(entry: DesktopEntry): Promise<void> {
    entry.killed = true;
    if (!entry.handle) return;
    const handle = entry.handle;
    entry.handle = undefined;
    await handle.kill().catch(() => {});
  }

  private async evictDesktops(generation: SandboxGeneration, keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map(async (key) => {
      const entry = generation.desktops.get(key);
      if (!entry) return;
      generation.desktops.delete(key);
      await this.killDesktop(entry);
    }));
  }

  private pinCurrent(message = 'sandbox runtime is disabled'): SandboxGeneration {
    const generation = this.current;
    if (!generation || this.disposed || generation.disposed) throw new Error(message);
    generation.operations++;
    return generation;
  }

  private async unpin(generation: SandboxGeneration): Promise<void> {
    generation.operations = Math.max(0, generation.operations - 1);
    await this.startDrainIfIdle(generation);
    await this.cleanupDraining();
  }

  private async resolveSpec(
    generation: SandboxGeneration,
    ctx: ToolContext,
    profile?: string,
  ): Promise<SandboxSpec> {
    const partial = await generation.resolveSpec(ctx, profile);
    return {
      key: sandboxIdentityKey(ctx),
      ...partial,
      metadata: {
        ...sandboxIdentityMetadata(ctx),
        ...partial.metadata,
      },
    };
  }

  private sessionKeys(ctxOrSessionId: Pick<ToolContext, 'tenantId' | 'userId'> | string, sessionId: string): string[] {
    if (typeof ctxOrSessionId === 'string') return [`session:${sessionId}`];
    return [`identity:${sandboxIdentityKey({ ...ctxOrSessionId, sessionId })}`];
  }

  private captureSessionEpochs(generation: SandboxGeneration, keys: string[]): Map<string, number> {
    return new Map(keys.map((key) => [key, generation.sessionEpochs.get(key) ?? 0]));
  }

  private operationValid(generation: SandboxGeneration, epochs: Map<string, number>): boolean {
    if (this.disposed || generation.disposed) return false;
    return [...epochs].every(([key, epoch]) => (generation.sessionEpochs.get(key) ?? 0) === epoch);
  }

  private assertOperationValid(generation: SandboxGeneration, epochs: Map<string, number>): void {
    if (!this.operationValid(generation, epochs)) throw new Error('sandbox session is disposed');
  }

  private async startDrainIfIdle(generation: SandboxGeneration): Promise<void> {
    if (!this.draining.has(generation) || generation.operations || generation.cleanupPromise) return;
    if (!generation.drainPromise) {
      generation.manager.beginDrain();
      generation.drainPromise = Promise.resolve()
        .then(() => generation.drainWarmPool?.())
        .then(() => undefined)
        .catch((err) => {
          log.warn({ generation: generation.id, err: String(err) }, 'sandbox warm pool drain failed');
        });
    }
    await generation.drainPromise;
    await this.cleanupGeneration(generation);
  }

  private async cleanupDraining(): Promise<void> {
    await Promise.all([...this.draining].map((generation) => this.cleanupGeneration(generation)));
  }

  private async cleanupGeneration(generation: SandboxGeneration): Promise<void> {
    if (!this.draining.has(generation)) return;
    if (generation.cleanupPromise) {
      await generation.cleanupPromise;
      return;
    }
    const activity = generation.manager.activity() as { active: number; inflight: number; cleanup?: number };
    if (generation.operations || activity.active || activity.inflight || activity.cleanup || generation.desktops.size) return;
    const cleanup = (async () => {
      if (!this.draining.delete(generation)) return;
      generation.disposed = true;
      if (generation.sweepTimer) clearInterval(generation.sweepTimer);
      await Promise.resolve()
        .then(() => generation.disposeResources?.())
        .catch((err) => {
          log.warn({ generation: generation.id, err: String(err) }, 'sandbox generation resource cleanup failed');
        });
    })();
    generation.cleanupPromise = cleanup;
    await cleanup;
  }
}

function abortError(): DOMException {
  return new DOMException('The sandbox acquisition was aborted', 'AbortError');
}

function raceAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
