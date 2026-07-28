import { describe, expect, it } from 'vitest';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import {
  PiAgentSessionFactory,
  bridgeGovernedTools,
  compactPiCompaction,
  preparePiCompaction,
} from '../../packages/pi-runtime/src/index.js';

function eventContext(runId: string) {
  let sequence = 0n;
  return {
    tenantId: 'tenant-1', runId, attemptId: 'attempt-1', turnNo: 1,
    correlationId: `correlation-${runId}`, sequence: () => ++sequence,
    now: () => new Date('2026-07-28T00:00:00.000Z'),
  };
}

const model: Model<'pi-runtime-test'> = {
  id: 'pi-runtime-test', name: 'Pi Runtime Test', api: 'pi-runtime-test', provider: 'pi-runtime-test', baseUrl: '',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096, maxTokens: 256,
};

function testModels() {
  const models = createModels();
  const contexts: Context[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const stream = (_model: Model<'pi-runtime-test'>, context: Context) => {
    contexts.push(structuredClone(context));
    const output = createAssistantMessageEventStream();
    void (async () => {
      if (calls++ === 0) await gate;
      const message: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: `answer-${calls}` }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now(),
      };
      output.push({ type: 'start', partial: { ...message, content: [] } });
      output.push({ type: 'done', reason: 'stop', message });
    })();
    return output;
  };
  models.setProvider(createProvider({
    id: model.provider,
    auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
    models: [model], api: { stream, streamSimple: stream },
  }));
  return { models, contexts, release: () => release?.() };
}

