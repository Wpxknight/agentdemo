import { describe, expect, it } from 'vitest';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import { GovernedToolExecutionError, PiAgentSessionFactory, bridgeGovernedTools } from '../../packages/pi-runtime/src/index.js';

const model: Model<'pi-tool-test'> = {
  id: 'pi-tool-test', name: 'Pi Tool Test', api: 'pi-tool-test', provider: 'pi-tool-test', baseUrl: '',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096, maxTokens: 256,
};

function toolModels(argumentsValue: Record<string, unknown>) {
  return toolCallModels([{ id: 'call-1', name: 'lookup', arguments: argumentsValue }]);
}

function toolCallModels(toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  const models = createModels();
  let call = 0;
  const stream = () => {
    const output = createAssistantMessageEventStream();
    const content = call++ === 0
      ? toolCalls.map((toolCall) => ({ type: 'toolCall' as const, ...toolCall }))
      : [{ type: 'text' as const, text: 'complete' }];
    const message: AssistantMessage = {
      role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: content[0]!.type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now(),
    };
    output.push({ type: 'start', partial: { ...message, content: [] } });
    output.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    return output;
  };
  models.setProvider(createProvider({
    id: model.provider,
    auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
    models: [model], api: { stream, streamSimple: stream },
  }));
  return models;
}

function events() {
  let sequence = 0n;
  return { tenantId: 'tenant-1', runId: 'run-tools', attemptId: 'attempt-1', turnNo: 1,
    correlationId: 'correlation-1', sequence: () => ++sequence };
}

