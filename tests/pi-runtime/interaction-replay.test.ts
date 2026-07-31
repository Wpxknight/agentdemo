import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { InMemorySessionRepo, InMemorySessionStorage, Session, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { DurableInteractionUpdate, JsonValue, ToolExecutionOutcome } from '@aiop/control-contracts';
import {
  GovernedToolFactory,
  GovernedToolOutcomeError,
  MemoryRunStore,
  attachGovernedToolFacts,
  bridgeGovernedTools,
  createMemoryDurablePiRuntime,
  PiAgentSessionFactory,
} from '../../packages/pi-runtime/src/index.js';
import { digestToolValue } from '../../packages/pi-runtime/src/tools/ledger.js';

const model: Model<'pi-interaction-replay-test'> = {
  id: 'pi-interaction-replay-test', name: 'Pi Interaction Replay Test',
  api: 'pi-interaction-replay-test', provider: 'pi-interaction-replay-test', baseUrl: '',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096, maxTokens: 256,
};

const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;

describe('durable Pi interaction replay', () => {
  it('replays a persisted product plan after interaction dates pass through entry JSON', async () => {
    const createdAt = new Date('2026-07-30T08:09:10.123Z');
    const plan = { summary: 'Deploy staging' };
    const interactionId = 'plan-persisted-a';
    const toolCallId = 'call-plan-persisted-a';
    const toolName = 'submit_change_plan';
    const ledgerUpdate = {
      tenantId: identity.tenantId, runId: 'run-persisted-plan', attemptId: 'attempt-a', turnNo: 1,
      logicalCallId: toolCallId, toolCallId, toolName, argsDigest: digestToolValue(plan),
      capability: 'retryable_write' as const, idempotencyKey: 'key-persisted-plan',
      approvedInteractionId: interactionId, status: 'pending_approval' as const,
      createdAt, updatedAt: createdAt,
    };
    const interactionUpdate = {
      tenantId: identity.tenantId, runId: 'run-persisted-plan', id: interactionId,
      userId: identity.actorId, sessionId: 'session-persisted-plan', attemptId: 'attempt-a', turnNo: 1,
      kind: 'plan' as const, toolCallId, status: 'pending' as const,
      payload: {
        id: interactionId, tenantId: identity.tenantId, userId: identity.actorId,
        sessionId: 'session-persisted-plan', runId: 'run-persisted-plan', createdAt: createdAt.toISOString(),
        questions: [{
          question: '请审批变更方案：Deploy staging', header: '变更审批',
          options: [{ label: '批准' }, { label: '拒绝' }],
        }],
        plan,
        __aiopGovernedInput: plan,
      },
      createdAt,
    };
    const entries: SessionTreeEntry[] = [
      {
        type: 'message', id: 'assistant-persisted-plan', parentId: null, timestamp: createdAt.toISOString(),
        message: {
          role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: plan }],
          api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: createdAt.getTime(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      },
      {
        type: 'message', id: 'waiting-persisted-plan', parentId: 'assistant-persisted-plan',
        timestamp: createdAt.toISOString(),
        message: {
          role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text: 'tool waiting for plan' }],
          details: {
            version: 1, kind: 'governed_tool_outcome',
            outcome: {
              kind: 'waiting', reason: 'plan', interactionId,
              ledgerUpdates: [ledgerUpdate], interactionUpdates: [interactionUpdate],
            },
          },
          isError: true, timestamp: createdAt.getTime(),
        },
      },
    ];
    const persistedEntries = JSON.parse(JSON.stringify(entries)) as SessionTreeEntry[];
    const persistedEntry = persistedEntries[1];
    if (persistedEntry?.type !== 'message' || persistedEntry.message.role !== 'toolResult') {
      throw new Error('persisted waiting tool result is missing');
    }
    const persistedDetails = persistedEntry.message.details as {
      outcome: { interactionUpdates: Array<{ createdAt: unknown }> };
    };
    expect(persistedDetails.outcome.interactionUpdates[0]?.createdAt).toBe(createdAt.toISOString());
    const persistedSession = new Session(new InMemorySessionStorage({
      metadata: { id: 'session-persisted-plan', createdAt: createdAt.toISOString() }, entries: persistedEntries,
    }));
    const execute = vi.fn(async () => ({ callId: toolCallId, content: 'plan resolved: true' }));
    const tools = bridgeGovernedTools([{
      definition: {
        name: toolName, description: 'Submit plan', capability: 'retryable_write',
        inputSchema: {
          type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false,
        },
      },
      execute,
    }]);
    const session = await new PiAgentSessionFactory({
      repository: { open: async () => persistedSession } as never, models: createModels(), model, tools,
    }).load({
      metadata: { id: 'session-persisted-plan', createdAt: createdAt.toISOString() },
      initialMessage: { role: 'user', text: 'resume' }, events: testEvents('run-persisted-plan'),
    });

    await expect(session.replayInteraction({
      interactionId, kind: 'plan', toolCallId, value: true,
    })).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    await session.close();
  });

  it.each([
    {
      kind: 'approval' as const, value: true, expectedContent: 'deployment completed',
      expectedError: false, executesHandler: true,
    },
    {
      kind: 'approval' as const, value: false, expectedContent: 'approval denied',
      expectedError: true, executesHandler: false,
    },
    {
      kind: 'question' as const, value: { answer: ['yes'] },
      expectedContent: 'question resolved: {"answer":["yes"]}', expectedError: false, executesHandler: false,
    },
    {
      kind: 'plan' as const, value: true, expectedContent: 'plan resolved: true',
      expectedError: false, executesHandler: false,
    },
  ])('settles the exact pending governed $kind call before the resumed provider turn', async ({
    kind, value, expectedContent, expectedError, executesHandler,
  }) => {
    const runId = 'interaction-replay-run';
    const sessionId = 'interaction-replay-session';
    const toolCallId = 'call-deploy-a';
    const logicalCallId = 'logical-deploy-a';
    let interactionId = kind === 'approval' ? 'approval-deploy-a' : '';
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push('tool');
      return { content: 'deployment completed' };
    });
    const store = new MemoryRunStore();
    const models = createModels();
    let providerTurn = 0;
    const stream = (_model: Model<any>, context: Context) => {
      order.push(`model-${++providerTurn}`);
      const output = createAssistantMessageEventStream();
      if (providerTurn === 1) {
        finish(output, [{
          type: 'toolCall', id: toolCallId, name: 'deploy', arguments: { target: 'staging' },
        }], 'toolUse');
      } else {
        const resolvedResults = context.messages.filter((message) => message.role === 'toolResult'
          && message.toolCallId === toolCallId);
        expect(order).toEqual(expectsHandlerOrder(executesHandler));
        expect(resolvedResults).toEqual([expect.objectContaining({
          role: 'toolResult', toolCallId, toolName: 'deploy', isError: expectedError,
          content: [{ type: 'text', text: expectedContent }],
        })]);
        expect(context.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
        expect(JSON.stringify(context.messages)).not.toContain('Continue from the last committed state.');
        expect(JSON.stringify(context.messages)).not.toContain(interactionId);
        finish(output, [{ type: 'text', text: 'continued after deployment' }], 'stop');
      }
      return output;
    };
    models.setProvider(createProvider({
      id: model.provider,
      auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
      models: [model], api: { stream, streamSimple: stream },
    }));
    const definition = {
      name: 'deploy', description: 'Deploy', capability: 'retryable_write' as const,
      inputSchema: {
        type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false,
      },
      ...(kind === 'approval' ? {} : { interactionKind: kind }),
      execute,
    };
    const { runtime } = createMemoryDurablePiRuntime({
      store, models, model, heartbeatMs: 0,
      resolveTools: async ({ identity: currentIdentity, sessionId: currentSessionId, events, interactionResolution }) => {
        if (!currentIdentity) return [];
        const resolved = interactionResolution
          ? await store.interactions.get({
              tenantId: currentIdentity.tenantId, runId: events.runId,
              interactionId: interactionResolution.interactionId,
            })
          : undefined;
        const governed = new GovernedToolFactory({
          ledger: store.toolLedger,
          interactions: store.interactions,
          policy: { check: async () => kind === 'approval'
            ? { allowed: true, needsApproval: true, reason: 'deployment approval' }
            : { allowed: true } },
          ...(kind === 'approval' ? { approval: { request: async () => ({
              approved: false, pending: true, interactionId,
              payload: { call: { id: toolCallId, name: 'deploy', args: { target: 'staging' } } },
            }) } } : {}),
        }).create([definition]);
        return bridgeGovernedTools([{
          definition,
          logicalCallId: () => logicalCallId,
          execute: async (call, context) => {
            if (resolved?.status === 'resolved') order.push('replay');
            const outcome = bindProductInteractionPayloads(await governed.execute(call, {
              identity: currentIdentity, runId: events.runId, attemptId: events.attemptId, turnNo: events.turnNo,
              sessionId: currentSessionId ?? events.runId, signal: context.signal,
              interactionResolution: resolved?.status === 'resolved' && resolved.toolCallId
                ? {
                    interactionId: resolved.id, kind: resolved.kind, toolCallId: resolved.toolCallId,
                    value: resolved.resolution ?? interactionResolution?.value ?? null,
                  }
                : undefined,
            }));
            if (outcome.kind === 'result') {
              return attachGovernedToolFacts(outcome.result, outcome);
            }
            throw new GovernedToolOutcomeError(outcome);
          },
        }]);
      },
    });

    const waiting = await (await runtime.run({
      runId, identity, sessionId, input: [{ role: 'user', text: 'deploy staging' }],
    })).result();
    expect(waiting.status).toBe('waiting');
    const [pendingInteraction] = await store.interactions.list({ tenantId: identity.tenantId, runId });
    interactionId = pendingInteraction!.id;
    expect(await store.toolLedger.get({ tenantId: identity.tenantId, runId, logicalCallId }))
      .toMatchObject({ status: 'pending_approval', toolCallId, approvedInteractionId: interactionId });

    await expect(store.resolveInteraction({
      ...pendingInteraction!, status: 'resolved', resolution: value, resolvedAt: new Date(),
    })).resolves.toBe(true);

    const resumed = await (await runtime.resume({
      identity, runId, resolution: { interactionId, value },
    })).result();

    expect(execute).toHaveBeenCalledTimes(executesHandler ? 1 : 0);
    expect(await store.toolLedger.get({ tenantId: identity.tenantId, runId, logicalCallId }))
      .toMatchObject({
        status: 'completed', toolCallId,
        result: { callId: toolCallId, content: expectedContent, ...(expectedError ? { isError: true } : {}) },
      });
    expect(resumed).toMatchObject({ status: 'succeeded', text: 'continued after deployment' });
  });

  it('terminates a native continuation on a nested governed interaction and replays it later', async () => {
    const runId = 'nested-interaction-run';
    const store = new MemoryRunStore();
    const models = createModels();
    let providerTurns = 0;
    const stream = () => {
      const output = createAssistantMessageEventStream();
      providerTurns++;
      if (providerTurns === 1) {
        finish(output, [{ type: 'toolCall', id: 'call-first', name: 'ask_first', arguments: { prompt: 'first' } }], 'toolUse');
      } else if (providerTurns === 2) {
        finish(output, [{ type: 'toolCall', id: 'call-second', name: 'ask_second', arguments: { prompt: 'second' } }], 'toolUse');
      } else {
        finish(output, [{ type: 'text', text: 'both interactions resolved' }], 'stop');
      }
      return output;
    };
    models.setProvider(createProvider({
      id: model.provider,
      auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
      models: [model], api: { stream, streamSimple: stream },
    }));
    const { runtime } = createQuestionRuntime({ store, models, toolNames: ['ask_first', 'ask_second'] });

    expect(await (await runtime.run({
      runId, identity, sessionId: 'nested-interaction-session',
      input: [{ role: 'user', text: 'ask twice' }],
    })).result()).toMatchObject({ status: 'waiting' });
    const first = (await store.interactions.list({ tenantId: identity.tenantId, runId }))[0]!;
    await store.interactions.put({ ...first, status: 'resolved', resolution: { answer: ['one'] }, resolvedAt: new Date() });

    expect(await (await runtime.resume({
      identity, runId, resolution: { interactionId: first.id, value: { answer: ['one'] } },
    })).result()).toMatchObject({ status: 'waiting' });
    expect(providerTurns).toBe(2);
    const second = (await store.interactions.list({ tenantId: identity.tenantId, runId }))
      .find((interaction) => interaction.toolCallId === 'call-second')!;
    await store.interactions.put({ ...second, status: 'resolved', resolution: { answer: ['two'] }, resolvedAt: new Date() });

    expect(await (await runtime.resume({
      identity, runId, resolution: { interactionId: second.id, value: { answer: ['two'] } },
    })).result()).toMatchObject({ status: 'succeeded', text: 'both interactions resolved' });
    expect(providerTurns).toBe(3);
  });

  it('replays a resolved interaction before delivering a pre-existing durable inbox message once', async () => {
    const runId = 'replay-inbox-ready-run';
    const store = new MemoryRunStore();
    const models = createModels();
    const contexts: Context['messages'][] = [];
    let providerTurns = 0;
    const stream = (_model: Model<any>, context: Context) => {
      contexts.push(structuredClone(context.messages));
      const output = createAssistantMessageEventStream();
      providerTurns++;
      if (providerTurns === 1) {
        finish(output, [{ type: 'toolCall', id: 'call-first', name: 'ask_first', arguments: { prompt: 'first' } }], 'toolUse');
      } else {
        finish(output, [{ type: 'text', text: 'inbox delivered' }], 'stop');
      }
      return output;
    };
    models.setProvider(createProvider({
      id: model.provider,
      auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
      models: [model], api: { stream, streamSimple: stream },
    }));
    const { runtime } = createQuestionRuntime({ store, models, toolNames: ['ask_first'] });

    expect(await (await runtime.run({
      runId, identity, sessionId: 'replay-inbox-ready-session', input: [{ role: 'user', text: 'ask then append' }],
    })).result()).toMatchObject({ status: 'waiting' });
    const interaction = (await store.interactions.list({ tenantId: identity.tenantId, runId }))[0]!;
    await store.interactions.put({
      ...interaction, status: 'resolved', resolution: { answer: ['ready'] }, resolvedAt: new Date(),
    });
    await store.inbox.enqueue({
      identity, tenantId: identity.tenantId, runId, idempotencyKey: 'pre-existing-inbox', mode: 'steer',
      message: { role: 'user', text: 'durable inbox once' }, createdAt: new Date(),
    });

    expect(await (await runtime.resume({
      identity, runId, resolution: { interactionId: interaction.id, value: { answer: ['ready'] } },
    })).result()).toMatchObject({ status: 'succeeded', text: 'inbox delivered' });
    expect(providerTurns).toBe(2);
    expect(JSON.stringify(contexts[1])).toContain('question resolved');
    expect(JSON.stringify(contexts[1]).match(/durable inbox once/g)).toHaveLength(1);
    expect(JSON.stringify(contexts[1]).indexOf('question resolved'))
      .toBeLessThan(JSON.stringify(contexts[1]).indexOf('durable inbox once'));
    expect(await store.inbox.list(identity.tenantId, runId)).toEqual([
      expect.objectContaining({ status: 'consumed', idempotencyKey: 'pre-existing-inbox' }),
    ]);
  });

  it('emits Harness-compatible provider lifecycle events during native continuation', async () => {
    const runId = 'continuation-lifecycle-run';
    const store = new MemoryRunStore();
    const models = createModels();
    let providerTurns = 0;
    const stream = (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        await options?.onPayload?.({ turn: providerTurns + 1 }, model);
        await options?.onResponse?.({ status: 200, headers: { 'x-request-id': `request-${providerTurns + 1}` } }, model);
        providerTurns++;
        finish(output, providerTurns === 1
          ? [{ type: 'toolCall', id: 'call-first', name: 'ask_first', arguments: { prompt: 'first' } }]
          : [{ type: 'text', text: 'continued with lifecycle' }], providerTurns === 1 ? 'toolUse' : 'stop');
      })();
      return output;
    };
    models.setProvider(createProvider({
      id: model.provider,
      auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
      models: [model], api: { stream, streamSimple: stream },
    }));
    const { runtime } = createQuestionRuntime({ store, models, toolNames: ['ask_first'] });

    expect(await (await runtime.run({
      runId, identity, sessionId: 'continuation-lifecycle-session', input: [{ role: 'user', text: 'start' }],
    })).result()).toMatchObject({ status: 'waiting' });
    const interaction = (await store.interactions.list({ tenantId: identity.tenantId, runId }))[0]!;
    await store.interactions.put({
      ...interaction, status: 'resolved', resolution: { answer: ['ready'] }, resolvedAt: new Date(),
    });
    expect(await (await runtime.resume({
      identity, runId, resolution: { interactionId: interaction.id, value: { answer: ['ready'] } },
    })).result()).toMatchObject({ status: 'succeeded', text: 'continued with lifecycle' });

    const attempts = await store.attempts.list({ tenantId: identity.tenantId, runId });
    const continuationEvents = (await store.events.list({ tenantId: identity.tenantId, runId }))
      .filter((event) => event.attemptId === attempts[1]!.attemptId).map((event) => event.type);
    for (const eventType of [
      'before_agent_start', 'before_provider_request', 'before_provider_payload', 'after_provider_response',
    ]) {
      expect(continuationEvents).toContain(eventType);
    }
  });

  it('rejects a mismatched committed waiting interaction without executing the resolved tool', async () => {
    const models = createModels();
    let providerTurns = 0;
    const stream = () => {
      providerTurns++;
      const output = createAssistantMessageEventStream();
      finish(output, [{
        type: 'toolCall', id: 'call-safe-a', name: 'safe-deploy', arguments: { target: 'staging' },
      }], 'toolUse');
      return output;
    };
    models.setProvider(createProvider({
      id: model.provider,
      auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
      models: [model], api: { stream, streamSimple: stream },
    }));
    const executeResolved = vi.fn(async () => ({ callId: 'call-safe-a', content: 'must not execute' }));
    const waitingTools = bridgeGovernedTools([{
      definition: {
        name: 'safe-deploy', description: 'Safe deploy', capability: 'retryable_write', inputSchema: { type: 'object' },
      },
      execute: async () => {
        throw new GovernedToolOutcomeError({
          kind: 'waiting', reason: 'approval', interactionId: 'approval-original',
        });
      },
    }]);
    const factory = new PiAgentSessionFactory({
      repository: new InMemorySessionRepo(), models, model, tools: waitingTools,
    });
    const session = await factory.create({
      id: 'safe-mismatch-session', initialMessage: { role: 'user', text: 'deploy' },
      events: testEvents('safe-mismatch-run'),
    });
    await expect(collect(session.continue())).rejects.toMatchObject({
      kind: 'waiting', interactionId: 'approval-original',
    });
    await session.setTools(bridgeGovernedTools([{
      definition: {
        name: 'safe-deploy', description: 'Safe deploy', capability: 'retryable_write', inputSchema: { type: 'object' },
      },
      execute: executeResolved,
    }]));

    await expect(session.replayInteraction({
      interactionId: 'approval-different', kind: 'approval', toolCallId: 'call-safe-a', value: true,
    })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
    expect(executeResolved).not.toHaveBeenCalled();
    expect(providerTurns).toBe(1);
    await session.close();
  });

  it.each([
    {
      name: 'exact toolCallId mismatch', kind: 'question' as const,
      mutateInteraction: (interaction: DurableInteractionUpdate) => ({ ...interaction, toolCallId: 'call-other' }),
    },
    {
      name: 'ledger interaction attempt mismatch', kind: 'question' as const,
      mutateInteraction: (interaction: DurableInteractionUpdate) => ({ ...interaction, attemptId: 'attempt-other' }),
    },
    {
      name: 'ledger interaction turn mismatch', kind: 'plan' as const,
      mutateInteraction: (interaction: DurableInteractionUpdate) => ({ ...interaction, turnNo: interaction.turnNo + 1 }),
    },
    {
      name: 'payload arguments mismatch', kind: 'question' as const,
      mutateInteraction: (interaction: DurableInteractionUpdate) => ({ ...interaction, payload: { target: 'production' } }),
    },
    {
      name: 'same-name capability mismatch', kind: 'approval' as const,
      resumedDefinition: { capability: 'read' as const },
    },
    {
      name: 'same-name schema mismatch', kind: 'approval' as const,
      resumedDefinition: {
        inputSchema: {
          type: 'object', properties: { region: { type: 'string' } }, required: ['region'],
          additionalProperties: false,
        },
      },
    },
  ])('fails safe for $name before handler or provider continuation', async (testCase) => {
    const result = await runNegativeReplayCase(testCase);

    expect(['failed', 'recovery_required']).toContain(result.resumed.status);
    expect(result.handler).not.toHaveBeenCalled();
    expect(result.providerTurns).toBe(1);
    expect(await result.store.toolLedger.get({
      tenantId: identity.tenantId, runId: result.runId, logicalCallId: result.logicalCallId,
    })).toMatchObject({ status: 'pending_approval', toolCallId: result.toolCallId });
  });
});

