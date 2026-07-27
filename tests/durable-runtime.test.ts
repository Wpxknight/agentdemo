import { describe, expect, it, vi } from 'vitest';
import type { AgentKernel, KernelExit } from '@aiop/agent-contracts';
import { DurableAgentRuntime } from '../packages/agent-runtime-core/src/runtime.js';
import { MemoryRuntimeStore } from '../packages/agent-runtime-core/src/memory-store.js';

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 };
const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] } as const;

function completed(text = 'done'): KernelExit {
  return {
    outcome: 'completed', turnNo: 1, usage, stopReason: 'end_turn',
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
  };
}

describe('DurableAgentRuntime', () => {
  it('creates a run, attempt, immutable snapshot and committed turn around a kernel', async () => {
    const store = new MemoryRuntimeStore();
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: vi.fn(async (_input, control) => {
        await control.emit({ type: 'text_delta', text: 'done' });
        return completed();
      }),
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const handle = await runtime.run({ identity, sessionId: 'session-a', input: [{ role: 'user', text: 'hello' }] });
    const result = await handle.result();

    expect(result.status).toBe('succeeded');
    expect(result.text).toBe('done');
    const record = await store.runs.get({ tenantId: 'tenant-a', runId: handle.runId });
    expect(record).toMatchObject({ status: 'succeeded', kernel: 'pi', kernelVersion: '0.82.1' });
    expect(await store.attempts.list({ tenantId: 'tenant-a', runId: handle.runId })).toHaveLength(1);
    expect((await store.turns.getLastCommitted({ tenantId: 'tenant-a', runId: handle.runId }))?.commitId).toBeTruthy();
  });

  it('resumes from only the last committed turn in a new attempt', async () => {
    const store = new MemoryRuntimeStore();
    let invocation = 0;
    const continuationFlags: boolean[] = [];
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (input) => {
        continuationFlags.push(Boolean(input.continuation));
        invocation++;
        return invocation === 1
          ? { ...completed('waiting'), outcome: 'waiting', waitingReason: 'question' }
          : completed('resumed');
      },
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const first = await runtime.run({ identity, sessionId: 'session-a', input: [{ role: 'user', text: 'hello' }] });
    expect((await first.result()).status).toBe('waiting');
    expect((await store.runs.get({ tenantId: 'tenant-a', runId: first.runId }))?.status).toBe('waiting');

    const resumed = await runtime.resume({ identity, runId: first.runId });
    expect((await resumed.result()).status).toBe('succeeded');
    expect(continuationFlags).toEqual([false, true]);
    expect(await store.attempts.list({ tenantId: 'tenant-a', runId: first.runId })).toHaveLength(2);
  });

  it('durably cancels and aborts an active kernel', async () => {
    const store = new MemoryRuntimeStore();
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: (_input) => new Promise((_resolve, reject) => {
        _input.signal?.addEventListener('abort', () => reject(_input.signal?.reason), { once: true });
      }),
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const handle = await runtime.run({ identity, sessionId: 'session-a', input: [{ role: 'user', text: 'hello' }] });
    await runtime.cancel({ identity, runId: handle.runId, reason: 'user request' });
    expect((await handle.result()).status).toBe('cancelled');
    expect((await store.runs.get({ tenantId: 'tenant-a', runId: handle.runId }))?.status).toBe('cancelled');
  });
});
