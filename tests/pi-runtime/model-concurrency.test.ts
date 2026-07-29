import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, type Models } from '@earendil-works/pi-ai';
import {
  FifoModelConcurrencyController,
  createConcurrentModels,
} from '@aiop/pi-runtime';

const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] };
const model = {
  id: 'model-a', name: 'Model A', api: 'openai-completions', provider: 'provider-a', baseUrl: 'http://model',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000, maxTokens: 100,
} as const;

function completedStream(text: string) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({
    type: 'done', reason: 'stop',
    message: {
      role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now(),
      api: model.api, provider: model.provider, model: text, stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  }));
  return stream;
}

describe('FifoModelConcurrencyController', () => {
  it('queues the same tenant/model in FIFO order while allowing another model', async () => {
    const controller = new FifoModelConcurrencyController({ maxConcurrentPerTenantModel: 1 });
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const base = {
      streamSimple: vi.fn((requestedModel: Parameters<Models['streamSimple']>[0]) => {
        started.push(requestedModel.id);
        if (started.length === 1) {
          const stream = createAssistantMessageEventStream();
          void firstGate.then(() => stream.push({
            type: 'done', reason: 'stop', message: {
              role: 'assistant', content: [{ type: 'text', text: 'first' }], timestamp: Date.now(),
              api: model.api, provider: model.provider, model: requestedModel.id, stopReason: 'stop',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            },
          }));
          return stream;
        }
        return completedStream(requestedModel.id);
      }),
    } as unknown as Models;
    const models = createConcurrentModels(base, controller, identity);
    const first = models.streamSimple(model as never, { systemPrompt: '', messages: [], tools: [] });
    const queued = models.streamSimple(model as never, { systemPrompt: '', messages: [], tools: [] });
    const other = models.streamSimple({ ...model, id: 'model-b' } as never, { systemPrompt: '', messages: [], tools: [] });

    await expect(other.result()).resolves.toMatchObject({ model: 'model-b' });
    expect(started).toEqual(['model-a', 'model-b']);
    releaseFirst();
    await expect(Promise.all([first.result(), queued.result()])).resolves.toHaveLength(2);
    expect(started).toEqual(['model-a', 'model-b', 'model-a']);
  });

  it('uses the bound model route to isolate otherwise identical model queues', async () => {
    const controller = new FifoModelConcurrencyController({ maxConcurrentPerTenantModel: 1 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const base = {
      streamSimple: vi.fn((requestedModel: Parameters<Models['streamSimple']>[0]) => {
        if (requestedModel.baseUrl === 'http://route-a') {
          const stream = createAssistantMessageEventStream();
          void firstGate.then(() => stream.push({
            type: 'done', reason: 'stop', message: {
              role: 'assistant', content: [], timestamp: Date.now(), api: model.api,
              provider: model.provider, model: requestedModel.id, stopReason: 'stop',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            },
          }));
          return stream;
        }
        return completedStream(requestedModel.baseUrl);
      }),
    } as unknown as Models;
    const models = createConcurrentModels(base, controller, identity);
    const first = models.streamSimple({ ...model, baseUrl: 'http://route-a' } as never,
      { systemPrompt: '', messages: [], tools: [] });
    const otherRoute = models.streamSimple({ ...model, baseUrl: 'http://route-b' } as never,
      { systemPrompt: '', messages: [], tools: [] });

    await expect(otherRoute.result()).resolves.toMatchObject({ model: 'http://route-b' });
    releaseFirst();
    await expect(first.result()).resolves.toMatchObject({ model: 'model-a' });
  });

  it('releases a permit after a provider failure', async () => {
    const controller = new FifoModelConcurrencyController({ maxConcurrentPerTenantModel: 1 });
    const firstRelease = await controller.acquire({ identity, model: { provider: 'p', model: 'm' } });
    const queued = controller.acquire({ identity, model: { provider: 'p', model: 'm' } });
    firstRelease();
    const secondRelease = await queued;
    secondRelease();
    await expect(controller.acquire({ identity, model: { provider: 'p', model: 'm' } })).resolves.toBeTypeOf('function');
  });

  it('removes an aborted waiter without consuming the next permit', async () => {
    const controller = new FifoModelConcurrencyController({ maxConcurrentPerTenantModel: 1 });
    const release = await controller.acquire({ identity, model: { provider: 'p', model: 'm' } });
    const abort = new AbortController();
    const cancelled = controller.acquire({ identity, model: { provider: 'p', model: 'm' }, signal: abort.signal });
    abort.abort(new Error('queued model call cancelled'));
    await expect(cancelled).rejects.toThrow('queued model call cancelled');
    release();
    const next = await controller.acquire({ identity, model: { provider: 'p', model: 'm' } });
    next();
  });
});
