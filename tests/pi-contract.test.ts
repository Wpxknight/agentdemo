import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  agentLoop,
  agentLoopContinue,
  calculateContextTokens,
  estimateContextTokens,
  estimateTokens,
  formatSkillInvocation,
  loadSkills,
  loadSourcedSkills,
  prepareCompaction,
  shouldCompact,
  truncateHead,
  truncateLine,
  truncateTail,
} from '@earendil-works/pi-agent-core';
import type { ModelProvider, ToolRuntime } from '@aiop/agent-contracts';
import { DurableAgentRuntime, MemoryRuntimeStore } from '@aiop/agent-runtime-core';
import { PiAgentKernel, PiContextManager } from '../packages/agent-kernel-pi/src/index.js';

const usage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe('Pi public contract', () => {
  it('exposes every reviewed function from package roots', () => {
    for (const value of [
      agentLoop, agentLoopContinue, calculateContextTokens, estimateContextTokens, estimateTokens,
      formatSkillInvocation, loadSkills, loadSourcedSkills, prepareCompaction, shouldCompact,
      truncateHead, truncateLine, truncateTail,
    ]) expect(value).toBeTypeOf('function');
  });

  it('does not use Pi deep imports in the adapter', async () => {
    const source = await readFile(new URL('../packages/agent-kernel-pi/src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/pi-agent-core\//);
    expect(source).not.toMatch(/pi-ai\//);
  });

  it('runs model-tool-model through Pi while preserving awaited event order', async () => {
    let request = 0;
    const modelProvider: ModelProvider = {
      async *stream() {
        request++;
        if (request === 1) {
          yield { type: 'tool_call', call: { id: 'call-1', logicalCallId: 'logical-1', name: 'lookup', arguments: { id: 7 } } };
          yield { type: 'usage', usage };
          yield { type: 'stop', reason: 'toolUse' };
          return;
        }
        yield { type: 'text_delta', text: 'answer' };
        yield { type: 'usage', usage };
        yield { type: 'stop', reason: 'stop' };
      },
    };
    const toolRuntime: ToolRuntime = {
      execute: vi.fn(async (call) => ({ kind: 'result' as const, result: { callId: call.id, content: 'value=7' } })),
    };
    const kernel = new PiAgentKernel({ modelProvider, toolRuntime, systemPrompt: 'system' });
    const order: string[] = [];
    const exit = await kernel.run({
      runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'question' }] }],
      model: { provider: 'fake', model: 'fake-1' },
      tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object' }, capability: 'read' }],
    }, {
      emit: async (event) => { order.push(event.type); },
      guard: async () => undefined,
      shouldStopAfterTurn: async () => false,
    });

    expect(exit.outcome).toBe('completed');
    expect(toolRuntime.execute).toHaveBeenCalledOnce();
    expect(order.indexOf('tool_call')).toBeLessThan(order.indexOf('tool_result'));
    expect(order.at(-1)).toBe('turn_end');
    expect(exit.messages.at(-1)).toMatchObject({ role: 'assistant' });
  });

  it('returns continue at a durable turn boundary and resumes from committed messages', async () => {
    let request = 0;
    const modelProvider: ModelProvider = {
      async *stream() {
        request++;
        if (request === 1) {
          yield { type: 'tool_call', call: { id: 'call-1', logicalCallId: 'logical-1', name: 'lookup', arguments: {} } };
          yield { type: 'stop', reason: 'toolUse' };
          return;
        }
        yield { type: 'text_delta', text: 'resumed answer' };
        yield { type: 'stop', reason: 'stop' };
      },
    };
    const kernel = new PiAgentKernel({
      modelProvider,
      toolRuntime: { execute: async (call) => ({ kind: 'result', result: { callId: call.id, content: 'value=7' } }) },
    });
    const base = {
      runId: 'run-durable', attemptId: 'attempt-durable',
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      model: { provider: 'fake', model: 'fake-1' },
      tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object' }, capability: 'read' as const }],
    };
    const control = {
      emit: async () => undefined,
      guard: async () => undefined,
      shouldStopAfterTurn: async () => true,
    };

    const first = await kernel.run({
      ...base, turnNo: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'question' }] }],
    }, control);
    expect(first.outcome).toBe('continue');
    expect(first.messages.at(-1)).toMatchObject({ role: 'tool' });

    const second = await kernel.run({
      ...base, turnNo: 2, continuation: true, messages: first.messages,
    }, control);
    expect(second.outcome).toBe('completed');
    expect(second.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(request).toBe(2);
  });

  it('adds Pi compaction model usage to the kernel turn usage', async () => {
    const manager = new PiContextManager({
      complete: async () => ({
        text: 'compact summary',
        usage: {
          inputTokens: 13,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
          costUsd: 0.03,
        },
      }),
    });
    const kernel = new PiAgentKernel({
      modelProvider: {
        async *stream() {
          yield { type: 'text_delta', text: 'answer' };
          yield { type: 'usage', usage: {
            inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01,
          } };
          yield { type: 'stop', reason: 'stop' };
        },
      },
      toolRuntime: { execute: async () => { throw new Error('not used'); } },
      context: { manager, triggerTokens: 80, keepRecentMessages: 1 },
    });
    const exit = await kernel.run({
      runId: 'run-compaction-usage', attemptId: 'attempt-compaction-usage', turnNo: 1,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      messages: Array.from({ length: 6 }, (_, index) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: `old-${index} ${'x'.repeat(100)}` }],
      })),
      model: { provider: 'fake', model: 'fake-1' },
      tools: [],
    }, { emit: async () => undefined, guard: async () => undefined, shouldStopAfterTurn: async () => true });

    expect(exit.usage).toEqual({
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
      costUsd: 0.04,
    });
  });

  it('preserves committed compaction usage when a fresh Durable Runtime resumes the run', async () => {
    const store = new MemoryRuntimeStore();
    const identity = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] };
    const context = {
      manager: new PiContextManager({
        complete: async () => ({
          text: 'resume summary',
          usage: {
            inputTokens: 13, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1, costUsd: 0.03,
          },
        }),
      }),
      triggerTokens: 80,
      keepRecentMessages: 1,
    };
    const firstKernel = new PiAgentKernel({
      modelProvider: { async *stream() { throw new Error('first attempt failed'); } },
      toolRuntime: { execute: async () => { throw new Error('not used'); } },
      context,
    });
    const firstRuntime = new DurableAgentRuntime({
      store, kernels: [firstKernel], defaultKernel: 'pi', modelBinding: { provider: 'fake', model: 'fake-1' },
    });
    const first = await firstRuntime.run({
      runId: 'run-resume-compaction-usage', identity, sessionId: 'session-a', input: [],
      messages: Array.from({ length: 6 }, (_, index) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: `old-${index} ${'x'.repeat(100)}` }],
      })),
    });
    await expect(first.result()).resolves.toMatchObject({
      status: 'failed',
      usage: { inputTokens: 13, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1, costUsd: 0.03 },
    });

    const resumedKernel = new PiAgentKernel({
      modelProvider: {
        async *stream() {
          yield { type: 'text_delta', text: 'recovered' };
          yield { type: 'usage', usage: {
            inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01,
          } };
          yield { type: 'stop', reason: 'stop' };
        },
      },
      toolRuntime: { execute: async () => { throw new Error('not used'); } },
      context,
    });
    const resumedRuntime = new DurableAgentRuntime({
      store, kernels: [resumedKernel], defaultKernel: 'pi', modelBinding: { provider: 'fake', model: 'fake-1' },
    });
    const resumed = await resumedRuntime.resume({ identity, runId: 'run-resume-compaction-usage' });

    await expect(resumed.result()).resolves.toMatchObject({
      status: 'succeeded',
      usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 2, cacheCreationTokens: 1, costUsd: 0.04 },
    });
    expect(await store.attempts.list({ tenantId: identity.tenantId, runId: 'run-resume-compaction-usage' }))
      .toHaveLength(2);
  });

  it('never executes tool calls from a length-truncated assistant response', async () => {
    const modelProvider: ModelProvider = {
      async *stream() {
        yield { type: 'tool_call', call: { id: 'call-cut', logicalCallId: 'logical-cut', name: 'write', arguments: {} } };
        yield { type: 'stop', reason: 'length' };
      },
    };
    const toolRuntime: ToolRuntime = { execute: vi.fn() };
    const kernel = new PiAgentKernel({ modelProvider, toolRuntime });
    await kernel.run({
      runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
      model: { provider: 'fake', model: 'fake-1' },
      tools: [{ name: 'write', description: 'write', inputSchema: { type: 'object' }, capability: 'retryable_write' }],
    }, { emit: async () => undefined, guard: async () => undefined, shouldStopAfterTurn: async () => false });
    expect(toolRuntime.execute).not.toHaveBeenCalled();
  });

  it('stops the remaining write tools in a Turn after the first call enters waiting', async () => {
    const modelProvider: ModelProvider = {
      async *stream() {
        yield { type: 'tool_call', call: {
          id: 'call-wait', logicalCallId: 'logical-wait', name: 'write', arguments: { order: 1 },
        } };
        yield { type: 'tool_call', call: {
          id: 'call-blocked', logicalCallId: 'logical-blocked', name: 'write', arguments: { order: 2 },
        } };
        yield { type: 'stop', reason: 'toolUse' };
      },
    };
    const execute = vi.fn(async (call) => ({
      kind: 'waiting' as const,
      reason: 'approval' as const,
      interactionId: 'approval-a',
      ledgerUpdates: [{
        tenantId: 'tenant-a', runId: 'run-wait', attemptId: 'attempt-wait', turnNo: 1,
        logicalCallId: call.logicalCallId, toolCallId: call.id, toolName: call.name,
        argsDigest: 'args', capability: 'non_idempotent_write' as const, idempotencyKey: 'key',
        status: 'pending_approval' as const, createdAt: new Date(), updatedAt: new Date(),
      }],
    }));
    const kernel = new PiAgentKernel({ modelProvider, toolRuntime: { execute } });
    const exit = await kernel.run({
      runId: 'run-wait', attemptId: 'attempt-wait', turnNo: 1,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'write twice' }] }],
      model: { provider: 'fake', model: 'fake-1' },
      tools: [{ name: 'write', description: 'write', inputSchema: { type: 'object' }, capability: 'non_idempotent_write' }],
    }, { emit: async () => undefined, guard: async () => undefined, shouldStopAfterTurn: async () => false });

    expect(exit.outcome).toBe('waiting');
    expect(execute).toHaveBeenCalledOnce();
    expect(exit.ledgerUpdates).toHaveLength(1);
  });

  it('returns recovery_required with its final ledger fact instead of converting it to a model failure', async () => {
    const now = new Date();
    const kernel = new PiAgentKernel({
      modelProvider: {
        async *stream() {
          yield { type: 'tool_call', call: {
            id: 'call-a', logicalCallId: 'logical-a', name: 'create', arguments: {},
          } };
          yield { type: 'stop', reason: 'toolUse' };
        },
      },
      toolRuntime: {
        execute: async () => ({
          kind: 'recovery_required', message: 'external result unknown',
          ledgerUpdates: [{
            tenantId: 'tenant-a', runId: 'run-recovery', attemptId: 'attempt-recovery', turnNo: 1,
            logicalCallId: 'logical-a', toolCallId: 'call-a', toolName: 'create', argsDigest: 'args',
            capability: 'non_idempotent_write', idempotencyKey: 'key', status: 'recovery_required',
            createdAt: now, updatedAt: now,
          }],
        }),
      },
    });
    const exit = await kernel.run({
      runId: 'run-recovery', attemptId: 'attempt-recovery', turnNo: 1,
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'create' }] }],
      model: { provider: 'fake', model: 'fake-1' },
      tools: [{ name: 'create', description: 'create', inputSchema: { type: 'object' }, capability: 'non_idempotent_write' }],
    }, { emit: async () => undefined, guard: async () => undefined, shouldStopAfterTurn: async () => false });

    expect(exit).toMatchObject({
      outcome: 'recovery_required',
      error: { code: 'TOOL_RESULT_UNKNOWN', message: 'external result unknown' },
      ledgerUpdates: [expect.objectContaining({ status: 'recovery_required' })],
    });
  });
});
