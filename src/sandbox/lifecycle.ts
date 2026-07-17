import { logger } from '../logger.js';
import type { RequestContext } from '../auth/types.js';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';
import type { WarmPool } from './warmpool.js';

const log = logger.child({ mod: 'sandbox' });

interface Entry {
  handle: SandboxHandle;
  lastUsed: number;
  activeUses: number;
  createdAt: number;
  /** 该沙箱的存活超时(ms)，复用时据此续期。 */
  timeoutMs: number;
  spec: SandboxSpec;
  /** 已注入用户凭据（污染标记）：严禁跨用户复用，只能随会话销毁，不得回池。 */
  credentialInjected?: boolean;
}

interface InflightEntry {
  task: Promise<SandboxHandle>;
  spec: SandboxSpec;
  epoch: number;
}

export interface SandboxSummary {
  id: string;
  sandboxId: string;
  key: string;
  status: 'ready';
  type: string;
  /** 已注入用户凭据（污染标记，销毁不回收）。 */
  credentialInjected?: boolean;
  profile?: string;
  image?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  capabilities?: string[];
  privileged?: boolean;
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  metadata?: Record<string, string>;
}

export interface SandboxManagerLike {
  get(spec: SandboxSpec): Promise<SandboxHandle>;
  has(key: string): boolean;
  touch(key: string): boolean;
  use<T>(key: string, action: () => Promise<T>): Promise<T>;
  markCredentialInjected(key: string): void;
  size(): number;
  list(ctx?: RequestContext): SandboxSummary[];
  dispose(key: string): Promise<void>;
  disposeSession(ctx: RequestContext, sessionId: string): Promise<string[]>;
  disposeSession(sessionId: string): Promise<string[]>;
  disposeAll(): Promise<void>;
}

export interface SandboxManagerOptions {
  provider: SandboxProvider;
  /** 空闲多久(ms)后 GC 回收，默认 10 分钟。 */
  idleMs?: number;
  /** 默认沙箱存活超时(ms)，默认 1 小时。 */
  timeoutMs?: number;
  /** 可注入时钟，便于测试。 */
  now?: () => number;
  /** 可选预热池：新建（非连接远端）时优先从池中取，降低冷启动。 */
  warmPool?: WarmPool;
}

/**
 * 按逻辑键（默认 session×cluster）缓存沙箱：
 * - 首次按 spec 新建或连接远端，之后复用；
 * - 并发 get 同键只创建一次（inflight 去重）；
 * - 空闲超 idleMs 由 sweep() 回收（idle GC）。
 */
export class SandboxManager implements SandboxManagerLike {
  private provider: SandboxProvider;
  private draining = false;
  private disposed = false;
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly warmPool?: WarmPool;

  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, InflightEntry>();
  private inflightActivity = 0;
  private readonly keyEpochs = new Map<string, number>();
  private cleanupActivity = 0;
  private sweepPromise?: Promise<string[]>;
  private disposePromise?: Promise<void>;

  constructor(opts: SandboxManagerOptions) {
    this.provider = opts.provider;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 60 * 60_000;
    this.now = opts.now ?? Date.now;
    this.warmPool = opts.warmPool;
  }

  /** 运行期切换沙箱后端（设置页保存连接配置后生效）：已有沙箱句柄不受影响，新建走新 provider。 */
  setProvider(provider: SandboxProvider): void {
    this.provider = provider;
  }

  beginDrain(): void {
    this.draining = true;
  }

  activity(): { active: number; inflight: number; cleanup: number } {
    return {
      active: this.entries.size,
      inflight: this.inflightActivity
        + [...this.entries.values()].reduce(
          (total, entry) => total + entry.activeUses,
          0,
        ),
      cleanup: this.cleanupActivity,
    };
  }

