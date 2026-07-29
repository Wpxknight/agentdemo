import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import type { DurableInteractionUpdate, JsonValue } from '@aiop/control-contracts';
import {
  GovernedToolOutcomeError,
  MemoryRunStore,
  ResourceConcurrencyController,
  attachGovernedToolFacts,
  bridgeGovernedTools,
  createMemoryDurablePiRuntime,
} from '../../packages/pi-runtime/src/index.js';
import { ToolRegistry, defineTool } from '../../src/agent/tools.js';
import { createAIOPToolRuntime } from '../../src/tools/governance.js';

const model: Model<'product-interaction-replay-test'> = {
  id: 'product-interaction-replay-test', name: 'Product Interaction Replay Test',
  api: 'product-interaction-replay-test', provider: 'product-interaction-replay-test', baseUrl: '',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096, maxTokens: 256,
};

const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;
const questionInput = {
  questions: [{
    question: 'Continue?', header: 'Confirm',
    options: [{ label: 'Yes' }, { label: 'No' }],
  }],
} satisfies JsonValue;
const planInput = {
  summary: 'Deploy release',
  changes: [{ action: 'apply', target: 'prod/app' }],
  impact: 'app users', rollback: 'restore the previous release',
} satisfies JsonValue;

describe('product durable interaction replay', () => {
  it('preserves the legacy approval payload shape through createAIOPToolRuntime', async () => {
    const input = { target: 'staging' };
    const result = await runProductReplay({
      kind: 'approval', toolName: 'deploy', input, value: true,
    });

    expect(result.pending.payload).toMatchObject({
      id: result.pending.id,
      runId: result.runId,
      call: { id: result.toolCallId, name: 'deploy', args: input },
      reason: null,
    });
    expect(asObject(result.pending.payload)).not.toHaveProperty('__aiopGovernedInput');
    expect(result.resumed).toMatchObject({ status: 'succeeded', text: 'continued after interaction' });
    expect(result.handler).toHaveBeenCalledTimes(1);
    expect(result.providerTurns).toBe(2);
  });

  it.each([
    { kind: 'question' as const, toolName: 'ask_user' as const, input: questionInput, value: { Continue: ['Yes'] } },
    { kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput, value: true },
  ])('resumes a transformed $kind payload through createAIOPToolRuntime', async (testCase) => {
    const result = await runProductReplay(testCase);

    expect(result.pending.payload).toMatchObject(testCase.kind === 'plan'
      ? {
          id: result.pending.id, runId: result.runId, plan: testCase.input,
          __aiopGovernedInput: testCase.input,
        }
      : {
          id: result.pending.id, runId: result.runId, ...testCase.input,
          __aiopGovernedInput: testCase.input,
        });
    expect(result.resumed).toMatchObject({ status: 'succeeded', text: 'continued after interaction' });
    expect(result.handler).not.toHaveBeenCalled();
    expect(result.providerTurns).toBe(2);
  });

  it.each([
    {
      kind: 'question' as const, toolName: 'ask_user' as const, input: questionInput,
      value: { Continue: ['Yes'] }, milliseconds: 302, roundedSeconds: 0,
    },
    {
      kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput,
      value: true, milliseconds: 302, roundedSeconds: 0,
    },
    {
      kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput,
      value: true, milliseconds: 500, roundedSeconds: 1,
    },
    {
      kind: 'question' as const, toolName: 'ask_user' as const, input: questionInput,
      value: { Continue: ['Yes'] }, milliseconds: 700, roundedSeconds: 1,
    },
    {
      kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput,
      value: true, milliseconds: 700, roundedSeconds: 1,
    },
  ])('resumes a transformed $kind payload when MySQL rounds .$milliseconds to second +$roundedSeconds', async (testCase) => {
    const result = await runProductReplay(testCase, (interaction) => {
      const second = Math.floor(interaction.createdAt.getTime() / 1000) * 1000;
      return {
        ...interaction,
        createdAt: new Date(second + testCase.roundedSeconds * 1000),
        payload: { ...asObject(interaction.payload), createdAt: new Date(second + testCase.milliseconds).toISOString() },
      };
    });

    expect(result.resolved.createdAt.getTime() % 1000).toBe(0);
    expect(asObject(result.resolved.payload).createdAt).toBe(
      new Date(result.resolved.createdAt.getTime()
        - testCase.roundedSeconds * 1000 + testCase.milliseconds).toISOString(),
    );
    expect(result.resumed.error).toBeUndefined();
    expect(result.resumed).toMatchObject({ status: 'succeeded', text: 'continued after interaction' });
    expect(result.handler).not.toHaveBeenCalled();
    expect(result.providerTurns).toBe(2);
  });

  it.each([
    { kind: 'question' as const, toolName: 'ask_user' as const, input: questionInput, value: { Continue: ['Yes'] } },
    { kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput, value: true },
  ])('rejects a transformed $kind payload when createdAt differs by more than one second', async (testCase) => {
    const result = await runProductReplay(testCase, (interaction) => ({
      ...interaction,
      createdAt: new Date(interaction.createdAt.getTime() + 2_000),
    }));

    expect(result.resumed).toMatchObject({
      status: 'recovery_required',
      error: expect.objectContaining({
        message: expect.stringContaining('interaction payload is not bound to the pending tool call'),
      }),
    });
    expect(result.handler).not.toHaveBeenCalled();
    expect(result.providerTurns).toBe(1);
  });

  it.each([
    { kind: 'question' as const, toolName: 'ask_user' as const, input: questionInput, value: { Continue: ['Yes'] } },
    { kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput, value: true },
  ])('rejects a transformed $kind payload with an invalid createdAt timestamp', async (testCase) => {
    const result = await runProductReplay(testCase, (interaction) => ({
      ...interaction,
      payload: { ...asObject(interaction.payload), createdAt: 'not-a-timestamp' },
    }));

    expect(result.resumed).toMatchObject({
      status: 'recovery_required',
      error: expect.objectContaining({
        message: expect.stringContaining('interaction payload is not bound to the pending tool call'),
      }),
    });
    expect(result.handler).not.toHaveBeenCalled();
    expect(result.providerTurns).toBe(1);
  });

  it.each([
    {
      kind: 'question' as const, toolName: 'ask_user' as const, input: questionInput, value: { Continue: ['Yes'] },
      legacyPayload: (payload: JsonValue) => withoutBinding(payload),
    },
    {
      kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput, value: true,
      legacyPayload: (payload: JsonValue) => withoutBinding(payload),
    },
  ])('resumes the existing legacy $kind wrapper without an explicit binding', async (testCase) => {
    const result = await runProductReplay(testCase, (interaction) => ({
      ...interaction,
      payload: testCase.legacyPayload(interaction.payload),
    }));

    expect(result.resumed).toMatchObject({ status: 'succeeded', text: 'continued after interaction' });
    expect(result.handler).not.toHaveBeenCalled();
    expect(result.providerTurns).toBe(2);
  });

  it.each([
    {
      name: 'question raw input', kind: 'question' as const, toolName: 'ask_user' as const, input: questionInput,
      value: { Continue: ['Yes'] },
      mutate: (interaction: DurableInteractionUpdate) => ({
        ...interaction,
        payload: { ...asObject(interaction.payload), questions: [{
          question: 'Continue?', header: 'Confirm', options: [{ label: 'Always' }, { label: 'Never' }],
        }] },
      }),
    },
    {
      name: 'plan raw input', kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput,
      value: true,
      mutate: (interaction: DurableInteractionUpdate) => ({
        ...interaction,
        payload: { ...asObject(interaction.payload), plan: { ...planInput, impact: 'all tenants' } },
      }),
    },
    {
      name: 'legacy plan wrapper', kind: 'plan' as const, toolName: 'submit_change_plan' as const, input: planInput,
      value: true,
      mutate: (interaction: DurableInteractionUpdate) => ({
        ...interaction,
        payload: { ...asObject(withoutBinding(interaction.payload)), unexpected: 'wrapper injection' },
      }),
    },
  ])('rejects tampered $name before handler or provider continuation', async (testCase) => {
    const result = await runProductReplay(testCase, testCase.mutate);

    expect(result.resumed).toMatchObject({
      status: 'recovery_required',
      error: expect.objectContaining({
        message: expect.stringContaining('interaction payload is not bound to the pending tool call'),
      }),
    });
    expect(result.handler).not.toHaveBeenCalled();
    expect(result.providerTurns).toBe(1);
  });
});

