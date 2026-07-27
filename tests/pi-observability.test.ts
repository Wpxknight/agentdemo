import { describe, expect, it, vi } from 'vitest';
import { AgentPlatformError, type AgentKernel, type RuntimeObservation } from '@aiop/agent-contracts';
import { DurableAgentRuntime } from '../packages/agent-runtime-core/src/runtime.js';
import { MemoryRuntimeStore } from '../packages/agent-runtime-core/src/memory-store.js';

const identity = {
  tenantId: 'tenant-observe',
  actorId: 'user-observe',
  roles: ['user'],
  correlationId: 'corr-observe',
} as const;

describe('Pi durable observability', () => {
  it('adds complete identity to every durable event and redacts model/tool content', async () => {
    const store = new MemoryRuntimeStore();
    const observations: RuntimeObservation[] = [];
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (input, control) => {
        await control.emit({ type: 'text_delta', text: 'private-model-text' });
        await control.emit({ type: 'thinking_delta', text: 'private-model-thinking' });
        await control.emit({
          type: 'tool_call',
          call: {
            id: 'call-observe', logicalCallId: 'logical-observe', name: 'lookup',
            arguments: { token: 'private-tool-argument' },
          },
        });
        await control.emit({
          type: 'tool_result',
          result: { callId: 'call-observe', content: 'private-tool-result' },
        });
        await control.emit({
          type: 'context_compacted', tokensBefore: 100, tokensAfter: 40, summarizedMessages: 6, version: 1,
        });
        return {
          outcome: 'waiting', turnNo: input.turnNo, waitingReason: 'question', stopReason: 'tool',
          usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 },
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'private-committed-text' }] }],
        };
      },
    };
    const runtime = new DurableAgentRuntime({
      store, kernels: [kernel], defaultKernel: 'pi', observe: (event) => { observations.push(event); },
    });
    const handle = await runtime.run({ identity, sessionId: 'session-observe', input: [] });

    await expect(handle.result()).resolves.toMatchObject({ status: 'waiting' });
    const events = await store.events.list({ tenantId: identity.tenantId, runId: handle.runId });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event).toMatchObject({
        tenantId: identity.tenantId,
        runId: handle.runId,
        attemptId: expect.any(String),
        turnNo: 1,
        kernel: 'pi',
        kernelVersion: '0.82.1',
        correlationId: identity.correlationId,
      });
    }
    const controlDetails = JSON.stringify(events.map((event) => event.detail));
    for (const secret of [
      'private-model-text', 'private-model-thinking', 'private-tool-argument',
      'private-tool-result', 'private-committed-text',
    ]) expect(controlDetails).not.toContain(secret);
    expect(observations).toContainEqual(expect.objectContaining({
      type: 'waiting', status: 'waiting', detail: { reason: 'question' },
    }));
  });

  it('emits structured counters and timers for runtime lifecycle and SSE replay', async () => {
    const store = new MemoryRuntimeStore();
    const observations: RuntimeObservation[] = [];
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (input, control) => {
        await control.emit({
          type: 'tool_call',
          call: { id: 'call-a', logicalCallId: 'logical-a', name: 'lookup', arguments: {} },
        });
        await control.emit({ type: 'tool_result', result: { callId: 'call-a', content: 'ok' } });
        await control.emit({
          type: 'context_compacted', tokensBefore: 100, tokensAfter: 50, summarizedMessages: 5, version: 1,
        });
        return {
          outcome: 'recovery_required', turnNo: input.turnNo, stopReason: 'tool',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          messages: [], error: { code: 'TOOL_RESULT_UNKNOWN', message: 'manual recovery', retryable: false },
        };
      },
    };
    const runtime = new DurableAgentRuntime({
      store, kernels: [kernel], defaultKernel: 'pi', observe: async (event) => { observations.push(event); },
    });
    const handle = await runtime.run({ identity, sessionId: 'session-observe', input: [] });
    const stream = (async () => {
      const replayed = [];
      for await (const event of handle.events) replayed.push(event);
      return replayed;
    })();

    await expect(handle.result()).resolves.toMatchObject({ status: 'recovery_required' });
    expect((await stream).length).toBeGreaterThan(0);
    const types = observations.map((event) => event.type);
    for (const type of [
      'run_started', 'attempt_started', 'turn_started', 'tool_call', 'tool_result',
      'context_compacted', 'turn_committed', 'recovery_required', 'attempt_finished',
      'run_finished', 'sse_replay',
    ]) expect(types).toContain(type);
    expect(observations).toContainEqual(expect.objectContaining({
      type: 'turn_committed', metric: expect.objectContaining({ kind: 'timer', unit: 'ms' }),
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      type: 'sse_replay', metric: expect.objectContaining({ kind: 'counter', value: expect.any(Number) }),
    }));
    for (const observation of observations) {
      expect(observation).toMatchObject({
        tenantId: identity.tenantId,
        runId: handle.runId,
        attemptId: expect.any(String),
        turnNo: expect.any(Number),
        kernel: 'pi',
        kernelVersion: '0.82.1',
        correlationId: identity.correlationId,
      });
    }
  });

  it('observes lease loss as a structured counter', async () => {
    const store = new MemoryRuntimeStore();
    const observations: RuntimeObservation[] = [];
    const assertLease = vi.spyOn(store.runs, 'assertLease').mockRejectedValueOnce(
      new AgentPlatformError({ code: 'LEASE_LOST', message: 'lease lost', retryable: false }),
    );
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: vi.fn(),
    };
    const runtime = new DurableAgentRuntime({
      store, kernels: [kernel], defaultKernel: 'pi', observe: (event) => { observations.push(event); },
    });
    const handle = await runtime.run({ identity, sessionId: 'session-observe', input: [] });

    await expect(handle.result()).resolves.toMatchObject({ status: 'failed' });
    expect(assertLease).toHaveBeenCalled();
    expect(kernel.run).not.toHaveBeenCalled();
    expect(observations).toContainEqual(expect.objectContaining({
      type: 'lease_lost', metric: { kind: 'counter', name: 'runtime.lease_lost', value: 1 },
    }));
  });

  it('does not persist provider error text that may echo model content', async () => {
    const store = new MemoryRuntimeStore();
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async () => { throw new Error('provider echoed private-model-prompt'); },
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const handle = await runtime.run({ identity, sessionId: 'session-observe', input: [] });

    await expect(handle.result()).resolves.toMatchObject({
      status: 'failed', error: { code: 'MODEL_PROVIDER_ERROR', message: 'Agent execution failed' },
    });
    const events = await store.events.list({ tenantId: identity.tenantId, runId: handle.runId });
    expect(JSON.stringify(events.map((event) => event.detail))).not.toContain('private-model-prompt');
  });
});
