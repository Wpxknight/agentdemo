export interface ResourceConcurrency {
  run<T>(input: { tenantId: string; resourceKey?: string }, work: () => Promise<T>): Promise<T>;
}

export class ResourceConcurrencyController implements ResourceConcurrency {
  private readonly resources = new Map<string, ResourceSemaphore>();

  constructor(private readonly maxConcurrentPerResource = 1) {
    if (!Number.isInteger(maxConcurrentPerResource) || maxConcurrentPerResource < 1) {
      throw new Error(`Resource concurrency limit must be a positive integer: ${maxConcurrentPerResource}`);
    }
  }

  async run<T>(input: { tenantId: string; resourceKey?: string }, work: () => Promise<T>): Promise<T> {
    if (!input.resourceKey) return work();
    const key = `${input.tenantId}:${input.resourceKey}`;
    const semaphore = this.resources.get(key) ?? new ResourceSemaphore(this.maxConcurrentPerResource);
    this.resources.set(key, semaphore);
    const release = await semaphore.acquire();
    try {
      return await work();
    } finally {
      release();
      if (semaphore.idle) this.resources.delete(key);
    }
  }
}

class ResourceSemaphore {
  private active = 0;
  private readonly queue: Array<(release: () => void) => void> = [];

  constructor(private readonly limit: number) {}

  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(this.releaseOnce());
      else this.active--;
    };
  }
}
