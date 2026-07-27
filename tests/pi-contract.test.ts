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
import { PiAgentKernel } from '../packages/agent-kernel-pi/src/index.js';

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
});
