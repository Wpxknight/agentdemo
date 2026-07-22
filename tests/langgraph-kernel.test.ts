import { describe, expect, it } from 'vitest';
import { LangGraphAgentKernel } from '../src/agent/langgraph/kernel.js';
import { agentBehaviorV1 } from './agent-behavior-v1.test.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import type { ChatModel } from '../src/model/types.js';
import { MemoryCheckpointStore, MysqlCheckpointSaver } from '../src/agent/checkpoint/mysql.js';
import { buildAskUserTool } from '../src/tools/ask-user.js';

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

  it('maps durable interaction waits to LangGraph interrupt and Command resume', async () => {
    const tools = new ToolRegistry();
    tools.register(buildAskUserTool());
    let turn = 0;
    const model: ChatModel = {
      id: 'interrupt-resume',
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield {
            type: 'tool_call',
            call: {
              id: 'ask-1',
              name: 'ask_user',
              args: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
            },
          };
          yield { type: 'stop', reason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'continued' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const created: Array<{ id: string; kind: string; payload: unknown }> = [];
    const kernel = new LangGraphAgentKernel({
      checkpointer: new MysqlCheckpointSaver(new MemoryCheckpointStore()),
    });

    const result = await kernel.run({
      runId: 'run-interrupt',
      model,
      tools,
      policy: new AllowAllPolicy(),
      ctx: { sessionId: 'session-a', tenantId: 'tenant-a', userId: 'user-a' },
      task: 'go',
      durableInteractions: {
        async create(input) {
          const record = { id: 'interaction-1', ...input };
          if (!created.length) created.push(record);
          return { id: record.id };
        },
        async wait(id) {
          expect(id).toBe('interaction-1');
          return { 'Continue?': ['Yes'] };
        },
      },
    });

    expect(created).toMatchObject([{ id: 'interaction-1', kind: 'question' }]);
    expect(result.text).toBe('continued');
    expect(result.messages.find((message) => message.role === 'tool')?.toolResults?.[0]?.content)
      .toContain('Yes');
  });

  it('uses durable approval interrupts before dispatching a protected tool', async () => {
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'change', description: 'change', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'changed' }),
    });
    let turn = 0;
    const model: ChatModel = {
      id: 'approval-interrupt',
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: 'change-1', name: 'change', args: {} } };
          yield { type: 'stop', reason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const kinds: string[] = [];
    const result = await new LangGraphAgentKernel({
      checkpointer: new MysqlCheckpointSaver(new MemoryCheckpointStore()),
    }).run({
      runId: 'run-approval',
      model,
      tools,
      policy: { check: async () => ({ blocked: false, needApproval: true, reason: 'prod' }) },
      ctx: { sessionId: 'session-a', tenantId: 'tenant-a', userId: 'user-a' },
      task: 'go',
      durableInteractions: {
        async create(input) {
          kinds.push(input.kind);
          return { id: 'approval-1' };
        },
        async wait() { return true; },
      },
    });

    expect(kinds).toContain('approval');
    expect(result.messages.find((message) => message.role === 'tool')?.toolResults?.[0]?.content).toBe('changed');
  });

  it('resumes an interrupted run from the persisted checkpoint after kernel restart', async () => {
    const saver = new MysqlCheckpointSaver(new MemoryCheckpointStore());
    const tools = new ToolRegistry();
    tools.register(buildAskUserTool());
    let turn = 0;
    const model: ChatModel = {
      id: 'restart-resume',
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield {
            type: 'tool_call',
            call: {
              id: 'ask-restart',
              name: 'ask_user',
              args: { questions: [{ question: 'Resume?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
            },
          };
          yield { type: 'stop', reason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'resumed' };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const base = {
      runId: 'run-restart', model, tools, policy: new AllowAllPolicy(),
      ctx: { sessionId: 'session-a', tenantId: 'tenant-a', userId: 'user-a' }, task: 'go',
    };
    await expect(new LangGraphAgentKernel({ checkpointer: saver }).run({
      ...base,
      durableInteractions: {
        create: async () => ({ id: 'interaction-restart' }),
        wait: async () => { throw new Error('simulated process loss'); },
      },
    })).rejects.toThrow('simulated process loss');

    const result = await new LangGraphAgentKernel({ checkpointer: saver }).run({
      ...base,
      durableInteractions: {
        create: async () => ({ id: 'interaction-restart' }),
        wait: async () => ({ 'Resume?': ['Yes'] }),
      },
    });

    expect(result.text).toBe('resumed');
    expect(turn).toBe(2);
  });
});