type NegativeReplayCase = {
  name: string;
  kind: 'approval' | 'question' | 'plan';
  mutateInteraction?: (interaction: DurableInteractionUpdate) => DurableInteractionUpdate;
  resumedDefinition?: {
    capability?: 'read' | 'retryable_write';
    inputSchema?: Record<string, unknown>;
  };
};

async function runNegativeReplayCase(testCase: NegativeReplayCase) {
  const suffix = testCase.name.replace(/[^a-z]+/gi, '-').toLowerCase();
  const runId = `negative-${suffix}`;
  const sessionId = `negative-session-${suffix}`;
  const toolCallId = 'call-negative-a';
  const logicalCallId = 'logical-negative-a';
  const interactionId = 'approval-negative-a';
  const value = testCase.kind === 'question' ? { answer: ['yes'] } : true;
  const store = new MemoryRunStore();
  const models = createModels();
  let providerTurns = 0;
  const stream = () => {
    providerTurns++;
    const output = createAssistantMessageEventStream();
    finish(output, providerTurns === 1
      ? [{ type: 'toolCall', id: toolCallId, name: 'deploy-negative', arguments: { target: 'staging' } }]
      : [{ type: 'text', text: 'provider must not continue' }], providerTurns === 1 ? 'toolUse' : 'stop');
    return output;
  };
  models.setProvider(createProvider({
    id: model.provider,
    auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
    models: [model], api: { stream, streamSimple: stream },
  }));
  const handler = vi.fn(async () => ({ content: 'handler must not execute' }));
  const baseDefinition = {
    name: 'deploy-negative', description: 'Deploy negative', capability: 'retryable_write' as const,
    inputSchema: {
      type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false,
    },
    ...(testCase.kind === 'approval' ? {} : { interactionKind: testCase.kind }),
    execute: handler,
  };
  const { runtime } = createMemoryDurablePiRuntime({
    store, models, model, heartbeatMs: 0,
    resolveTools: async ({ identity: currentIdentity, sessionId: currentSessionId, events, interactionResolution }) => {
      if (!currentIdentity) return [];
      const definition = interactionResolution && testCase.resumedDefinition
        ? { ...baseDefinition, ...testCase.resumedDefinition }
        : baseDefinition;
      const governed = new GovernedToolFactory({
        ledger: store.toolLedger, interactions: store.interactions,
        policy: { check: async () => testCase.kind === 'approval'
          ? { allowed: true, needsApproval: true, reason: 'deployment approval' }
          : { allowed: true } },
        ...(testCase.kind === 'approval' ? { approval: { request: async () => ({
            approved: false, pending: true, interactionId,
            payload: { call: { id: toolCallId, name: definition.name, args: { target: 'staging' } } },
          }) } } : {}),
      }).create([definition]);
      const resolved = interactionResolution
        ? await store.interactions.get({
            tenantId: currentIdentity.tenantId, runId: events.runId,
            interactionId: interactionResolution.interactionId,
          })
        : undefined;
      return bridgeGovernedTools([{
        definition,
        logicalCallId: () => logicalCallId,
        execute: async (call, context) => {
          const outcome = bindProductInteractionPayloads(await governed.execute(call, {
            identity: currentIdentity, runId: events.runId, attemptId: events.attemptId, turnNo: events.turnNo,
            sessionId: currentSessionId ?? events.runId, signal: context.signal,
            interactionResolution: resolved?.status === 'resolved' && resolved.toolCallId
              ? {
                  interactionId: resolved.id, kind: resolved.kind, toolCallId: resolved.toolCallId,
                  value: resolved.resolution ?? interactionResolution?.value ?? null,
                }
              : undefined,
          }));
          if (outcome.kind === 'result') return attachGovernedToolFacts(outcome.result, outcome);
          throw new GovernedToolOutcomeError(outcome);
        },
      }]);
    },
  });
  expect((await (await runtime.run({
    runId, identity, sessionId, input: [{ role: 'user', text: 'deploy staging' }],
  })).result()).status).toBe('waiting');
  const [pending] = await store.interactions.list({ tenantId: identity.tenantId, runId });
  const resolved = testCase.mutateInteraction?.(pending!) ?? pending!;
  await store.interactions.put({
    ...resolved, status: 'resolved', resolution: value, resolvedAt: new Date(),
  });
  const resumed = await (await runtime.resume({
    identity, runId, resolution: { interactionId: resolved.id, value },
  })).result();
  return { resumed, handler, providerTurns, store, runId, logicalCallId, toolCallId };
}