  /** 取得（必要时创建 / 连接）一个沙箱句柄，并刷新其活跃时间。 */
  async get(spec: SandboxSpec): Promise<SandboxHandle> {
    if (this.disposed) throw new Error('sandbox manager is disposed');
    if (this.draining) throw new Error('sandbox generation is draining');
    const cached = this.entries.get(spec.key);
    if (cached) {
      cached.lastUsed = this.now();
      // 按使用续期：刷新后端存活超时，使"空闲超时"真正按空闲计算（而非创建后固定 TTL）。
      // 不阻塞热路径，失败仅告警——本地 lastUsed 仍驱动 sweep 回收。
      void cached.handle.setTimeout(cached.timeoutMs).catch((err) =>
        log.warn({ key: spec.key, err: String(err) }, 'sandbox renew on reuse failed'),
      );
      return cached.handle;
    }

    const existing = this.inflight.get(spec.key);
    if (existing) return existing.task;

    const effectiveTimeout = spec.timeoutMs ?? this.timeoutMs;
    const full: SandboxSpec = { ...spec, timeoutMs: effectiveTimeout };
    const epoch = this.keyEpochs.get(spec.key) ?? 0;
    this.inflightActivity++;
    const task = (async () => {
      try {
        // 带卷的沙箱不走预热池：卷挂载只能在创建时生效，池中沙箱没有该用户的挂载。
        const handle = full.sandboxId
          ? await this.provider.connect(full.sandboxId, full)
          : this.warmPool && !full.volumes?.length
            ? await this.warmPool.acquire()
            : await this.provider.create(full);
        if (this.disposed || (this.keyEpochs.get(spec.key) ?? 0) !== epoch) {
          await this.kill(handle);
          throw new Error(this.disposed ? 'sandbox manager is disposed' : 'sandbox session is disposed');
        }
        const readyAt = this.now();
        this.entries.set(spec.key, {
          handle,
          lastUsed: readyAt,
          activeUses: 0,
          createdAt: readyAt,
          timeoutMs: effectiveTimeout,
          spec: full,
        });
        log.info({ key: spec.key, sandboxId: handle.sandboxId, mode: full.sandboxId ? 'connect' : 'create' }, 'sandbox ready');
        return handle;
      } finally {
        this.inflightActivity--;
      }
    })();

    const inflight: InflightEntry = { task, spec: full, epoch };
    this.inflight.set(spec.key, inflight);
    try {
      return await task;
    } finally {
      if (this.inflight.get(spec.key) === inflight) this.inflight.delete(spec.key);
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 刷新缓存沙箱的本地活跃时间；用于已缓存 Desktop 的后续浏览器操作。 */
  touch(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.lastUsed = this.now();
    return true;
  }

  /** 在一次外部操作期间固定缓存 entry，避免 idle sweep 回收仍在执行的浏览器命令。 */
  async use<T>(key: string, action: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error('sandbox is not available');
    }
    entry.activeUses++;
    entry.lastUsed = this.now();
    try {
      return await action();
    } finally {
      entry.activeUses = Math.max(0, entry.activeUses - 1);
      if (this.entries.get(key) === entry) {
        entry.lastUsed = this.now();
      }
    }
  }

  /**
   * 标记沙箱已注入用户凭据（污染）：该沙箱与用户绑定，生命周期只能随会话终结（sweep/dispose 即 kill），
   * 永不进入任何复用池。当前实现所有回收路径都是 kill，此标记兜底未来的复用型回收并供运维页展示。
   */
  markCredentialInjected(key: string): void {
    const e = this.entries.get(key);
    if (e && !e.credentialInjected) {
      e.credentialInjected = true;
      log.info({ key }, 'sandbox marked credential-injected (no reuse)');
    }
  }

  size(): number {
    return this.entries.size;
  }

  /** 列出当前活跃沙箱，供运维页面展示会话绑定关系。 */
  list(ctx?: RequestContext): SandboxSummary[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => {
        if (!ctx || ctx.role === 'platform_admin') return true;
        return entry.spec.metadata?.tenantId === ctx.tenantId
          && entry.spec.metadata?.userId === ctx.userId;
      })
      .map(([key, entry]) => {
      const sessionId = entry.spec.metadata?.sessionId ?? key.split(':')[0] ?? key;
      const profile = entry.spec.profile ?? entry.spec.metadata?.profile;
      const capabilities = entry.spec.metadata?.capabilities
        ?.split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return {
        id: entry.handle.sandboxId,
        sandboxId: entry.handle.sandboxId,
        key,
        status: 'ready',
        type: profile ?? entry.spec.template ?? (key.includes(':') ? 'cluster' : 'session'),
        ...(profile ? { profile } : {}),
        ...(entry.spec.template ? { image: entry.spec.template } : {}),
        ...(entry.spec.domain ? { domain: entry.spec.domain } : {}),
        ...(entry.spec.namespace ? { namespace: entry.spec.namespace } : {}),
        ...(entry.spec.serviceAccount ? { serviceAccount: entry.spec.serviceAccount } : {}),
        ...(capabilities?.length ? { capabilities } : {}),
        ...(entry.spec.metadata?.privileged === 'true' ? { privileged: true } : {}),
        ...(entry.credentialInjected ? { credentialInjected: true } : {}),
        sessionId,
        createdAt: new Date(entry.createdAt).toISOString(),
        lastUsedAt: new Date(entry.lastUsed).toISOString(),
        ...(entry.spec.metadata ? { metadata: { ...entry.spec.metadata } } : {}),
      };
    });
  }

