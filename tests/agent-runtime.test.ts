import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, createConfiguredAgentRuntime } from '../src/agent/runtime.js';
import type { AgentKernel } from '../src/agent/kernel.js';
import type { RunAgentOptions, RunAgentResult } from '../src/agent/run-types.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { AgentRunBinding, AgentRunBindingStore } from '../src/agent/runtime.js';
import { MemoryStore } from '../src/db/memory.js';
import { MemoryRuntimeStore } from '@aiop/agent-runtime-core';
import type { JsonValue } from '../src/model/types.js';

const productInteractionCases: Array<[string, 'question' | 'plan', JsonValue]> = [
  ['ask_user', 'question', { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] }],
  ['submit_change_plan', 'plan', {
    summary: 'roll out', changes: [{ action: 'apply', target: 'prod' }], impact: 'api', rollback: 'revert',
  }],
];

function runOptions(): RunAgentOptions {
  return {
    model: {
      id: 'unused',
      async *stream() {
        yield { type: 'text_delta' as const, text: 'unused' };
      },
    },
    tools: new ToolRegistry(),
    policy: new AllowAllPolicy(),
    ctx: { sessionId: 'runtime-test' },
    task: 'test',
  };
}

describe('AgentRuntime', () => {
  it('routes the complete options object through the configured kernel', async () => {
    const expected: RunAgentResult = {
      messages: [{ role: 'assistant', text: 'ok' }],
      text: 'ok',
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      compacted: false,
    };
    const kernel = {
      name: 'test',
      run: vi.fn(async () => expected),
    } satisfies AgentKernel;
    const runtime = new AgentRuntime({ kernel });
    const options = runOptions();

    await expect(runtime.run(options)).resolves.toBe(expected);
    expect(kernel.run).toHaveBeenCalledOnce();
    expect(kernel.run).toHaveBeenCalledWith(options);
    expect(runtime.kernelName).toBe('test');
  });

  it('uses the Pi kernel by default', () => {
    expect(new AgentRuntime().kernelName).toBe('pi');
  });

  it('defaults to Pi and rejects retired kernel configuration', () => {
    expect(createConfiguredAgentRuntime({}).kernelName).toBe('pi');
    expect(createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }).kernelName).toBe('pi');
    expect(() => createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'legacy' }))
      .toThrow('AIOP_AGENT_KERNEL is retired; only pi is supported');
    expect(() => createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'langgraph' }))
      .toThrow('AIOP_AGENT_KERNEL is retired; only pi is supported');
  });

  it('rejects disabled and unknown Pi modes', () => {
    expect(() => createConfiguredAgentRuntime({ AIOP_PI_MODE: 'disabled' }))
      .toThrow('AIOP_PI_MODE must be one of read-only, dry-run, replay, full');
    expect(() => createConfiguredAgentRuntime({ AIOP_PI_MODE: 'unknown' }))
      .toThrow('AIOP_PI_MODE must be one of read-only, dry-run, replay, full');
  });

  it('gates shadow/read-only tools', async () => {
    const visible: string[][] = [];
    const result: RunAgentResult = {
      messages: [], text: '', steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      compacted: false,
    };
    const pi: AgentKernel = {
      name: 'pi',
      run: async (options) => {
        const defs = [
          { name: 'get_pods', description: '', inputSchema: {} },
          { name: 'delete_pod', description: '', inputSchema: {} },
        ];
        visible.push((options.filterToolDefs?.(defs) ?? defs).map((tool) => tool.name));
        return result;
      },
    };
    const readOnly = createConfiguredAgentRuntime({
      AIOP_PI_MODE: 'read-only',
    }, { kernels: { pi } });
    await readOnly.run(runOptions());
    const dryRun = createConfiguredAgentRuntime({
      AIOP_PI_MODE: 'dry-run',
    }, { kernels: { pi } });
    await dryRun.run(runOptions());

    expect(visible).toEqual([['get_pods'], []]);
  });

  it('locks the Pi kernel for a run across runtime instances', async () => {
    const bindings = new Map<string, AgentRunBinding>();
    const bindingStore: AgentRunBindingStore = {
      getAgentRunBinding: async (_tenantId, runId) => bindings.get(runId),
      putAgentRunBindingIfAbsent: async (binding) => {
        if (bindings.has(binding.runId)) return false;
        bindings.set(binding.runId, binding);
        return true;
      },
    };
    const calls: string[] = [];
    const result: RunAgentResult = {
      messages: [], text: '', steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      compacted: false,
    };
    const kernels = { pi: { name: 'pi', run: async () => { calls.push('pi'); return result; } } satisfies AgentKernel };
    const first = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { kernels, bindingStore });
    await first.run({ ...runOptions(), runId: 'run-locked', ctx: { tenantId: 'tenant-a', userId: 'user-a', sessionId: 's' } });
    const fresh = createConfiguredAgentRuntime({}, { kernels, bindingStore });
    await fresh.run({ ...runOptions(), runId: 'run-locked', ctx: { tenantId: 'tenant-a', userId: 'user-a', sessionId: 's' } });

    expect(calls).toEqual(['pi', 'pi']);
    expect(bindings.get('run-locked')).toMatchObject({ kernel: 'pi' });
  });

  it('persists coordinated lifecycle around a real kernel invocation', async () => {
    const store = new MemoryStore();
    const result: RunAgentResult = {
      messages: [], text: 'ok', steps: 2,
      usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
      compacted: false,
    };
    const runtime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, {
      kernels: { pi: { name: 'pi', run: async (options) => {
        await options.runLifecycle?.nodeStarted('model');
        await options.runLifecycle?.nodeCompleted('model', { steps: 2 });
        return result;
      } } },
      bindingStore: store,
      runStore: store,
    });
    const options = {
      ...runOptions(), runId: 'run-coordinated',
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user' as const, sessionId: 'session-a' },
    };

    await expect(runtime.run(options)).resolves.toBe(result);
    expect(await store.getAgentRun(options.ctx, 'run-coordinated')).toMatchObject({
      status: 'succeeded', stepCount: 2, usage: { inputTokens: 5, outputTokens: 2 },
    });
  });

  it('executes Pi through Durable Runtime with the locked AIOP run id', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    let modelTurn = 0;
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } },
      run: async () => ({ id: 'lookup-1', content: '7' }),
    });
    const runtime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });
    const result = await runtime.run({
      ...runOptions(),
      runId: 'run-durable-aiop',
      tools,
      model: {
        id: 'fake',
        async *stream() {
          modelTurn++;
          if (modelTurn === 1) {
            yield { type: 'tool_call', call: { id: 'lookup-1', name: 'lookup', args: {} } } as const;
            yield { type: 'stop', reason: 'tool_use' } as const;
          } else {
            yield { type: 'text_delta', text: 'done' } as const;
            yield { type: 'stop', reason: 'end_turn' } as const;
          }
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    });

    expect(result.text).toBe('done');
    expect(await runtimeStore.attempts.list({ tenantId: 'tenant-a', runId: 'run-durable-aiop' })).toHaveLength(1);
    expect((await runtimeStore.turns.getLastCommitted({ tenantId: 'tenant-a', runId: 'run-durable-aiop' }))?.turnNo).toBe(2);
  });

  it('commits policy-gated product tools as pending Runtime facts without executing the handler', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const execute = vi.fn(async () => ({ id: '', content: 'must not execute' }));
    const tools = new ToolRegistry().register({
      def: { name: 'write_config', description: 'write', inputSchema: { type: 'object' } },
      run: execute,
    });
    const runtime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });
    let turn = 0;
    const result = await runtime.run({
      ...runOptions(), runId: 'run-product-approval', tools,
      policy: { check: async () => ({ blocked: false, needApproval: true, reason: 'production' }) },
      model: {
        id: 'fake',
        async *stream() {
          turn++;
          if (turn === 1) {
            yield { type: 'tool_call', call: { id: 'call-write', name: 'write_config', args: { value: 7 } } } as const;
            yield { type: 'stop', reason: 'tool_use' } as const;
          } else {
            yield { type: 'text_delta', text: 'continued' } as const;
            yield { type: 'stop', reason: 'end_turn' } as const;
          }
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    });

    expect(result.text).toBe('');
    expect(execute).not.toHaveBeenCalled();
    await expect(runtimeStore.interactions.list({ tenantId: 'tenant-a', runId: 'run-product-approval' }))
      .resolves.toEqual([expect.objectContaining({
        kind: 'approval', status: 'pending', userId: 'user-a', sessionId: 'session-a',
        toolCallId: 'call-write', payload: expect.objectContaining({ reason: 'production' }),
      })]);
    await expect(runtimeStore.toolLedger.get({
      tenantId: 'tenant-a', runId: 'run-product-approval', logicalCallId: 'call-write',
    })).resolves.toMatchObject({ status: 'pending_approval', toolName: 'write_config' });
  });

  it('uses a fresh Durable Pi runtime to approve and execute the original product handler once', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const idempotencyKeys: string[] = [];
    const tools = new ToolRegistry().register({
      def: { name: 'write_config', description: 'write', inputSchema: { type: 'object' } },
      run: async (_args, ctx) => {
        idempotencyKeys.push(String(ctx.idempotencyKey));
        return { id: '', content: 'product write completed' };
      },
    });
    let modelAttempt = 0;
    const model = {
      id: 'fake',
      async *stream(input: Parameters<RunAgentOptions['model']['stream']>[0]) {
        modelAttempt++;
        if (modelAttempt === 1) {
          yield { type: 'tool_call', call: { id: 'call-write', name: 'write_config', args: { value: 7 } } } as const;
          yield { type: 'usage', inputTokens: 3, outputTokens: 2 } as const;
          yield { type: 'stop', reason: 'tool_use' } as const;
          return;
        }
        expect(input.messages.some((message) => message.toolResults?.some((item) =>
          item.id === 'call-write' && item.content === 'product write completed'))).toBe(true);
        yield { type: 'text_delta', text: 'resumed done' } as const;
        yield { type: 'usage', inputTokens: 4, outputTokens: 1 } as const;
        yield { type: 'stop', reason: 'end_turn' } as const;
      },
    };
    const options = {
      ...runOptions(), runId: 'run-product-resume', tools, model,
      policy: { check: async () => ({ blocked: false, needApproval: true, reason: 'production' }) },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user' as const, sessionId: 'session-a' },
    };
    const firstRuntime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });
    await firstRuntime.run(options);
    const interaction = (await runtimeStore.interactions.list({
      tenantId: 'tenant-a', runId: 'run-product-resume',
    }))[0]!;
    const stableKey = (await runtimeStore.toolLedger.get({
      tenantId: 'tenant-a', runId: 'run-product-resume', logicalCallId: 'call-write',
    }))!.idempotencyKey;

    const freshRuntime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });
    const result = await freshRuntime.run({
      ...options,
      resumeFromCheckpoint: true,
      interactionResolution: { interactionId: interaction.id, value: true },
    });

    expect(result).toMatchObject({
      text: 'resumed done',
      usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    expect(idempotencyKeys).toEqual([stableKey]);
    await expect(runtimeStore.toolLedger.get({
      tenantId: 'tenant-a', runId: 'run-product-resume', logicalCallId: 'call-write',
    })).resolves.toMatchObject({ status: 'completed', result: { content: 'product write completed' } });
    expect(await runtimeStore.attempts.list({ tenantId: 'tenant-a', runId: 'run-product-resume' })).toHaveLength(2);
  });

  it.each(productInteractionCases)('commits %s as a product-shaped durable %s interaction without invoking its handler', async (
    toolName, kind, args,
  ) => {
    const runtimeStore = new MemoryRuntimeStore();
    const handler = vi.fn(async () => ({ id: '', content: 'must not execute' }));
    const tools = new ToolRegistry().register({
      def: { name: toolName, description: kind, inputSchema: { type: 'object' } }, run: handler,
    });
    const runtime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });
    await runtime.run({
      ...runOptions(), runId: `run-product-${kind}`, tools,
      model: {
        id: 'fake',
        async *stream() {
          yield { type: 'tool_call', call: { id: `call-${kind}`, name: toolName, args } } as const;
          yield { type: 'stop', reason: 'tool_use' } as const;
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    });

    const interaction = (await runtimeStore.interactions.list({
      tenantId: 'tenant-a', runId: `run-product-${kind}`,
    }))[0]!;
    expect(interaction).toMatchObject({
      kind, status: 'pending', toolCallId: `call-${kind}`, expiresAt: expect.any(Date),
      payload: expect.objectContaining({
        id: interaction.id, tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a',
        runId: `run-product-${kind}`,
      }),
    });
    if (kind === 'question') expect(interaction.payload).toMatchObject({
      questions: (args as { questions: JsonValue }).questions,
    });
    else expect(interaction.payload).toMatchObject({ plan: args, questions: expect.any(Array) });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    'AIOP_PI_MAX_CONCURRENT_TOOLS_PER_TENANT',
    'AIOP_PI_MAX_CONCURRENT_TOOLS_PER_TOOL',
    'AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE',
  ])('rejects an invalid positive-integer %s limit', (name) => {
    expect(() => createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi', [name]: '0' }))
      .toThrow(`${name} must be a positive integer`);
  });

  it('shares the configured tenant/model ceiling across Durable Pi runtime instances', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const runtime = createConfiguredAgentRuntime({
      AIOP_AGENT_KERNEL: 'pi',
      AIOP_PI_MAX_CONCURRENT_MODEL_CALLS: '1',
    }, { runtimeStore });
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const options = (runId: string, modelId: string): RunAgentOptions => ({
      ...runOptions(), runId,
      model: {
        id: modelId,
        async *stream() {
          started.push(runId);
          if (runId === 'run-model-1') await firstGate;
          yield { type: 'text_delta', text: runId } as const;
          yield { type: 'stop', reason: 'end_turn' } as const;
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: runId },
    });

    const first = runtime.run(options('run-model-1', 'shared-model'));
    await vi.waitFor(() => expect(started).toEqual(['run-model-1']));
    const queued = runtime.run(options('run-model-2', 'shared-model'));
    const otherModel = runtime.run(options('run-model-3', 'other-model'));
    await expect(otherModel).resolves.toMatchObject({ text: 'run-model-3' });
    expect(started).toEqual(['run-model-1', 'run-model-3']);

    releaseFirst();
    await expect(Promise.all([first, queued])).resolves.toEqual([
      expect.objectContaining({ text: 'run-model-1' }),
      expect.objectContaining({ text: 'run-model-2' }),
    ]);
    expect(started).toEqual(['run-model-1', 'run-model-3', 'run-model-2']);
  });

  it('compacts an oversized transcript before the Durable Pi model call and commits the compacted context', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const modelMessages: string[][] = [];
    const events: unknown[] = [];
    const staleMessages = Array.from({ length: 8 }, (_, index) => ({
      role: 'user' as const,
      text: `old-${index} ${'x'.repeat(120)}`,
    }));
    const runtime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });

    const result = await runtime.run({
      ...runOptions(),
      runId: 'run-durable-compaction',
      messages: staleMessages,
      task: 'latest request',
      contextBudgetTokens: 400,
      compactionTriggerTokens: 120,
      compactionKeepRecent: 2,
      summarize: async (stale) => `durable summary of ${stale.length} messages`,
      onEvent: (event) => events.push(event),
      model: {
        id: 'fake',
        async *stream(input) {
          modelMessages.push(input.messages.map((message) => message.text ?? ''));
          yield { type: 'text_delta', text: 'compacted answer' } as const;
          yield { type: 'usage', inputTokens: 7, outputTokens: 2 } as const;
          yield { type: 'stop', reason: 'end_turn' } as const;
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    });

    expect(modelMessages).toHaveLength(1);
    expect(modelMessages[0].some((text) => text.includes('durable summary'))).toBe(true);
    expect(modelMessages[0]).not.toContain(staleMessages[0].text);
    expect(result.compacted).toBe(true);
    const committed = await runtimeStore.turns.getLastCommitted({
      tenantId: 'tenant-a', runId: 'run-durable-compaction',
    });
    expect(fromCommittedText(committed?.messages ?? []).some((text) => text.includes('durable summary'))).toBe(true);
    const durableEvents = await runtimeStore.events.list({ tenantId: 'tenant-a', runId: 'run-durable-compaction' });
    expect(durableEvents).toContainEqual(expect.objectContaining({
      type: 'context_compacted',
      detail: expect.objectContaining({
        type: 'context_compacted',
        tokensBefore: expect.any(Number),
        tokensAfter: expect.any(Number),
        summarizedMessages: expect.any(Number),
        version: 1,
      }),
    }));
    expect(JSON.stringify(durableEvents.map((event) => event.detail))).not.toContain(staleMessages[0].text);
    expect(events).toContainEqual(expect.objectContaining({ type: 'context_compacted' }));
  });

  it('preserves the AIOP failure contract when Durable Runtime records a failed Pi run', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const runtime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });

    await expect(runtime.run({
      ...runOptions(),
      runId: 'run-durable-failed',
      model: {
        id: 'fake',
        async *stream() {
          throw new Error('provider unavailable');
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    })).rejects.toMatchObject({ message: 'provider unavailable' });

    await expect(runtimeStore.runs.get({ tenantId: 'tenant-a', runId: 'run-durable-failed' }))
      .resolves.toMatchObject({ status: 'failed' });
  });

  it('resumes a failed AIOP Pi run from its last durable turn', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    let modelTurn = 0;
    const runtime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });
    const options: RunAgentOptions = {
      ...runOptions(),
      runId: 'run-durable-resume',
      model: {
        id: 'fake',
        async *stream() {
          modelTurn++;
          if (modelTurn === 1) throw new Error('temporary provider failure');
          yield { type: 'text_delta', text: 'recovered' } as const;
          yield { type: 'stop', reason: 'end_turn' } as const;
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    };

    await expect(runtime.run(options)).rejects.toMatchObject({ message: 'temporary provider failure' });
    await expect(runtime.run({ ...options, resumeFromCheckpoint: true })).resolves.toMatchObject({
      text: 'recovered', steps: 2,
    });
    expect(await runtimeStore.attempts.list({ tenantId: 'tenant-a', runId: 'run-durable-resume' })).toHaveLength(2);
    expect((await runtimeStore.turns.getLastCommitted({ tenantId: 'tenant-a', runId: 'run-durable-resume' }))?.turnNo).toBe(2);
  });

  it('replays a committed Pi transcript without invoking model/tools or mutating the source Run', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const sourceRuntime = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { runtimeStore });
    await sourceRuntime.run({
      ...runOptions(),
      runId: 'run-replay-source',
      model: {
        id: 'fake',
        async *stream() {
          yield { type: 'text_delta', text: 'source answer' } as const;
          yield { type: 'usage', inputTokens: 9, outputTokens: 3 } as const;
          yield { type: 'stop', reason: 'end_turn' } as const;
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    });
    const attemptsBefore = await runtimeStore.attempts.list({ tenantId: 'tenant-a', runId: 'run-replay-source' });
    const turnsBefore = await runtimeStore.turns.listCommitted({ tenantId: 'tenant-a', runId: 'run-replay-source' });
    const model = vi.fn(async function* () { yield { type: 'text_delta', text: 'must not run' } as const; });
    const tool = vi.fn(async () => ({ id: 'write-1', content: 'must not run' }));
    const tools = new ToolRegistry();
    tools.register({ def: { name: 'write', description: 'write', inputSchema: { type: 'object' } }, run: tool });
    const replayRuntime = createConfiguredAgentRuntime({
      AIOP_AGENT_KERNEL: 'pi', AIOP_PI_MODE: 'replay',
    }, { runtimeStore });

    const replayed = await replayRuntime.run({
      ...runOptions(),
      runId: 'run-replay-source',
      comparisonRunId: 'run-replay-source',
      model: { id: 'fake', stream: model },
      tools,
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    });

    expect(replayed).toMatchObject({
      text: 'source answer',
      usage: { inputTokens: 9, outputTokens: 3 },
      rollout: {
        mode: 'replay', sourceRunId: 'run-replay-source',
        usageDelta: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
    });
    expect(model).not.toHaveBeenCalled();
    expect(tool).not.toHaveBeenCalled();
    expect(await runtimeStore.attempts.list({ tenantId: 'tenant-a', runId: 'run-replay-source' })).toEqual(attemptsBefore);
    expect(await runtimeStore.turns.listCommitted({ tenantId: 'tenant-a', runId: 'run-replay-source' })).toEqual(turnsBefore);
  });

  it('persists dry-run rollout metadata while exposing no tools to the model', async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const visibleTools: string[][] = [];
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => ({ id: 'write-1', content: 'must not run' }));
    tools.register({ def: { name: 'write', description: 'write', inputSchema: { type: 'object' } }, run: execute });
    const runtime = createConfiguredAgentRuntime({
      AIOP_AGENT_KERNEL: 'pi', AIOP_PI_MODE: 'dry-run',
    }, { runtimeStore });
    await runtime.run({
      ...runOptions(),
      runId: 'run-dry-mode',
      comparisonRunId: 'run-control',
      tools,
      model: {
        id: 'fake',
        async *stream(input) {
          visibleTools.push(input.tools.map((tool) => tool.name));
          yield { type: 'text_delta', text: 'dry result' } as const;
          yield { type: 'stop', reason: 'end_turn' } as const;
        },
      },
      ctx: { tenantId: 'tenant-a', userId: 'user-a', role: 'user', sessionId: 'session-a' },
    });
    const attempt = (await runtimeStore.attempts.list({ tenantId: 'tenant-a', runId: 'run-dry-mode' }))[0]!;
    const snapshot = await runtimeStore.turns.getSnapshot({
      tenantId: 'tenant-a', runId: 'run-dry-mode', attemptId: attempt.attemptId, turnNo: 1,
    });

    expect(visibleTools).toEqual([[]]);
    expect(execute).not.toHaveBeenCalled();
    expect(snapshot?.modelBinding).toMatchObject({ rolloutMode: 'dry-run', comparisonRunId: 'run-control' });
    const events = await runtimeStore.events.list({ tenantId: 'tenant-a', runId: 'run-dry-mode' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'rollout_comparison',
      detail: expect.objectContaining({ mode: 'dry-run', sourceRunId: 'run-control', outcome: 'succeeded' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'turn_committed',
      detail: expect.objectContaining({ rolloutMode: 'dry-run', comparisonRunId: 'run-control' }),
    }));
  });
});

function fromCommittedText(messages: readonly import('@aiop/agent-contracts').KernelMessage[]): string[] {
  return messages.flatMap((message) => message.role === 'user' || message.role === 'assistant'
    ? message.content.flatMap((block) => block.type === 'text' ? [block.text] : [])
    : message.results.map((result) => result.content));
}
