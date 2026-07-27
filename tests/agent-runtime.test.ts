import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, createConfiguredAgentRuntime } from '../src/agent/runtime.js';
import type { AgentKernel } from '../src/agent/kernel.js';
import type { RunAgentOptions, RunAgentResult } from '../src/agent/core.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { AgentRunBinding, AgentRunBindingStore } from '../src/agent/runtime.js';
import { MemoryStore } from '../src/db/memory.js';
import { MemoryRuntimeStore } from '@aiop/agent-runtime-core';

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

  it('uses the legacy kernel by default', () => {
    expect(new AgentRuntime().kernelName).toBe('legacy');
  });

  it('selects Pi only when explicitly configured and rejects new LangGraph traffic', () => {
    expect(createConfiguredAgentRuntime({}).kernelName).toBe('legacy');
    expect(createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }).kernelName).toBe('pi');
    expect(createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'langgraph' }).kernelName).toBe('legacy');
    expect(createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'unknown' }).kernelName).toBe('legacy');
  });

  it('routes tenant-rule Pi rollout lists before legacy fallback', async () => {
    const calls: string[] = [];
    const result: RunAgentResult = {
      messages: [], text: '', steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      compacted: false,
    };
    const kernel = (name: 'pi' | 'legacy'): AgentKernel => ({
      name,
      run: async () => { calls.push(name); return result; },
    });
    const runtime = createConfiguredAgentRuntime({
      AIOP_AGENT_KERNEL: 'tenant-rule',
      AIOP_PI_TEST_TENANTS: 'tenant-pi',
      AIOP_PI_INTERNAL_USERS: 'user-pi',
      AIOP_PI_READ_ONLY_SESSIONS: 'session-pi-ro',
      AIOP_PI_FULL_SESSIONS: 'session-pi-full',
    }, { kernels: { legacy: kernel('legacy'), pi: kernel('pi') } });

    for (const ctx of [
      { tenantId: 'tenant-pi', userId: 'u', sessionId: 's' },
      { tenantId: 'tenant-x', userId: 'user-pi', sessionId: 's' },
      { tenantId: 'tenant-x', userId: 'u', sessionId: 'session-pi-ro' },
      { tenantId: 'tenant-x', userId: 'u', sessionId: 'session-pi-full' },
      { tenantId: 'tenant-x', userId: 'u', sessionId: 'other' },
    ]) await runtime.run({ ...runOptions(), ctx });

    expect(calls).toEqual(['pi', 'pi', 'pi', 'pi', 'legacy']);
  });

  it('supports immediate Pi rollback and gates shadow/read-only tools', async () => {
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
    expect(createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi', AIOP_PI_MODE: 'disabled' }, {
      kernels: { pi },
    }).kernelName).toBe('legacy');

    const readOnly = createConfiguredAgentRuntime({
      AIOP_AGENT_KERNEL: 'pi', AIOP_PI_MODE: 'read-only',
    }, { kernels: { pi } });
    await readOnly.run(runOptions());
    const dryRun = createConfiguredAgentRuntime({
      AIOP_AGENT_KERNEL: 'pi', AIOP_PI_MODE: 'dry-run',
    }, { kernels: { pi } });
    await dryRun.run(runOptions());

    expect(visible).toEqual([['get_pods'], []]);
  });

  it('locks the Pi kernel for a run across runtime reconfiguration', async () => {
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
    const kernels = {
      legacy: { name: 'legacy', run: async () => { calls.push('legacy'); return result; } } satisfies AgentKernel,
      pi: { name: 'pi', run: async () => { calls.push('pi'); return result; } } satisfies AgentKernel,
    };
    const first = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }, { kernels, bindingStore });
    await first.run({ ...runOptions(), runId: 'run-locked', ctx: { tenantId: 'tenant-a', userId: 'user-a', sessionId: 's' } });
    const reconfigured = createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'legacy' }, { kernels, bindingStore });
    await reconfigured.run({ ...runOptions(), runId: 'run-locked', ctx: { tenantId: 'tenant-a', userId: 'user-a', sessionId: 's' } });

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
});

function fromCommittedText(messages: readonly import('@aiop/agent-contracts').KernelMessage[]): string[] {
  return messages.flatMap((message) => message.role === 'user' || message.role === 'assistant'
    ? message.content.flatMap((block) => block.type === 'text' ? [block.text] : [])
    : message.results.map((result) => result.content));
}
