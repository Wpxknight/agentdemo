import { logger } from '../logger.js';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';

const log = logger.child({ mod: 'sandbox' });

interface Entry {
  handle: SandboxHandle;
  lastUsed: number;
}

export interface SandboxManagerOptions {
  provider: SandboxProvider;
  /** 空闲多久(ms)后 GC 回收，默认 10 分钟。 */
  idleMs?: number;
  /** 默认沙箱存活超时(ms)，默认 1 小时。 */
  timeoutMs?: number;
  /** 可注入时钟，便于测试。 */
  now?: () => number;
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

  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<SandboxHandle>>();

  constructor(opts: SandboxManagerOptions) {
    this.provider = opts.provider;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** 取得（必要时创建 / 连接）一个沙箱句柄，并刷新其活跃时间。 */
  async get(spec: SandboxSpec): Promise<SandboxHandle> {
    const cached = this.entries.get(spec.key);
    if (cached) {
      cached.lastUsed = this.now();
      return cached.handle;
    }

    const existing = this.inflight.get(spec.key);
    if (existing) return existing;

    const full: SandboxSpec = { timeoutMs: this.timeoutMs, ...spec };
    const task = (async () => {
      const handle = full.sandboxId
        ? await this.provider.connect(full.sandboxId, full)
        : await this.provider.create(full);
      this.entries.set(spec.key, { handle, lastUsed: this.now() });
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

  /** 销毁全部（进程退出时调用）。 */
  async disposeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.handle.kill().catch(() => {})));
  }
}
