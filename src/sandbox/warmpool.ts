import { logger } from '../logger.js';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';

const log = logger.child({ mod: 'warmpool' });

export interface WarmPoolOptions {
  provider: SandboxProvider;
  /** 预热使用的基础规格（template/domain 等；key 仅占位）。 */
  spec: Omit<SandboxSpec, 'key'>;
  /** 池容量（预热的空闲沙箱数）。 */
  size: number;
}

/**
 * 预热池：预先创建若干沙箱，acquire() 立即返回一个并异步补位，
 * 降低冷启动延迟。SandboxManager 创建新沙箱时可优先从池中取。
 */
export class WarmPool {
  private readonly provider: SandboxProvider;
  private readonly baseSpec: Omit<SandboxSpec, 'key'>;
  private readonly size: number;
  private ready: SandboxHandle[] = [];
  private filling = 0;

  constructor(opts: WarmPoolOptions) {
    this.provider = opts.provider;
    this.baseSpec = opts.spec;
    this.size = opts.size;
  }

  /** 预热到容量。 */
  async start(): Promise<void> {
    await this.refill();
  }

  available(): number {
    return this.ready.length;
  }

  /** 取一个预热沙箱（无则即时创建）；取后异步补位。 */
  async acquire(): Promise<SandboxHandle> {
    const handle = this.ready.pop() ?? (await this.create());
    void this.refill();
    return handle;
  }

  private async create(): Promise<SandboxHandle> {
    return this.provider.create({ key: 'warm', ...this.baseSpec });
  }

  private async refill(): Promise<void> {
    while (this.ready.length + this.filling < this.size) {
      this.filling++;
      try {
        const h = await this.create();
        this.ready.push(h);
      } catch (err) {
        log.warn({ err: String(err) }, 'warm pool refill failed');
      } finally {
        this.filling--;
      }
    }
  }

  /** 销毁池中所有空闲沙箱。 */
  async drain(): Promise<void> {
    const all = this.ready;
    this.ready = [];
    await Promise.all(all.map((h) => h.kill().catch(() => {})));
  }
}
