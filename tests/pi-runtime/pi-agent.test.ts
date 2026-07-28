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
  preparePiCompaction,
} from '../../packages/pi-runtime/src/index.js';

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
    const session = await factory.create({ id: 'session-aborted', initialMessage: { role: 'user', text: 'start' } });
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
    const session = await factory.create({ id: 'session-1', initialMessage: { role: 'user', text: 'start' } });

    const eventsPromise = collect(session.continue());
    await Promise.resolve();
    await session.steer({ role: 'user', text: 'steer now' });
    await session.followUp({ role: 'user', text: 'follow later' });
    controlled.release();
    const events = await eventsPromise;

    expect(events.some((event) => event.type === 'agent_start')).toBe(true);
    expect(events.some((event) => event.type === 'message_end')).toBe(true);
    expect(controlled.contexts).toHaveLength(2);
    expect(JSON.stringify(controlled.contexts)).toContain('steer now');
    expect(JSON.stringify(controlled.contexts)).toContain('follow later');
    const metadata = await session.metadata();
    await session.close();

    const loaded = await factory.load({ metadata, initialMessage: { role: 'user', text: 'loaded' } });
    expect((await loaded.entries()).some((entry) => entry.type === 'message')).toBe(true);
    await loaded.close();
  });

  it('adapts governed tools through setTools and Pi validation/execution', async () => {
    const repository = new InMemorySessionRepo();
    const controlled = testModels();
    const factory = new PiAgentSessionFactory({ repository, models: controlled.models, model });
    const session = await factory.create({ id: 'session-tools', initialMessage: { role: 'user', text: 'start' } });
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
    expect(prepared).toBeDefined();

    const source = await import('node:fs/promises').then(({ readFile }) => readFile(
      new URL('../../packages/pi-runtime/src/pi/agent.ts', import.meta.url), 'utf8',
    ));
    expect(source).not.toMatch(/\bagentLoop(?:Continue)?\b/);
  });
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
