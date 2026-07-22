import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { LangGraphAgentKernel } from '../src/agent/langgraph/kernel.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { AgentRunLifecycleObserver } from '../src/agent/run-coordinator.js';
import type { ChatModel } from '../src/model/types.js';

function observer(events: string[]): AgentRunLifecycleObserver {
  return {
    guard: async () => {},
    nodeStarted: async (node) => { events.push(`${node}:started`); },
    nodeCompleted: async (node) => { events.push(`${node}:completed`); },
    nodeFailed: async (node) => { events.push(`${node}:failed`); },
    waiting: async () => { events.push('run:waiting'); },
    running: async () => { events.push('run:running'); },
  };
}

describe('LangGraph run observation and recovery', () => {
  it('records ordered node lifecycle events around model and tools', async () => {
    let turn = 0;
    const model: ChatModel = {
      id: 'timeline',
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: 'echo-1', name: 'echo', args: {} } };
          return;
        }
        yield { type: 'text_delta', text: 'done' };
      },
    };
    const tools = new ToolRegistry().register({
      def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      run: async () => ({ id: 'echo-1', content: 'ok' }),
    });
    const events: string[] = [];
    const guard = vi.fn(async () => {});

    await new LangGraphAgentKernel().run({
      runId: 'timeline-run', model, tools, policy: new AllowAllPolicy(),
      ctx: { sessionId: 'timeline-session' }, task: 'go',
      runLifecycle: observer(events), runGuard: guard,
    });

    expect(events).toEqual([
      'prepare:started', 'prepare:completed',
      'model:started', 'model:completed',
      'tools:started', 'tools:completed',
      'model:started', 'model:completed',
    ]);
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('continues a failed run from its latest checkpoint without new initial input', async () => {
    const checkpointer = new MemorySaver();
    let fail = true;
    const model: ChatModel = {
      id: 'recover',
      async *stream() {
        if (fail) {
          const error = new Error('temporary upstream failure') as Error & { status: number };
          error.status = 400;
          throw error;
        }
        yield { type: 'text_delta', text: 'recovered' };
      },
    };
    const kernel = new LangGraphAgentKernel({ checkpointer });
    const base = {
      runId: 'recover-run', model, tools: new ToolRegistry(), policy: new AllowAllPolicy(),
      ctx: { sessionId: 'recover-session' }, task: 'original task', modelRetryDelayMs: 0,
    };

    await expect(kernel.run(base)).rejects.toThrow('temporary upstream failure');
    fail = false;
    const result = await kernel.run({ ...base, task: undefined, resumeFromCheckpoint: true });

    expect(result.text).toBe('recovered');
    expect(result.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(result.messages.find((message) => message.role === 'user')?.text).toBe('original task');
  });
});
