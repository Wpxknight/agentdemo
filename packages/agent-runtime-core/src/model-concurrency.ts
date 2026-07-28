import type {
  ModelConcurrencyController,
  ModelConcurrencyInput,
} from './kernel.js';

export interface FifoModelConcurrencyControllerOptions {
  maxConcurrentPerTenantModel?: number;
}

export class FifoModelConcurrencyController implements ModelConcurrencyController {
  private readonly semaphores = new Map<string, FifoSemaphore>();
  private readonly limit: number;

  constructor(options: FifoModelConcurrencyControllerOptions = {}) {
    this.limit = positiveLimit(options.maxConcurrentPerTenantModel ?? 4);
  }

  async acquire(input: ModelConcurrencyInput): Promise<() => void> {
    const key = JSON.stringify([
      input.identity.tenantId,
      input.model.provider,
      input.model.model,
      input.model.route ?? '',
    ]);
    const semaphore = this.semaphores.get(key) ?? new FifoSemaphore(this.limit);
    this.semaphores.set(key, semaphore);
    const release = await semaphore.acquire(input.signal);
    return () => {
      release();
      if (semaphore.idle) this.semaphores.delete(key);
    };
  }
}

class FifoSemaphore {
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
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError(signal));
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
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      this.active++;
      waiter.resolve(this.releaseOnce());
    }
  }
}

function positiveLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Model concurrency limit must be a positive integer: ${value}`);
  }
  return value;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error(typeof signal?.reason === 'string' && signal.reason ? signal.reason : 'Model call aborted');
}
