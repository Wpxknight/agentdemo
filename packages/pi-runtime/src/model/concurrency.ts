import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type ModelsSimpleStreamOptions,
  type Context,
} from '@earendil-works/pi-ai';
import type { IdentityContext } from '@aiop/control-contracts';

export interface ModelConcurrencyInput {
  identity: IdentityContext;
  model: { provider: string; model: string; route?: string };
  signal?: AbortSignal;
}

export interface ModelConcurrencyController {
  acquire(input: ModelConcurrencyInput): Promise<() => void>;
}

export interface FifoModelConcurrencyControllerOptions {
  maxConcurrentPerTenantModel?: number;
}

export class FifoModelConcurrencyController implements ModelConcurrencyController {
  private readonly semaphores = new Map<string, FifoSemaphore>();
  private readonly limit: number;

  constructor(options: FifoModelConcurrencyControllerOptions = {}) {
    this.limit = positiveLimit(options.maxConcurrentPerTenantModel ?? 4);
  }

  /** Diagnostic count used to verify semaphore lifecycle without exposing queue contents. */
  get activeKeyCount(): number {
    return this.semaphores.size;
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
    let release: () => void;
    try {
      release = await semaphore.acquire(input.signal);
    } catch (error) {
      if (semaphore.idle && this.semaphores.get(key) === semaphore) this.semaphores.delete(key);
      throw error;
    }
    return () => {
      release();
      if (semaphore.idle && this.semaphores.get(key) === semaphore) this.semaphores.delete(key);
    };
  }
}

export function createConcurrentModels(
  models: Models,
  controller: ModelConcurrencyController,
  identity: IdentityContext,
): Models {
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === 'streamSimple') {
        return (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => {
          const output = createAssistantMessageEventStream();
          void pumpConcurrentStream(output, target, controller, identity, model, context, options);
          return output;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function pumpConcurrentStream(
  output: ReturnType<typeof createAssistantMessageEventStream>,
  models: Models,
  controller: ModelConcurrencyController,
  identity: IdentityContext,
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    release = await controller.acquire({
      identity,
      model: { provider: model.provider, model: model.id, route: model.baseUrl },
      signal: options?.signal,
    });
    const source = models.streamSimple(model, context, options);
    for await (const event of source) output.push(event);
  } catch (error) {
    const aborted = options?.signal?.aborted === true;
    const message = errorMessage(model, error, aborted);
    output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
  } finally {
    release?.();
  }
}

function errorMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
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