describe('Pi governed tool bridge', () => {
  it.each([
    {
      schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      args: { key: 'value', extra: true }, expectedCalls: 1,
    },
    {
      schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      args: { key: 'value', extra: true }, expectedCalls: 0,
    },
    {
      schema: { type: 'object', properties: { key: { oneOf: [{ type: 'string', minLength: 3 }, { type: 'number', minimum: 10 }] } }, required: ['key'] },
      args: { key: 12 }, expectedCalls: 1,
    },
    {
      schema: { type: 'object', properties: { key: { oneOf: [{ type: 'string', minLength: 3 }, { type: 'number', minimum: 10 }] } }, required: ['key'] },
      args: { key: { nested: true } }, expectedCalls: 0,
    },
  ])('delegates JSON Schema semantics to the real Harness for $args', async ({ schema, args, expectedCalls }) => {
    const calls: unknown[] = [];
    const tools = bridgeGovernedTools([{
      definition: {
        name: 'lookup', description: 'Lookup', capability: 'read' as const,
        inputSchema: schema,
      },
      execute: async (call: unknown) => { calls.push(call); return { callId: 'call-1', content: 'ok' }; },
    }]);
    const factory = new PiAgentSessionFactory({ repository: new InMemorySessionRepo(), models: toolModels(args), model });
    const session = await factory.create({ id: `tools-${expectedCalls}`, initialMessage: { role: 'user', text: 'start' }, events: events() });
    await session.setTools(tools);
    const projected = await collect(session.continue());

    expect(calls).toHaveLength(expectedCalls);
    const completed = projected.find((event) => event.type === 'tool_execution_end');
    expect(completed?.detail).toMatchObject({ isError: expectedCalls === 0 });
    expect(() => JSON.stringify(projected.map((event) => event.detail))).not.toThrow();
    await session.close();
  });

  it('throws governed error results through the Pi AgentTool contract', async () => {
    const [tool] = bridgeGovernedTools([{
      definition: { name: 'lookup', description: 'Lookup', capability: 'read', inputSchema: { type: 'object' } },
      execute: async () => ({ callId: 'call-1', content: 'denied', isError: true }),
    }]);
    const rejected = tool!.execute('call-1', {}, undefined, undefined, undefined);
    await expect(rejected).rejects.toBeInstanceOf(GovernedToolExecutionError);
    await expect(rejected).rejects.toMatchObject({
      call: { id: 'call-1', logicalCallId: 'call-1' },
      result: { callId: 'call-1', content: 'denied', isError: true },
    });
  });

  it.each(['initial', 'setTools'] as const)('preserves governed failures through the real Harness for %s tools', async (installation) => {
    const tools = bridgeGovernedTools([{
      definition: { name: 'lookup', description: 'Lookup', capability: 'read', inputSchema: { type: 'object' } },
      logicalCallId: () => 'logical-denied-1',
      execute: async () => ({ callId: 'call-1', content: 'denied', isError: true, digest: 'digest-1' }),
    }]);
    const repository = new InMemorySessionRepo();
    const factory = new PiAgentSessionFactory({
      repository, models: toolModels({ secret: 'do-not-persist', tokenCount: 7 }), model,
      ...(installation === 'initial' ? { tools } : {}),
    });
    const session = await factory.create({ id: `governed-error-${installation}`,
      initialMessage: { role: 'user', text: 'start' }, events: events() });
    if (installation === 'setTools') await session.setTools(tools);

    const projected = await collect(session.continue());
    const completed = projected.find((event) => event.type === 'tool_execution_end');
    expect(completed?.detail).toMatchObject({
      isError: true,
      details: {
        version: 1, kind: 'governed_tool_error',
        call: { id: 'call-1', logicalCallId: 'logical-denied-1', name: 'lookup',
          arguments: { secret: '[REDACTED]', tokenCount: 7 } },
        result: { callId: 'call-1', content: 'denied', isError: true, digest: 'digest-1' },
      },
    });
    expect(JSON.stringify(await session.entries())).toContain('logical-denied-1');
    expect(JSON.stringify(await session.entries())).toContain('digest-1');
    await session.close();
  });

  it('isolates a shared bridged tool prototype across successful and failed sessions with the same call id', async () => {
    const tools = bridgeGovernedTools([{
      definition: { name: 'lookup', description: 'Lookup', capability: 'read', inputSchema: { type: 'object' } },
      logicalCallId: (_id, args) => `logical-${(args as { owner: string }).owner}`,
      execute: async (call) => {
        const owner = (call.arguments as { owner: string }).owner;
        return { callId: call.id, content: owner === 'failed' ? 'denied-failed' : 'ok-success',
          isError: owner === 'failed', digest: `digest-${owner}` };
      },
    }]);
    const repository = new InMemorySessionRepo();
    const failed = await new PiAgentSessionFactory({ repository, models: toolModels({ owner: 'failed' }), model, tools })
      .create({ id: 'shared-failed', initialMessage: { role: 'user', text: 'start' }, events: events() });
    const success = await new PiAgentSessionFactory({ repository, models: toolModels({ owner: 'success' }), model, tools })
      .create({ id: 'shared-success', initialMessage: { role: 'user', text: 'start' }, events: events() });
    expect(failed.tools()[0]).not.toBe(tools[0]);
    expect(success.tools()[0]).not.toBe(tools[0]);
    expect(failed.tools()[0]).not.toBe(success.tools()[0]);

    const [failedEvents, successEvents] = await within(Promise.all([
      collect(failed.continue()), collect(success.continue()),
    ]), 'shared success/failure sessions');
    const failedJson = durableStringify({ events: failedEvents, entries: await failed.entries() });
    const successJson = durableStringify({ events: successEvents, entries: await success.entries() });
    expect(failedJson).toContain('logical-failed');
    expect(failedJson).toContain('digest-failed');
    expect(failedJson).not.toContain('logical-success');
    expect(successJson).not.toContain('logical-failed');
    expect(successJson).not.toContain('digest-failed');
    await Promise.all([failed.close(), success.close()]);
  });

  it('isolates distinct failures across two sessions sharing a prototype and call id', async () => {
    const tools = bridgeGovernedTools([{
      definition: { name: 'lookup', description: 'Lookup', capability: 'read', inputSchema: { type: 'object' } },
      logicalCallId: (_id, args) => `logical-${(args as { owner: string }).owner}`,
      execute: async (call) => {
        const owner = (call.arguments as { owner: string }).owner;
        return { callId: call.id, content: `denied-${owner}`, isError: true, digest: `digest-${owner}` };
      },
    }]);
    const repository = new InMemorySessionRepo();
    const sessionA = await new PiAgentSessionFactory({ repository, models: toolModels({ owner: 'a', tokenCount: 1 }), model, tools })
      .create({ id: 'shared-a', initialMessage: { role: 'user', text: 'start' }, events: events() });
    const sessionB = await new PiAgentSessionFactory({ repository, models: toolModels({ owner: 'b', tokenCount: 2 }), model, tools })
      .create({ id: 'shared-b', initialMessage: { role: 'user', text: 'start' }, events: events() });

    const [eventsA, eventsB] = await within(Promise.all([
      collect(sessionA.continue()), collect(sessionB.continue()),
    ]), 'shared failed sessions');
    const jsonA = durableStringify({ events: eventsA, entries: await sessionA.entries() });
    const jsonB = durableStringify({ events: eventsB, entries: await sessionB.entries() });
    expect(jsonA).toContain('logical-a');
    expect(jsonA).toContain('digest-a');
    expect(jsonA).not.toContain('logical-b');
    expect(jsonA).not.toContain('digest-b');
    expect(jsonB).toContain('logical-b');
    expect(jsonB).toContain('digest-b');
    expect(jsonB).not.toContain('logical-a');
    expect(jsonB).not.toContain('digest-a');
    await Promise.all([sessionA.close(), sessionB.close()]);
  });

  it('queues same-id failures within one session in tool completion order', async () => {
    const tools = bridgeGovernedTools([{
      definition: { name: 'lookup', description: 'Lookup', capability: 'read', inputSchema: { type: 'object' } },
      logicalCallId: (_id, args) => `logical-${(args as { invocation: string }).invocation}`,
      execute: async (call) => {
        const invocation = (call.arguments as { invocation: string }).invocation;
        return { callId: call.id, content: `denied-${invocation}`, isError: true, digest: `digest-${invocation}` };
      },
    }]);
    const session = await new PiAgentSessionFactory({
      repository: new InMemorySessionRepo(),
      models: toolCallModels([
        { id: 'same-id', name: 'lookup', arguments: { invocation: 'first' } },
        { id: 'same-id', name: 'lookup', arguments: { invocation: 'second' } },
      ]),
      model, tools,
    }).create({ id: 'same-id-queue', initialMessage: { role: 'user', text: 'start' }, events: events() });

    const projected = await within(collect(session.continue()), 'same-id failure queue');
    const governed = projected.filter((event) => event.type === 'tool_execution_end')
      .map((event) => JSON.stringify(event.detail));
    expect(governed).toHaveLength(2);
    expect(governed.join('\n')).toContain('logical-first');
    expect(governed.join('\n')).toContain('logical-second');
    await session.close();
  });

  it('rejects setTools during an active run without losing the old governed failure', async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const oldTools = bridgeGovernedTools([{
      definition: { name: 'lookup', description: 'Lookup', capability: 'read', inputSchema: { type: 'object' } },
      logicalCallId: () => 'logical-old',
      execute: async (call) => {
        started();
        await gate;
        return { callId: call.id, content: 'old denied', isError: true, digest: 'digest-old' };
      },
    }]);
    const newTools = bridgeGovernedTools([{
      definition: { name: 'replacement', description: 'Replacement', capability: 'read', inputSchema: { type: 'object' } },
      execute: async (call) => ({ callId: call.id, content: 'new ok' }),
    }]);
    const session = await new PiAgentSessionFactory({
      repository: new InMemorySessionRepo(), models: toolModels({ owner: 'old' }), model, tools: oldTools,
    }).create({ id: 'active-set-tools', initialMessage: { role: 'user', text: 'start' }, events: events() });
    const running = collect(session.continue());
    await within(didStart, 'old tool start');

    await expect(within(session.setTools(newTools), 'active setTools rejection')).rejects.toThrow(/active/i);
    release();
    const projected = await within(running, 'old tool completion');
    const json = durableStringify({ events: projected, entries: await session.entries() });
    expect(json).toContain('logical-old');
    expect(json).toContain('digest-old');
    expect(session.tools().map((tool) => tool.name)).toEqual(['lookup']);
    await session.close();
  });

  it('keeps a real Harness run alive when tool details are an unreadable Proxy', async () => {
    const unreadable = new Proxy({}, { get: () => { throw new Error('details getter failed'); } });
    const session = await new PiAgentSessionFactory({
      repository: new InMemorySessionRepo(), models: toolModels({}), model,
      tools: [{
        name: 'lookup', label: 'lookup', description: 'Lookup', parameters: { type: 'object' } as never,
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: unreadable }),
      }],
    }).create({ id: 'unreadable-details', initialMessage: { role: 'user', text: 'start' }, events: events() });

    const projected = await collect(session.continue());
    expect(projected.find((event) => event.type === 'tool_execution_end')?.detail)
      .toEqual({ kind: 'unserializable' });
    expect(projected.some((event) => event.type === 'agent_end')).toBe(true);
    await session.close();
  });

  it('passes Pi cancellation and a caller-resolved logical id to governed execution', async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const tools = bridgeGovernedTools([{
      definition: { name: 'lookup', description: 'Lookup', capability: 'read', inputSchema: { type: 'object' } },
      logicalCallId: () => 'logical-1',
      execute: async (call, context) => {
        receivedSignal = context.signal;
        expect(call.logicalCallId).toBe('logical-1');
        expect(context.logicalCallId).toBe('logical-1');
        started();
        return await new Promise((_, reject) => context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true }));
      },
    }]);
    const session = await new PiAgentSessionFactory({ repository: new InMemorySessionRepo(), models: toolModels({}), model })
      .create({ id: 'tool-cancel', initialMessage: { role: 'user', text: 'start' }, events: events() });
    await session.setTools(tools);
    const running = collect(session.continue());
    await didStart;
    await session.abort();
    await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('tool abort timeout')), 1000))]);
    expect(receivedSignal?.aborted).toBe(true);
    await session.close();
  });
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), 1000)),
  ]);
}

function durableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}