function createQuestionRuntime(input: {
  store: MemoryRunStore;
  models: ReturnType<typeof createModels>;
  toolNames: string[];
}) {
  return createMemoryDurablePiRuntime({
    store: input.store, models: input.models, model, heartbeatMs: 0,
    resolveTools: async ({ identity: currentIdentity, sessionId, events, interactionResolution }) => {
      if (!currentIdentity) return [];
      const definitions = input.toolNames.map((name) => ({
        name, description: name, capability: 'retryable_write' as const, interactionKind: 'question' as const,
        inputSchema: {
          type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false,
        },
        execute: async () => ({ content: 'unused' }),
      }));
      const governed = new GovernedToolFactory({
        ledger: input.store.toolLedger, interactions: input.store.interactions,
      }).create(definitions);
      const resolved = interactionResolution
        ? await input.store.interactions.get({
            tenantId: currentIdentity.tenantId, runId: events.runId,
            interactionId: interactionResolution.interactionId,
          })
        : undefined;
      return bridgeGovernedTools(definitions.map((definition) => ({
        definition,
        logicalCallId: (toolCallId: string) => toolCallId,
        execute: async (call, context) => {
          const outcome = bindProductInteractionPayloads(await governed.execute(call, {
            identity: currentIdentity, runId: events.runId, attemptId: events.attemptId, turnNo: events.turnNo,
            sessionId: sessionId ?? events.runId, signal: context.signal,
            interactionResolution: resolved?.status === 'resolved' && resolved.toolCallId === call.id
              ? {
                  interactionId: resolved.id, kind: resolved.kind, toolCallId: resolved.toolCallId,
                  value: resolved.resolution ?? interactionResolution?.value ?? null,
                }
              : undefined,
          }));
          if (outcome.kind === 'result') return attachGovernedToolFacts(outcome.result, outcome);
          throw new GovernedToolOutcomeError(outcome);
        },
      })));
    },
  });
}