type ReplayCase = {
  kind: 'approval' | 'question' | 'plan';
  toolName: string;
  input: Record<string, JsonValue>;
  value: JsonValue;
};

async function runProductReplay(
  testCase: ReplayCase,
  mutate?: (interaction: DurableInteractionUpdate) => DurableInteractionUpdate,
) {
  const suffix = `${testCase.kind}-${Math.random().toString(36).slice(2)}`;
  const runId = `product-replay-${suffix}`;
  const sessionId = `product-session-${suffix}`;
  const toolCallId = `call-${suffix}`;
  const store = new MemoryRunStore();
  const models = createModels();
  const handler = vi.fn(async () => ({ id: toolCallId, content: 'handler must not execute' }));
  const tools = new ToolRegistry().register(defineTool({
    name: testCase.toolName,
    description: testCase.toolName,
    capability: 'retryable_write',
    inputSchema: { type: 'object' },
    execute: handler,
  }));
  let providerTurns = 0;
  const stream = () => {
    const output = createAssistantMessageEventStream();
    providerTurns++;
    const content: AssistantMessage['content'] = providerTurns === 1
      ? [{ type: 'toolCall', id: toolCallId, name: testCase.toolName, arguments: testCase.input }]
      : [{ type: 'text', text: 'continued after interaction' }];
    finish(output, content, providerTurns === 1 ? 'toolUse' : 'stop');
    return output;
  };
  models.setProvider(createProvider({
    id: model.provider,
    auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'test' } }) } },
    models: [model], api: { stream, streamSimple: stream },
  }));
  const concurrency = new ResourceConcurrencyController();
  const { runtime } = createMemoryDurablePiRuntime({
    store, models, model, heartbeatMs: 0,
    resolveTools: async ({ identity: currentIdentity, sessionId: currentSessionId, events, interactionResolution }) => {
      if (!currentIdentity) return [];
      const toolContext = {
        tenantId: currentIdentity.tenantId, userId: currentIdentity.actorId,
        role: 'user' as const, sessionId: currentSessionId ?? events.runId,
      };
      const definitions = tools.unified(toolContext).definitions().map((definition) => ({
        ...definition,
        ...(testCase.kind === 'approval' ? {} : { interactionKind: testCase.kind }),
      }));
      const governed = createAIOPToolRuntime({
        model: {} as never,
        tools,
        policy: { check: async () => ({ blocked: false, needApproval: testCase.kind === 'approval' }) },
        ctx: toolContext,
      }, store.toolLedger, concurrency, store.interactions);
      const resolved = interactionResolution
        ? await store.interactions.get({
            tenantId: currentIdentity.tenantId, runId: events.runId,
            interactionId: interactionResolution.interactionId,
          })
        : undefined;
      return bridgeGovernedTools(definitions.map((definition) => ({
        definition,
        execute: async (call, context) => {
          const outcome = await governed.execute(call, {
            identity: currentIdentity, runId: events.runId, attemptId: events.attemptId,
            turnNo: events.turnNo, sessionId: currentSessionId ?? events.runId, signal: context.signal,
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
      })));
    },
  });

  expect(await (await runtime.run({
    runId, identity, sessionId, input: [{ role: 'user', text: 'start interaction' }],
  })).result()).toMatchObject({ status: 'waiting' });
  const [pending] = await store.interactions.list({ tenantId: identity.tenantId, runId });
  const resolved = mutate?.(pending!) ?? pending!;
  await store.interactions.put({
    ...resolved, status: 'resolved', resolution: testCase.value, resolvedAt: new Date(),
  });
  const resumed = await (await runtime.resume({
    identity, runId, resolution: { interactionId: resolved.id, value: testCase.value },
  })).result();
  return { resumed, pending: pending!, resolved, handler, providerTurns, runId, toolCallId };
}

function withoutBinding(payload: JsonValue): JsonValue {
  const { __aiopGovernedInput: _binding, ...legacy } = asObject(payload);
  return legacy;
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
