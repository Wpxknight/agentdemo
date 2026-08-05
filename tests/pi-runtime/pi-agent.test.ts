import { describe, expect, it } from 'vitest';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import { AgentHarness, InMemorySessionRepo, InMemorySessionStorage, Session } from '@earendil-works/pi-agent-core';
import {
  EventCodec,
  PiAgentSession,
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
  it('resolves governed tools from the durable run identity when creating a session', async () => {
    const repository = new InMemorySessionRepo();
    const controlled = testModels();
    const seen: unknown[] = [];
    const factory = new PiAgentSessionFactory({
      repository, models: controlled.models, model,
      resolveTools: async (input) => {
        seen.push(input.identity);
        return bridgeGovernedTools([{
          definition: { name: 'tenant_tool', description: 'tenant', inputSchema: {}, capability: 'read' },
          execute: async (call) => ({ callId: call.id, content: input.identity?.tenantId ?? 'missing' }),
        }]);
      },
    });
    const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
    const session = await factory.create({
      id: 'identity-tools', identity,
      initialMessage: { role: 'user', text: 'start' }, events: eventContext('run-identity-tools'),
    });

    expect(session.tools().map((tool) => tool.name)).toEqual(['tenant_tool']);
    expect(seen).toEqual([identity]);
    await session.close();
  });

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

  it('removes legacy browser preview data URLs from provider context when loading a session', async () => {
    const repository = new InMemorySessionRepo();
    const stored = await repository.create({ id: 'legacy-browser-preview' });
    await stored.appendMessage({ role: 'user', content: '打开浏览器', timestamp: 1 });
    await stored.appendMessage({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id: 'call-preview', name: 'desktop_stream_url', arguments: {} }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: 2,
    });
    await stored.appendMessage({
      role: 'toolResult', toolCallId: 'call-preview', toolName: 'desktop_stream_url',
      content: [{ type: 'text', text: `浏览器预览地址：data:text/html;charset=utf-8,${'preview'.repeat(20_000)}` }],
      isError: false, timestamp: 3,
    });
    const controlled = testModels();
    const loaded = await new PiAgentSessionFactory({ repository, models: controlled.models, model }).load({
      metadata: await stored.getMetadata(),
      initialMessage: { role: 'user', text: '继续' },
      events: eventContext('legacy-browser-preview'),
    });

    const events = collect(loaded.continue());
    controlled.release();
    await events;

    const providerContext = JSON.stringify(controlled.contexts[0]);
    expect(providerContext).not.toContain('data:text/html');
    expect(providerContext).toContain('浏览器预览已加载到右侧沙箱栏');
    await loaded.close();
  });

  it('flushes sequential inbox markers through real Harness safe-point events before finalization', async () => {
    const base = new InMemorySessionStorage({ metadata: { id: 'serialized', createdAt: new Date().toISOString() } });
    await base.appendEntry({
      type: 'message', id: 'root', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'start', timestamp: Date.now() },
    });
    let assistantPaused!: () => void;
    const paused = new Promise<void>((resolve) => { assistantPaused = resolve; });
    let releaseAssistant!: () => void;
    const assistantGate = new Promise<void>((resolve) => { releaseAssistant = resolve; });
    const storage = new Proxy(base, {
      get(target, property) {
        if (property === 'appendEntry') return async (entry: Parameters<typeof base.appendEntry>[0]) => {
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            assistantPaused();
            await assistantGate;
          }
          return base.appendEntry(entry);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const piSession = new Session(storage);
    const controlled = testModels();
    const harness = new AgentHarness({ session: piSession, models: controlled.models, model, tools: [] });
    const session = new PiAgentSession(
      piSession, harness, { role: 'user', text: 'start' }, new EventCodec(eventContext('serialized')),
    );

    const iterator = session.continue()[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    let markersCompleted = false;
    const markers = (async () => {
      await session.appendCustomEntry('aiop.inbox_consumed', { inboxMessageId: 'inbox-a' });
      await session.appendCustomEntry('aiop.inbox_consumed', { inboxMessageId: 'inbox-b' });
      markersCompleted = true;
    })();
    controlled.release();
    await paused;
    releaseAssistant();

    let sawSettled = false;
    while (!sawSettled) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      sawSettled = next.value!.type === 'settled';
    }
    await Promise.resolve();
    const completedBeforeFinalize = markersCompleted;
    while (!(await iterator.next()).done) { /* finalize */ }
    await markers;

    const leaf = await session.leafId();
    const path = await base.getPathToRootOrCompaction(leaf);
    await session.close();

    expect(completedBeforeFinalize).toBe(true);
    expect(path.filter((entry) => entry.type === 'custom').map((entry) => entry.data))
      .toEqual([{ inboxMessageId: 'inbox-a' }, { inboxMessageId: 'inbox-b' }]);
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

  it('finalizes an abandoned yielded iterator and makes concurrent close idempotent', async () => {
    const controlled = testModels();
    const session = await new PiAgentSessionFactory({ repository: new InMemorySessionRepo(), models: controlled.models, model })
      .create({ id: 'abandoned', initialMessage: { role: 'user', text: 'start' }, events: eventContext('abandoned') });
    const iterable = session.continue();
    const iterator = iterable[Symbol.asyncIterator]();
    await iterator.next();
    const firstClose = session.close();
    const secondClose = session.close();
    controlled.release();
    await Promise.race([Promise.all([firstClose, secondClose]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 1000))]);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(collect(session.continue())).rejects.toThrow(/closed/i);
  });

  it('rejects a second iterator from the same iterable without leaking the active run', async () => {
    const controlled = testModels();
    const session = await new PiAgentSessionFactory({ repository: new InMemorySessionRepo(), models: controlled.models, model })
      .create({ id: 'two-iterators', initialMessage: { role: 'user', text: 'start' }, events: eventContext('two-iterators') });
    const iterable = session.continue();
    const first = iterable[Symbol.asyncIterator]();
    const second = iterable[Symbol.asyncIterator]();
    await first.next();
    await expect(second.next()).rejects.toThrow(/active/i);
    const returned = first.return?.();
    controlled.release();
    await returned;
    await session.close();
  });

  it('uses Pi compaction preparation and does not import low-level loops', async () => {
    expect(preparePiCompaction([], { enabled: true, reserveTokens: 64, keepRecentTokens: 1 }))
      .toEqual({ ok: true, value: undefined });
    const prepared = preparePiCompaction([
      { type: 'message', id: 'entry-1', parentId: null, timestamp: new Date(1).toISOString(),
        message: { role: 'user', content: 'one', timestamp: 1 } },
      { type: 'message', id: 'entry-2', parentId: 'entry-1', timestamp: new Date(2).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], api: model.api,
        provider: model.provider, model: model.id,
        usage: { input: 500, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 2 } },
      { type: 'message', id: 'entry-3', parentId: 'entry-2', timestamp: new Date(3).toISOString(),
        message: { role: 'user', content: 'three', timestamp: 3 } },
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

  it.each(['close', 'return'] as const)('cleans an active run when %s cancellation rejects', async (action) => {
    const listeners = new Set<(event: never) => void>();
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    let abortCalls = 0;
    let unsubscribeCalls = 0;
    const harness = {
      subscribe(listener: (event: never) => void) {
        listeners.add(listener);
        return () => { unsubscribeCalls++; listeners.delete(listener); };
      },
      prompt: async () => {
        for (const listener of listeners) listener({ type: 'agent_start' } as never);
        await runGate;
      },
      abort: async () => {
        abortCalls++;
        for (const listener of listeners) listener({
          type: 'abort', clearedSteer: [], clearedFollowUp: [],
        } as never);
      },
      waitForIdle: async () => {},
      getTools: () => [],
      on: () => () => {},
    };
    let sequence = 0;
    const session = new PiAgentSession(
      { getMetadata: async () => ({ id: 'cleanup', createdAt: new Date(0).toISOString() }),
        getEntries: async () => [] } as never,
      harness as never,
      { role: 'user', text: 'start' },
      new EventCodec({ ...eventContext(`cleanup-${action}`), sequence: () => {
        if (++sequence === 2) throw new Error('subscriber failed');
        return BigInt(sequence);
      } }),
    );
    const iterator = session.continue()[Symbol.asyncIterator]();
    await iterator.next();

    const operation = action === 'close' ? session.close() : iterator.return!();
    const observed = operation.then(() => undefined, (error: unknown) => error);
    if (action === 'return') releaseRun();
    await expect(observed).resolves.toMatchObject({ message: 'subscriber failed' });
    expect(unsubscribeCalls).toBe(1);
    expect(listeners.size).toBe(0);
    if (action === 'close') releaseRun();
    expect(abortCalls).toBe(1);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
