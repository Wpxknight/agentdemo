import { logger } from './logger.js';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';

const log = logger.child({ mod: 'warmpool' });

export interface WarmPoolOptions {
  provider: SandboxProvider;
  /** 预热使用的基础规格（template/domain 等；key 仅占位）。 */
  spec: Omit<SandboxSpec, 'key'>;
  /** 池容量（预热的空闲沙箱数）。 */
  size: number;
  /** drain 等待并发补位的最长时间，默认 5 秒。 */
  drainTimeoutMs?: number;
  /** 可注入等待函数，便于确定性测试。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 预热池：预先创建若干沙箱，acquire() 立即返回一个并异步补位，
 * 降低冷启动延迟。SandboxManager 创建新沙箱时可优先从池中取。
 */
export class WarmPool {
  private readonly provider: SandboxProvider;
  private readonly baseSpec: Omit<SandboxSpec, 'key'>;
  private readonly size: number;
  private readonly drainTimeoutMs: number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private ready: SandboxHandle[] = [];
  private refillPromise?: Promise<void>;
  private drainPromise?: Promise<void>;
  private closed = false;

  constructor(opts: WarmPoolOptions) {
    this.provider = opts.provider;
    this.baseSpec = opts.spec;
    this.size = opts.size;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 5_000;
    this.sleep = opts.sleep;
  }

  /** 预热到容量。 */
  async start(): Promise<void> {
    await this.scheduleRefill();
  }

  available(): number {
    return this.ready.length;
  }

  /** 取一个预热沙箱（无则即时创建）；取后异步补位。 */
  async acquire(): Promise<SandboxHandle> {
    if (this.closed) throw new Error('warm pool is drained');
    const pooled = this.ready.pop();
    const handle = pooled ?? (await this.create());
    if (this.closed) {
      await handle.kill().catch(() => {});
      throw new Error('warm pool is drained');
    }
    this.scheduleRefill();
    return handle;
  }

  private async create(): Promise<SandboxHandle> {
    return this.provider.create({ key: 'warm', ...this.baseSpec });
  }

  private scheduleRefill(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.refillPromise) {
      const task = this.refill();
      this.refillPromise = task;
      const clear = () => {
        if (this.refillPromise === task) this.refillPromise = undefined;
      };
      void task.then(clear, clear);
    }
    return this.refillPromise;
  }

  private async refill(): Promise<void> {
    while (!this.closed && this.ready.length < this.size) {
      try {
        const handle = await this.create();
        if (this.closed) await handle.kill().catch(() => {});
        else this.ready.push(handle);
      } catch (err) {
        if (!this.closed) log.warn({ err: String(err) }, 'warm pool refill failed');
        break;
      }
    }
  }

  /** 关闭并销毁池中空闲沙箱；并发补位仅有界等待，晚到 handle 由 refill 自毁。 */
  drain(): Promise<void> {
    if (!this.drainPromise) this.drainPromise = this.runDrain();
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    this.closed = true;

    const all = this.ready;
    this.ready = [];
    await Promise.all(all.map((h) => h.kill().catch(() => {})));

    const refill = this.refillPromise;
    if (!refill) return;

    let timedOut = false;
    if (this.sleep) {
      await Promise.race([
        refill.catch(() => {}),
        this.sleep(this.drainTimeoutMs).then(() => { timedOut = true; }),
      ]);
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          refill.catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, this.drainTimeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (timedOut) {
      log.warn({ timeoutMs: this.drainTimeoutMs }, 'warm pool drain timed out waiting for refill');
    }
  }
}
