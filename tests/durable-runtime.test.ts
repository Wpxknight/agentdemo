import { describe, expect, it, vi } from 'vitest';
import type { AgentKernel, KernelExit } from '@aiop/agent-runtime-core';
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
  it('renews its lease while a kernel turn runs longer than the lease TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    try {
      const store = new MemoryRuntimeStore();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const kernel: AgentKernel = {
        descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
        run: async () => {
          markStarted();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return completed('long-running turn');
        },
      };
      const runtime = new DurableAgentRuntime({
        store,
        kernels: [kernel],
        defaultKernel: 'pi',
        leaseTtlMs: 30,
      });
      const handle = await runtime.run({ identity, sessionId: 'session-long-turn', input: [] });
      await started;
      await vi.advanceTimersByTimeAsync(100);

      await expect(handle.result()).resolves.toMatchObject({
        status: 'succeeded',
        text: 'long-running turn',
      });
    } finally {
      vi.useRealTimers();
    }
  });

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

  it.each(['approval', 'question', 'plan'] as const)(
    'commits a pending %s interaction and resolves it from a fresh Runtime attempt',
    async (kind) => {
      const store = new MemoryRuntimeStore();
      const interactionId = `${kind}-interaction`;
      const resumedInputs: Parameters<AgentKernel['run']>[0][] = [];
      const firstKernel: AgentKernel = {
        descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
        run: async (input) => ({
          ...completed('waiting'),
          outcome: 'waiting',
          waitingReason: kind,
          interactionUpdates: [{
            tenantId: input.identity.tenantId,
            runId: input.runId,
            id: interactionId,
            userId: input.identity.actorId,
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            turnNo: input.turnNo,
            kind,
            toolCallId: `${kind}-call`,
            status: 'pending',
            payload: { prompt: `${kind} required` },
            expiresAt: new Date('2026-07-28T00:00:00.000Z'),
            createdAt: new Date('2026-07-27T00:00:00.000Z'),
          }],
        }),
      };
      const firstRuntime = new DurableAgentRuntime({ store, kernels: [firstKernel], defaultKernel: 'pi' });
      const first = await firstRuntime.run({ identity, sessionId: 'session-a', input: [{ role: 'user', text: 'hello' }] });
      expect((await first.result()).status).toBe('waiting');
      await expect(store.interactions.get({
        tenantId: identity.tenantId, runId: first.runId, interactionId,
      })).resolves.toMatchObject({ kind, status: 'pending' });

      const resumedKernel: AgentKernel = {
        ...firstKernel,
        run: async (input) => {
          resumedInputs.push(input);
          return completed('resumed');
        },
      };
      const resumedRuntime = new DurableAgentRuntime({ store, kernels: [resumedKernel], defaultKernel: 'pi' });
      await expect(resumedRuntime.resume({ identity, runId: first.runId }))
        .rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
      const resumed = await resumedRuntime.resume({
        identity,
        runId: first.runId,
        resolution: { interactionId, value: { approved: true } },
      });
      expect((await resumed.result()).status).toBe('succeeded');
      await expect(store.interactions.get({
        tenantId: identity.tenantId, runId: first.runId, interactionId,
      })).resolves.toMatchObject({ status: 'resolved', resolution: { approved: true } });
      expect(resumedInputs[0]).toMatchObject({
        sessionId: 'session-a',
        interactionResolution: {
          interactionId,
          kind,
          toolCallId: `${kind}-call`,
          value: { approved: true },
        },
      });
      expect(await store.attempts.list({ tenantId: identity.tenantId, runId: first.runId })).toHaveLength(2);
    },
  );

  it('resumes an interaction already resolved by the product store when the value matches', async () => {
    const store = new MemoryRuntimeStore();
    const firstKernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (input) => ({
        ...completed('waiting'), outcome: 'waiting', waitingReason: 'approval',
        interactionUpdates: [{
          tenantId: input.identity.tenantId, runId: input.runId, id: 'approval-resolved',
          userId: input.identity.actorId, sessionId: input.sessionId, attemptId: input.attemptId,
          turnNo: input.turnNo, kind: 'approval', toolCallId: 'call-resolved', status: 'pending',
          payload: { reason: 'production write' }, expiresAt: new Date('2026-07-28T00:00:00.000Z'),
          createdAt: new Date('2026-07-27T00:00:00.000Z'),
        }],
      }),
    };
    const firstRuntime = new DurableAgentRuntime({ store, kernels: [firstKernel], defaultKernel: 'pi' });
    const first = await firstRuntime.run({ identity, sessionId: 'session-a', input: [] });
    await first.result();
    const interaction = await store.interactions.get({
      tenantId: identity.tenantId, runId: first.runId, interactionId: 'approval-resolved',
    });
    await store.interactions.put({
      ...interaction!, status: 'resolved', resolution: true, resolvedBy: 'approver-a',
      resolvedAt: new Date('2026-07-27T01:00:00.000Z'),
    });
    const originalCommit = await store.turns.getLastCommitted({ tenantId: identity.tenantId, runId: first.runId });
    const resumedKernel: AgentKernel = { ...firstKernel, run: vi.fn(async () => completed('resumed')) };
    const resumedRuntime = new DurableAgentRuntime({ store, kernels: [resumedKernel], defaultKernel: 'pi' });

    const resumed = await resumedRuntime.resume({
      identity, runId: first.runId, resolution: { interactionId: 'approval-resolved', value: true },
    });

    await expect(resumed.result()).resolves.toMatchObject({ status: 'succeeded' });
    expect(resumedKernel.run).toHaveBeenCalledWith(expect.objectContaining({
      interactionResolution: expect.objectContaining({
        interactionId: 'approval-resolved', kind: 'approval', toolCallId: 'call-resolved', value: true,
      }),
    }), expect.anything());
    expect((await store.turns.listCommitted({ tenantId: identity.tenantId, runId: first.runId }))[0])
      .toEqual(originalCommit);
  });

  it('rejects a conflicting value for an interaction already resolved by the product store', async () => {
    const store = new MemoryRuntimeStore();
    const firstKernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (input) => ({
        ...completed('waiting'), outcome: 'waiting', waitingReason: 'approval',
        interactionUpdates: [{
          tenantId: input.identity.tenantId, runId: input.runId, id: 'approval-conflict',
          userId: input.identity.actorId, sessionId: input.sessionId, attemptId: input.attemptId,
          turnNo: input.turnNo, kind: 'approval', toolCallId: 'call-conflict', status: 'pending', payload: {},
          expiresAt: new Date('2026-07-28T00:00:00.000Z'), createdAt: new Date('2026-07-27T00:00:00.000Z'),
        }],
      }),
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [firstKernel], defaultKernel: 'pi' });
    const first = await runtime.run({ identity, sessionId: 'session-a', input: [] });
    await first.result();
    const interaction = await store.interactions.get({
      tenantId: identity.tenantId, runId: first.runId, interactionId: 'approval-conflict',
    });
    await store.interactions.put({ ...interaction!, status: 'resolved', resolution: true, resolvedAt: new Date() });

    await expect(runtime.resume({
      identity, runId: first.runId, resolution: { interactionId: 'approval-conflict', value: false },
    })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' });
  });

  it('commits transcript, usage, interaction, and final ledger facts in one Turn commit', async () => {
    const store = new MemoryRuntimeStore();
    const now = new Date('2026-07-27T00:00:00.000Z');
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (input) => ({
        ...completed('tool completed'),
        ledgerUpdates: [{
          tenantId: input.identity.tenantId, runId: input.runId, attemptId: input.attemptId, turnNo: input.turnNo,
          logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'write', argsDigest: 'args',
          capability: 'retryable_write', idempotencyKey: 'key-a', status: 'completed',
          result: { callId: 'call-a', content: 'created' }, resultDigest: 'result', createdAt: now, updatedAt: now,
        }],
      }),
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const handle = await runtime.run({ identity, sessionId: 'session-a', input: [] });
    expect((await handle.result()).status).toBe('succeeded');
    await expect(store.toolLedger.get({
      tenantId: identity.tenantId, runId: handle.runId, logicalCallId: 'logical-a',
    })).resolves.toMatchObject({ status: 'completed', result: { content: 'created' } });
  });

  it('commits every model turn before continuing within the same attempt', async () => {
    const store = new MemoryRuntimeStore();
    const inputs: Array<{ turnNo: number; continuation: boolean }> = [];
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (input) => {
        inputs.push({ turnNo: input.turnNo, continuation: Boolean(input.continuation) });
        if (input.turnNo === 1) {
          return {
            outcome: 'continue', turnNo: 1, usage,
            messages: [
              ...input.messages,
              { role: 'assistant', content: [], toolCalls: [{ id: 'call-1', logicalCallId: 'logical-1', name: 'lookup', arguments: {} }] },
              { role: 'tool', results: [{ callId: 'call-1', content: 'value=7' }] },
            ],
          };
        }
        return {
          ...completed('done'), turnNo: 2,
          messages: [...input.messages, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
        };
      },
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const handle = await runtime.run({ identity, sessionId: 'session-a', input: [{ role: 'user', text: 'hello' }] });

    await expect(handle.result()).resolves.toMatchObject({
      status: 'succeeded',
      usage: { inputTokens: 2, outputTokens: 4 },
    });
    expect(inputs).toEqual([
      { turnNo: 1, continuation: false },
      { turnNo: 2, continuation: true },
    ]);
    const attempt = (await store.attempts.list({ tenantId: 'tenant-a', runId: handle.runId }))[0]!;
    expect(await store.turns.getSnapshot({ tenantId: 'tenant-a', runId: handle.runId, attemptId: attempt.attemptId, turnNo: 1 })).toBeTruthy();
    expect(await store.turns.getSnapshot({ tenantId: 'tenant-a', runId: handle.runId, attemptId: attempt.attemptId, turnNo: 2 })).toBeTruthy();
    expect((await store.turns.getLastCommitted({ tenantId: 'tenant-a', runId: handle.runId }))?.transcriptVersion).toBe(2n);
    expect((await store.events.list({ tenantId: 'tenant-a', runId: handle.runId })).filter((event) => event.type === 'turn_committed')).toHaveLength(2);
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

  it('commits the boundary turn and fails when the durable max-turn budget is exhausted', async () => {
    const store = new MemoryRuntimeStore();
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: vi.fn(async (input) => ({
        outcome: 'continue' as const, turnNo: input.turnNo, usage,
        messages: [...input.messages, { role: 'assistant', content: [{ type: 'text', text: 'more' }] }],
      })),
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const handle = await runtime.run({
      identity, sessionId: 'session-a', input: [{ role: 'user', text: 'loop' }], limits: { maxTurns: 1 },
    });

    await expect(handle.result()).resolves.toMatchObject({
      status: 'failed', error: { code: 'RUN_LIMIT_EXCEEDED', message: 'Run maxTurns exceeded: 1' },
    });
    expect(kernel.run).toHaveBeenCalledOnce();
    expect(await store.turns.listCommitted({ tenantId: 'tenant-a', runId: handle.runId })).toHaveLength(1);
  });

  it('enforces maxToolCalls from durable events across a resumed attempt', async () => {
    const store = new MemoryRuntimeStore();
    const firstKernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (_input, control) => {
        await control.emit({
          type: 'tool_call', call: { id: 'call-1', logicalCallId: 'logical-1', name: 'lookup', arguments: {} },
        });
        return { ...completed('waiting'), outcome: 'waiting', waitingReason: 'question' };
      },
    };
    const firstRuntime = new DurableAgentRuntime({ store, kernels: [firstKernel], defaultKernel: 'pi' });
    const first = await firstRuntime.run({
      identity, sessionId: 'session-a', input: [], limits: { maxToolCalls: 1 },
    });
    expect((await first.result()).status).toBe('waiting');

    const resumedKernel: AgentKernel = {
      ...firstKernel,
      run: async (_input, control) => {
        await control.emit({
          type: 'tool_call', call: { id: 'call-2', logicalCallId: 'logical-2', name: 'lookup', arguments: {} },
        });
        return completed();
      },
    };
    const resumedRuntime = new DurableAgentRuntime({ store, kernels: [resumedKernel], defaultKernel: 'pi' });
    const resumed = await resumedRuntime.resume({ identity, runId: first.runId });
    await expect(resumed.result()).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'RUN_LIMIT_EXCEEDED', message: 'Run maxToolCalls exceeded: 1' },
    });
  });

  it('rejects a second cross-process resume after the persisted maxAttempts budget is exhausted', async () => {
    const store = new MemoryRuntimeStore();
    const waitingKernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async () => ({ ...completed('waiting'), outcome: 'waiting', waitingReason: 'external' }),
    };
    const firstRuntime = new DurableAgentRuntime({ store, kernels: [waitingKernel], defaultKernel: 'pi' });
    const first = await firstRuntime.run({
      identity, sessionId: 'session-attempt-budget', input: [], limits: { maxAttempts: 2 },
    });
    expect((await first.result()).status).toBe('waiting');

    const resumedKernel: AgentKernel = { ...waitingKernel, run: vi.fn(waitingKernel.run) };
    const firstResumeRuntime = new DurableAgentRuntime({ store, kernels: [resumedKernel], defaultKernel: 'pi' });
    const firstResume = await firstResumeRuntime.resume({ identity, runId: first.runId });
    expect((await firstResume.result()).status).toBe('waiting');
    expect(resumedKernel.run).toHaveBeenCalledOnce();

    const exhaustedKernel: AgentKernel = { ...waitingKernel, run: vi.fn(waitingKernel.run) };
    const secondResumeRuntime = new DurableAgentRuntime({ store, kernels: [exhaustedKernel], defaultKernel: 'pi' });
    await expect(secondResumeRuntime.resume({ identity, runId: first.runId })).rejects.toMatchObject({
      code: 'RUN_LIMIT_EXCEEDED', message: 'Run maxAttempts exceeded: 2',
    });
    expect(exhaustedKernel.run).not.toHaveBeenCalled();
    expect(await store.attempts.list({ tenantId: identity.tenantId, runId: first.runId })).toHaveLength(2);
  });

  it.each([
    ['maxInputTokens', { maxInputTokens: 2 }, { ...usage, inputTokens: 3 }, 'Run maxInputTokens exceeded: 3 > 2'],
    ['maxOutputTokens', { maxOutputTokens: 1 }, usage, 'Run maxOutputTokens exceeded: 2 > 1'],
    ['maxCostUsd', { maxCostUsd: 0.01 }, { ...usage, costUsd: 0.02 }, 'Run maxCostUsd exceeded: 0.02 > 0.01'],
  ] as const)('fails with a committed turn when %s is exceeded', async (_name, limits, turnUsage, message) => {
    const store = new MemoryRuntimeStore();
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async () => ({ ...completed(), usage: turnUsage }),
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const handle = await runtime.run({ identity, sessionId: 'session-a', input: [], limits });

    await expect(handle.result()).resolves.toMatchObject({
      status: 'failed', error: { code: 'RUN_LIMIT_EXCEEDED', message },
    });
    expect(await store.turns.listCommitted({ tenantId: 'tenant-a', runId: handle.runId })).toHaveLength(1);
  });

  it('persists the deadline and enforces it after a cross-process resume', async () => {
    const store = new MemoryRuntimeStore();
    let now = new Date('2026-07-27T00:00:00.000Z');
    const deadlineAt = new Date('2026-07-27T00:00:10.000Z');
    const firstKernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async () => ({ ...completed('waiting'), outcome: 'waiting', waitingReason: 'question' }),
    };
    const firstRuntime = new DurableAgentRuntime({ store, kernels: [firstKernel], defaultKernel: 'pi', now: () => now });
    const first = await firstRuntime.run({
      identity, sessionId: 'session-a', input: [{ role: 'user', text: 'hello' }], limits: { deadlineAt },
    });
    expect((await first.result()).status).toBe('waiting');

    now = new Date('2026-07-27T00:00:11.000Z');
    const resumedKernel = { ...firstKernel, run: vi.fn(firstKernel.run) };
    const resumedRuntime = new DurableAgentRuntime({ store, kernels: [resumedKernel], defaultKernel: 'pi', now: () => now });
    const resumed = await resumedRuntime.resume({ identity, runId: first.runId });
    await expect(resumed.result()).resolves.toMatchObject({
      status: 'failed', error: { code: 'RUN_LIMIT_EXCEEDED', message: 'Run deadline exceeded' },
    });
    expect(resumedKernel.run).not.toHaveBeenCalled();
  });

  it('restores cumulative cost from the last Turn commit when the Run projection has no cost column', async () => {
    const store = new MemoryRuntimeStore();
    const firstKernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async () => ({
        ...completed('waiting'), outcome: 'waiting', waitingReason: 'question',
        usage: { ...usage, costUsd: 0.008 },
      }),
    };
    const firstRuntime = new DurableAgentRuntime({ store, kernels: [firstKernel], defaultKernel: 'pi' });
    const first = await firstRuntime.run({
      identity, sessionId: 'session-cost', input: [], limits: { maxCostUsd: 0.01 },
    });
    expect((await first.result()).status).toBe('waiting');

    const runIdentity = { tenantId: identity.tenantId, runId: first.runId };
    const projected = await store.runs.get(runIdentity);
    await store.runs.update(runIdentity, { usage: { ...projected!.usage, costUsd: undefined } });
    const resumedKernel: AgentKernel = {
      ...firstKernel,
      run: async () => ({ ...completed(), usage: { ...usage, costUsd: 0.005 } }),
    };
    const resumedRuntime = new DurableAgentRuntime({ store, kernels: [resumedKernel], defaultKernel: 'pi' });
    const resumed = await resumedRuntime.resume({ identity, runId: first.runId });

    await expect(resumed.result()).resolves.toMatchObject({
      status: 'failed',
      usage: { costUsd: 0.013 },
      error: { code: 'RUN_LIMIT_EXCEEDED', message: 'Run maxCostUsd exceeded: 0.013 > 0.01' },
    });
  });

  it('aborts and awaits all active runs during shutdown', async () => {
    const store = new MemoryRuntimeStore();
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: (input) => new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      }),
    };
    const runtime = new DurableAgentRuntime({ store, kernels: [kernel], defaultKernel: 'pi' });
    const first = await runtime.run({ identity, sessionId: 'session-a', input: [] });
    const second = await runtime.run({ identity, sessionId: 'session-b', input: [] });

    await runtime.shutdown('worker shutdown');
    await expect(Promise.all([first.result(), second.result()])).resolves.toEqual([
      expect.objectContaining({ status: 'cancelled' }), expect.objectContaining({ status: 'cancelled' }),
    ]);
  });

  it('keeps streaming deltas live-only and bounds durable control events per turn', async () => {
    const store = new MemoryRuntimeStore();
    const observed: string[] = [];
    const kernel: AgentKernel = {
      descriptor: { name: 'pi', version: '0.82.1', protocolVersion: '1' },
      run: async (_input, control) => {
        await control.emit({ type: 'text_delta', text: 'secret-text' });
        await control.emit({ type: 'thinking_delta', text: 'secret-thinking' });
        await control.emit({ type: 'usage', usage });
        return completed();
      },
    };
    const runtime = new DurableAgentRuntime({
      store, kernels: [kernel], defaultKernel: 'pi', observeEvent: (event) => { observed.push(event.type); },
    });
    const handle = await runtime.run({ identity, sessionId: 'session-a', input: [] });
    expect((await handle.result()).status).toBe('succeeded');
    const events = await store.events.list({ tenantId: 'tenant-a', runId: handle.runId });
    expect(observed).toEqual(['text_delta', 'thinking_delta', 'usage']);
    expect(events.map((event) => event.type)).not.toContain('text_delta');
    expect(events.map((event) => event.type)).not.toContain('thinking_delta');
    expect(JSON.stringify(events.map((event) => event.detail))).not.toContain('secret-text');
    expect(JSON.stringify(events.map((event) => event.detail))).not.toContain('secret-thinking');

    const overflowingKernel: AgentKernel = {
      ...kernel,
      run: async (_input, control) => {
        await control.emit({ type: 'usage', usage });
        await control.emit({ type: 'usage', usage });
        return completed();
      },
    };
    const bounded = new DurableAgentRuntime({
      store: new MemoryRuntimeStore(), kernels: [overflowingKernel], defaultKernel: 'pi', maxDurableEventsPerTurn: 1,
    });
    const overflow = await bounded.run({ identity, sessionId: 'session-c', input: [] });
    await expect(overflow.result()).resolves.toMatchObject({
      status: 'failed', error: { code: 'RUN_LIMIT_EXCEEDED', message: 'Durable event limit exceeded: 1' },
    });
  });
});