  /** 回收空闲超时的沙箱；重叠调用合并到同一次 kill 清理。 */
  sweep(): Promise<string[]> {
    if (!this.sweepPromise) {
      const task = this.runSweep();
      this.sweepPromise = task;
      void task.then(
        () => { if (this.sweepPromise === task) this.sweepPromise = undefined; },
        () => { if (this.sweepPromise === task) this.sweepPromise = undefined; },
      );
    }
    return this.sweepPromise;
  }

  private async runSweep(): Promise<string[]> {
    const cutoff = this.now() - this.idleMs;
    const expired = [...this.entries.entries()].filter(
      ([, entry]) =>
        entry.activeUses === 0
        && entry.lastUsed <= cutoff,
    );
    for (const [key] of expired) this.entries.delete(key);
    await Promise.all(expired.map(async ([key, entry]) => {
      try {
        await this.kill(entry.handle);
      } catch (err) {
        log.warn({ key, err: String(err) }, 'sandbox kill failed during sweep');
      }
      log.info({ key }, 'sandbox reclaimed (idle)');
    }));
    return expired.map(([key]) => key);
  }

  /** 主动销毁某个沙箱；同时使相同 key 的并发创建失效。 */
  async dispose(key: string): Promise<void> {
    this.invalidate(key);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await this.kill(entry.handle);
  }

  /**
   * 销毁某会话名下的全部沙箱（会话关闭时调用）：
   * 默认键 = sessionId，集群键 = `${sessionId}:${cluster}`。单个 kill 失败仅告警，不影响其余。
   */
  async disposeSession(ctx: RequestContext, sessionId: string): Promise<string[]>;
  async disposeSession(sessionId: string): Promise<string[]>;
  async disposeSession(ctxOrSessionId: RequestContext | string, requestedSessionId?: string): Promise<string[]> {
    const ctx = typeof ctxOrSessionId === 'string' ? undefined : ctxOrSessionId;
    const sessionId = typeof ctxOrSessionId === 'string' ? ctxOrSessionId : requestedSessionId!;
    const matches = (spec: SandboxSpec) => {
      if ((spec.metadata?.sessionId ?? spec.key.split(':')[0]) !== sessionId) return false;
      if (!ctx || ctx.role === 'platform_admin') return true;
      return spec.metadata?.tenantId === ctx.tenantId && spec.metadata?.userId === ctx.userId;
    };
    const keys = new Set([
      ...[...this.entries.entries()].filter(([, entry]) => matches(entry.spec)).map(([key]) => key),
      ...[...this.inflight.entries()].filter(([, entry]) => matches(entry.spec)).map(([key]) => key),
    ]);
    await Promise.all(
      [...keys].map((k) =>
        this.dispose(k).catch((err) =>
          log.warn({ key: k, err: String(err) }, 'sandbox dispose (session) failed'),
        ),
      ),
    );
    if (keys.size) log.info({ sessionId, count: keys.size }, 'sandboxes disposed (session closed)');
    return [...keys];
  }

  /** 销毁全部（进程退出时调用）；晚完成的 provider create 会自毁且不写入缓存。 */
  disposeAll(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.runDisposeAll();
    return this.disposePromise;
  }

  private async runDisposeAll(): Promise<void> {
    this.disposed = true;
    this.draining = true;
    for (const key of this.inflight.keys()) this.invalidate(key);
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((entry) => this.kill(entry.handle).catch(() => {})));
  }

  private invalidate(key: string): void {
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
    this.inflight.delete(key);
  }

  private async kill(handle: SandboxHandle): Promise<void> {
    this.cleanupActivity++;
    try {
      await handle.kill();
    } finally {
      this.cleanupActivity--;
    }
  }
}
