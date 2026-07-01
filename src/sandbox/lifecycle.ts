import { logger } from '../logger.js';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';
import type { WarmPool } from './warmpool.js';

const log = logger.child({ mod: 'sandbox' });

interface Entry {
  handle: SandboxHandle;
  lastUsed: number;
  createdAt: number;
  /** 该沙箱的存活超时(ms)，复用时据此续期。 */
  timeoutMs: number;
  spec: SandboxSpec;
}

export interface SandboxSummary {
  id: string;
  sandboxId: string;
  key: string;
  status: 'ready';
  type: string;
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  metadata?: Record<string, string>;
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
export class SandboxManager {
  private readonly provider: SandboxProvider;
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly warmPool?: WarmPool;

  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<SandboxHandle>>();

  constructor(opts: SandboxManagerOptions) {
    this.provider = opts.provider;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 60 * 60_000;
    this.now = opts.now ?? Date.now;
    this.warmPool = opts.warmPool;
  }

  /** 取得（必要时创建 / 连接）一个沙箱句柄，并刷新其活跃时间。 */
  async get(spec: SandboxSpec): Promise<SandboxHandle> {
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
    if (existing) return existing;

    const effectiveTimeout = spec.timeoutMs ?? this.timeoutMs;
    const full: SandboxSpec = { ...spec, timeoutMs: effectiveTimeout };
    const task = (async () => {
      const handle = full.sandboxId
        ? await this.provider.connect(full.sandboxId, full)
        : this.warmPool
          ? await this.warmPool.acquire()
          : await this.provider.create(full);
      const readyAt = this.now();
      this.entries.set(spec.key, {
        handle,
        lastUsed: readyAt,
        createdAt: readyAt,
        timeoutMs: effectiveTimeout,
        spec: full,
      });
      log.info({ key: spec.key, sandboxId: handle.sandboxId, mode: full.sandboxId ? 'connect' : 'create' }, 'sandbox ready');
      return handle;
    })();

    this.inflight.set(spec.key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(spec.key);
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  size(): number {
    return this.entries.size;
  }

  /** 列出当前活跃沙箱，供运维页面展示会话绑定关系。 */
  list(): SandboxSummary[] {
    return [...this.entries.entries()].map(([key, entry]) => {
      const sessionId = entry.spec.metadata?.sessionId ?? key.split(':')[0] ?? key;
      return {
        id: entry.handle.sandboxId,
        sandboxId: entry.handle.sandboxId,
        key,
        status: 'ready',
        type: entry.spec.template ?? (key.includes(':') ? 'cluster' : 'session'),
        sessionId,
        createdAt: new Date(entry.createdAt).toISOString(),
        lastUsedAt: new Date(entry.lastUsed).toISOString(),
        ...(entry.spec.metadata ? { metadata: { ...entry.spec.metadata } } : {}),
      };
    });
  }

  /** 回收空闲超时的沙箱；返回被回收的键。 */
  async sweep(): Promise<string[]> {
    const cutoff = this.now() - this.idleMs;
    const expired = [...this.entries.entries()].filter(([, e]) => e.lastUsed <= cutoff);
    await Promise.all(
      expired.map(async ([key, e]) => {
        this.entries.delete(key);
        try {
          await e.handle.kill();
        } catch (err) {
          log.warn({ key, err: String(err) }, 'sandbox kill failed during sweep');
        }
        log.info({ key }, 'sandbox reclaimed (idle)');
      }),
    );
    return expired.map(([key]) => key);
  }

  /** 主动销毁某个沙箱。 */
  async dispose(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    await e.handle.kill();
  }

  /**
   * 销毁某会话名下的全部沙箱（会话关闭时调用）：
   * 默认键 = sessionId，集群键 = `${sessionId}:${cluster}`。单个 kill 失败仅告警，不影响其余。
   */
  async disposeSession(sessionId: string): Promise<string[]> {
    const prefix = `${sessionId}:`;
    const keys = [...this.entries.keys()].filter((k) => k === sessionId || k.startsWith(prefix));
    await Promise.all(
      keys.map((k) =>
        this.dispose(k).catch((err) =>
          log.warn({ key: k, err: String(err) }, 'sandbox dispose (session) failed'),
        ),
      ),
    );
    if (keys.length) log.info({ sessionId, count: keys.length }, 'sandboxes disposed (session closed)');
    return keys;
  }

  /** 销毁全部（进程退出时调用）。 */
  async disposeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.handle.kill().catch(() => {})));
  }
}
