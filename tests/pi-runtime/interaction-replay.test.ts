import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import type { DurableInteractionUpdate } from '@aiop/control-contracts';
import {
  GovernedToolFactory,
  GovernedToolOutcomeError,
  MemoryRunStore,
  attachGovernedToolFacts,
  bridgeGovernedTools,
  createMemoryDurablePiRuntime,
  PiAgentSessionFactory,
} from '../../packages/pi-runtime/src/index.js';

const model: Model<'pi-interaction-replay-test'> = {
  id: 'pi-interaction-replay-test', name: 'Pi Interaction Replay Test',
  api: 'pi-interaction-replay-test', provider: 'pi-interaction-replay-test', baseUrl: '',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096, maxTokens: 256,
};

const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;

describe('durable Pi interaction replay', () => {
  it.each([
    { kind: 'approval' as const, value: true, expectedContent: 'deployment completed', executesHandler: true },
    { kind: 'question' as const, value: { answer: ['yes'] }, expectedContent: 'question resolved: {"answer":["yes"]}', executesHandler: false },
    { kind: 'plan' as const, value: true, expectedContent: 'plan resolved: true', executesHandler: false },
  ])('settles the exact pending governed $kind call before the resumed provider turn', async ({
    kind, value, expectedContent, executesHandler,
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
          role: 'toolResult', toolCallId, toolName: 'deploy', isError: false,
          content: [{ type: 'text', text: expectedContent }],
        })]);
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
            const outcome = await governed.execute(call, {
              identity: currentIdentity, runId: events.runId, attemptId: events.attemptId, turnNo: events.turnNo,
              sessionId: currentSessionId ?? events.runId, signal: context.signal,
              interactionResolution: resolved?.status === 'resolved' && resolved.toolCallId
                ? {
                    interactionId: resolved.id, kind: resolved.kind, toolCallId: resolved.toolCallId,
                    value: resolved.resolution ?? interactionResolution?.value ?? null,
                  }
                : undefined,
            });
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
        result: { callId: toolCallId, content: expectedContent },
      });
    expect(resumed).toMatchObject({ status: 'succeeded', text: 'continued after deployment' });
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
          const outcome = await governed.execute(call, {
            identity: currentIdentity, runId: events.runId, attemptId: events.attemptId, turnNo: events.turnNo,
            sessionId: currentSessionId ?? events.runId, signal: context.signal,
            interactionResolution: resolved?.status === 'resolved' && resolved.toolCallId
              ? {
                  interactionId: resolved.id, kind: resolved.kind, toolCallId: resolved.toolCallId,
                  value: resolved.resolution ?? interactionResolution?.value ?? null,
                }
              : undefined,
          });
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
