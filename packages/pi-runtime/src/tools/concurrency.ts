export interface ResourceConcurrency {
  run<T>(input: { tenantId: string; resourceKey?: string; signal?: AbortSignal }, work: () => Promise<T>): Promise<T>;
}

export class ResourceConcurrencyController implements ResourceConcurrency {
  private readonly tenants = new Map<string, Map<string, ResourceSemaphore>>();

  constructor(private readonly maxConcurrentPerResource = 1) {
    if (!Number.isInteger(maxConcurrentPerResource) || maxConcurrentPerResource < 1) {
      throw new Error(`Resource concurrency limit must be a positive integer: ${maxConcurrentPerResource}`);
    }
  }

  async run<T>(
    input: { tenantId: string; resourceKey?: string; signal?: AbortSignal },
    work: () => Promise<T>,
  ): Promise<T> {
    throwIfAborted(input.signal);
    if (!input.resourceKey) return work();
    const resources = this.tenants.get(input.tenantId) ?? new Map<string, ResourceSemaphore>();
    this.tenants.set(input.tenantId, resources);
    const semaphore = resources.get(input.resourceKey) ?? new ResourceSemaphore(this.maxConcurrentPerResource);
    resources.set(input.resourceKey, semaphore);
    const release = await semaphore.acquire(input.signal);
    try {
      throwIfAborted(input.signal);
      return await work();
    } finally {
      release();
      if (semaphore.idle) resources.delete(input.resourceKey);
      if (resources.size === 0) this.tenants.delete(input.tenantId);
    }
  }
}

class ResourceSemaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.queue)[number] = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(abortReason(signal!));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      let next = this.queue.shift();
      while (next?.signal?.aborted) {
        next.signal.removeEventListener('abort', next.onAbort!);
        next.reject(abortReason(next.signal));
        next = this.queue.shift();
      }
      if (!next) {
        this.active--;
        return;
      }
      next.signal?.removeEventListener('abort', next.onAbort!);
      next.resolve(this.releaseOnce());
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('resource wait aborted');
}
