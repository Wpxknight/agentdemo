import { describe, expect, it } from 'vitest';
import { LangGraphAgentKernel } from '../src/agent/langgraph/kernel.js';
import { agentBehaviorV1 } from './agent-behavior-v1.test.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { ChatModel } from '../src/model/types.js';
import { MemoryCheckpointStore, MysqlCheckpointSaver } from '../src/agent/checkpoint/mysql.js';

agentBehaviorV1('langgraph', () => new LangGraphAgentKernel());

describe('LangGraphAgentKernel', () => {
  it('allocates one unique thread id per AIoP run', async () => {
    const allocated: string[] = [];
    const kernel = new LangGraphAgentKernel({
      threadIdFactory: () => {
        const id = `run-${allocated.length + 1}`;
        allocated.push(id);
        return id;
      },
    });
    const model: ChatModel = {
      id: 'single-turn',
      async *stream() {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const options = {
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 'session-a' },
      task: 'go',
    };

    await kernel.run(options);
    await kernel.run(options);

    expect(allocated).toEqual(['run-1', 'run-2']);
  });

  it('honors maxSteps for an endless tool loop', async () => {
    let turn = 0;
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'ok' }),
    });
    const model: ChatModel = {
      id: 'endless-tools',
      async *stream() {
        turn++;
        yield { type: 'tool_call', call: { id: `call-${turn}`, name: 'echo', args: {} } };
        yield { type: 'stop', reason: 'tool_use' };
      },
    };

    const result = await new LangGraphAgentKernel().run({
      model,
      tools,
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 'max-steps' },
      task: 'go',
      maxSteps: 3,
    });

    expect(result.steps).toBe(3);
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(3);
  });

  it('persists graph super-step checkpoints under the run thread id', async () => {
    const store = new MemoryCheckpointStore();
    const saver = new MysqlCheckpointSaver(store);
    const kernel = new LangGraphAgentKernel({ checkpointer: saver, threadIdFactory: () => 'tenant-a:run-checkpoint' });
    const model: ChatModel = {
      id: 'checkpointed',
      async *stream() {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };

    await kernel.run({
      model,
      tools: new ToolRegistry(),
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 'checkpointed', tenantId: 'tenant-a' },
      task: 'go',
    });

    const checkpoints = [];
    for await (const tuple of saver.list({ configurable: { thread_id: 'tenant-a:run-checkpoint' } })) {
      checkpoints.push(tuple);
    }
    expect(checkpoints.length).toBeGreaterThan(1);
    const persisted = await store.listCheckpoints({ threadId: 'tenant-a:run-checkpoint' });
    expect(persisted.every((checkpoint) => checkpoint.tenantId === 'tenant-a')).toBe(true);
    expect(persisted.every((checkpoint) => checkpoint.graphVersion === 'v1')).toBe(true);
  });
});