describe('PiAgentSessionFactory', () => {
  it('does not start a prompt when continue receives an already-aborted signal', async () => {
    const repository = new InMemorySessionRepo();
    const controlled = testModels();
    const factory = new PiAgentSessionFactory({ repository, models: controlled.models, model });
    const session = await factory.create({ id: 'session-aborted', initialMessage: { role: 'user', text: 'start' }, events: eventContext('run-aborted') });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(collect(session.continue(controller.signal))).rejects.toThrow('cancelled');
    expect(controlled.contexts).toHaveLength(0);
    await session.close();
  });

  it('creates and loads real Pi sessions and streams real Harness events', async () => {
    const repository = new InMemorySessionRepo();
    const controlled = testModels();
    const factory = new PiAgentSessionFactory({ repository, models: controlled.models, model });
    const session = await factory.create({ id: 'session-1', initialMessage: { role: 'user', text: 'start' }, events: eventContext('run-1') });

    const eventsPromise = collect(session.continue());
    await Promise.resolve();
    await session.steer({ role: 'user', text: 'steer now' });
    await session.followUp({ role: 'user', text: 'follow later' });
    controlled.release();
    const events = await eventsPromise;

    expect(events.some((event) => event.type === 'agent_start')).toBe(true);
    expect(events.some((event) => event.type === 'message_end')).toBe(true);
    expect(events.every((event) => event.runId === 'run-1' && event.kernel === 'pi')).toBe(true);
    expect(() => JSON.stringify(events.map((event) => event.detail))).not.toThrow();
    expect(controlled.contexts).toHaveLength(2);
    expect(JSON.stringify(controlled.contexts)).toContain('steer now');
    expect(JSON.stringify(controlled.contexts)).toContain('follow later');
    const metadata = await session.metadata();
    await session.close();

    const loaded = await factory.load({ metadata, initialMessage: { role: 'user', text: 'loaded' }, events: eventContext('run-loaded') });
    expect((await loaded.entries()).some((entry) => entry.type === 'message')).toBe(true);
    await loaded.close();
  });

  it('adapts governed tools through setTools and Pi validation/execution', async () => {
    const repository = new InMemorySessionRepo();
    const controlled = testModels();
    const factory = new PiAgentSessionFactory({ repository, models: controlled.models, model });
    const session = await factory.create({ id: 'session-tools', initialMessage: { role: 'user', text: 'start' }, events: eventContext('run-tools') });
    const calls: unknown[] = [];
    const tools = bridgeGovernedTools([{
      definition: { name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' }, capability: 'read' },
      execute: async (call) => {
        calls.push(call);
        return { callId: call.id, content: 'ok' };
      },
    }]);
    await session.setTools(tools);
    expect(session.tools().map((tool) => tool.name)).toEqual(['lookup']);
    const result = await tools[0]!.execute('call-1', { key: 'value' }, undefined, undefined, undefined);
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls).toEqual([{ id: 'call-1', logicalCallId: 'call-1', name: 'lookup', arguments: { key: 'value' } }]);
    await session.close();
  });

  it('starts lazily, consumes pending input once, and rejects concurrent continue', async () => {
    const repository = new InMemorySessionRepo();
    const controlled = testModels();
    const factory = new PiAgentSessionFactory({ repository, models: controlled.models, model });
    const session = await factory.create({ id: 'session-lifecycle', initialMessage: { role: 'user', text: 'start' }, events: eventContext('run-lifecycle') });
    const iterable = session.continue();
    await Promise.resolve();
    expect(controlled.contexts).toHaveLength(0);
    const iterator = iterable[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();
    await expect(collect(session.continue())).rejects.toThrow(/active|busy/i);
    controlled.release();
    await first;
    while (!(await iterator.next()).done) { /* drain */ }
    await expect(collect(session.continue())).rejects.toThrow(/pending input/i);
    await session.close();
  });

  it('does not start an iterable that is never consumed', async () => {
    const controlled = testModels();
    const session = await new PiAgentSessionFactory({ repository: new InMemorySessionRepo(), models: controlled.models, model })
      .create({ id: 'never-consumed', initialMessage: { role: 'user', text: 'start' }, events: eventContext('never-consumed') });
    session.continue();
    await Promise.resolve();
    expect(controlled.contexts).toHaveLength(0);
    await session.close();
  });

  it('aborts and closes active runs and cleans up an iterator returned early', async () => {
    for (const action of ['abort', 'close', 'return'] as const) {
      const controlled = testModels();
      const session = await new PiAgentSessionFactory({ repository: new InMemorySessionRepo(), models: controlled.models, model })
        .create({ id: `active-${action}`, initialMessage: { role: 'user', text: 'start' }, events: eventContext(`active-${action}`) });
      const iterator = session.continue()[Symbol.asyncIterator]();
      const collected = [await iterator.next()];
      const operation = action === 'abort' ? session.abort()
        : action === 'close' ? session.close()
          : iterator.return?.();
      controlled.release();
      await operation;
      if (action !== 'return') {
        let next;
        do { next = await iterator.next(); collected.push(next); } while (!next.done);
      }
      if (action === 'abort') expect(collected.some(({ value }) => value?.type === 'abort')).toBe(true);
      await session.close();
    }
  });

  it('uses Pi compaction preparation and does not import low-level loops', async () => {
    const prepared = preparePiCompaction([
      { role: 'user', content: 'one', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }], api: model.api,
        provider: model.provider, model: model.id,
        usage: { input: 500, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 2 },
      { role: 'user', content: 'three', timestamp: 3 },
    ], { enabled: true, reserveTokens: 64, keepRecentTokens: 1 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.value) throw new Error('expected Pi compaction preparation');
    expect(prepared.value.messagesToSummarize.length).toBeGreaterThan(0);
    expect(prepared.value.retainedTail.length).toBeGreaterThan(0);
    const controlled = testModels();
    controlled.release();
    const compacted = await compactPiCompaction(prepared.value, controlled.models, model);
    expect(compacted.ok).toBe(true);
    if (compacted.ok) expect(compacted.value.summary).toContain('answer-1');

    const source = await import('node:fs/promises').then(({ readFile }) => readFile(
      new URL('../../packages/pi-runtime/src/pi/agent.ts', import.meta.url), 'utf8',
    ));
    expect(source).not.toMatch(/\bagentLoop(?:Continue)?\b/);
  });

  it('propagates active AbortSignal cancellation through the iterable lifecycle', async () => {
    const controlled = testModels();
    const session = await new PiAgentSessionFactory({ repository: new InMemorySessionRepo(), models: controlled.models, model })
      .create({ id: 'signal-active', initialMessage: { role: 'user', text: 'start' }, events: eventContext('signal-active') });
    const controller = new AbortController();
    const collected = collect(session.continue(controller.signal));
    await Promise.resolve();
    controller.abort(new Error('signal cancelled'));
    controlled.release();
    await expect(collected).rejects.toThrow('signal cancelled');
    await session.close();
  });
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
