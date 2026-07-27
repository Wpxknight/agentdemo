import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, createConfiguredAgentRuntime } from '../src/agent/runtime.js';
import type { AgentKernel } from '../src/agent/kernel.js';
import type { RunAgentOptions, RunAgentResult } from '../src/agent/core.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { AgentRunBinding, AgentRunBindingStore } from '../src/agent/runtime.js';
import { MemoryStore } from '../src/db/memory.js';

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
});