function bindProductInteractionPayloads(outcome: ToolExecutionOutcome): ToolExecutionOutcome {
  if (!outcome.interactionUpdates?.length) return outcome;
  return {
    ...outcome,
    interactionUpdates: outcome.interactionUpdates.map((interaction) => {
      if (interaction.kind !== 'question' && interaction.kind !== 'plan') return interaction;
      const base = {
        id: interaction.id,
        tenantId: interaction.tenantId,
        userId: interaction.userId ?? null,
        sessionId: interaction.sessionId ?? '',
        runId: interaction.runId,
        createdAt: interaction.createdAt.toISOString(),
      };
      const payload = interaction.kind === 'plan'
        ? {
            ...base,
            questions: [{
              question: `请审批变更方案：${planSummary(interaction.payload)}`,
              header: '变更审批', options: [{ label: '批准' }, { label: '拒绝' }],
            }],
            plan: interaction.payload,
            __aiopGovernedInput: interaction.payload,
          }
        : {
            ...asJsonObject(interaction.payload),
            ...base,
            __aiopGovernedInput: interaction.payload,
          };
      return { ...interaction, payload };
    }),
  };
}

function asJsonObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function planSummary(value: JsonValue): string {
  const summary = asJsonObject(value).summary;
  return typeof summary === 'string' ? summary : '';
}

function expectsHandlerOrder(executesHandler: boolean): string[] {
  return executesHandler ? ['model-1', 'replay', 'tool', 'model-2'] : ['model-1', 'replay', 'model-2'];
}

function testEvents(runId: string) {
  let sequence = 0n;
  return {
    tenantId: identity.tenantId, runId, attemptId: 'attempt-a', turnNo: 1,
    correlationId: 'correlation-a', sequence: () => ++sequence,
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function finish(
  output: ReturnType<typeof createAssistantMessageEventStream>,
  content: AssistantMessage['content'],
  stopReason: 'stop' | 'toolUse',
): void {
  const message: AssistantMessage = {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason, timestamp: Date.now(),
  };
  output.push({ type: 'start', partial: { ...message, content: [] } });
  output.push({ type: 'done', reason: stopReason, message });
}
