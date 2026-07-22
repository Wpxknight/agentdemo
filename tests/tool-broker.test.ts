import { describe, expect, it } from 'vitest';
import { executeToolCalls } from '../src/agent/services/tool-broker.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { HookRunner } from '../src/agent/hooks.js';
import type { StreamEvent } from '../src/model/types.js';

describe('ToolBroker', () => {
  it('enforces Policy -> Approval -> Hook -> dispatch and injects per-call callbacks', async () => {
    const order: string[] = [];
    const events: StreamEvent[] = [];
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'interactive', description: 'interactive', inputSchema: { type: 'object' } },
      run: async (_args, ctx) => {
        order.push('dispatch');
        ctx.onOutput?.({ stream: 'stdout', text: 'live' });
        ctx.emitEvent?.({ type: 'todo_updated', todos: [{ content: 'work', status: 'completed' }] });
        expect(await ctx.askUser?.([])).toEqual({ answer: ['yes'] });
        expect(await ctx.requestPlanApproval?.({
          summary: 'plan',
          changes: [{ action: 'update', target: 'service-a' }],
          impact: 'service-a',
          rollback: 'restore previous version',
        })).toBe(true);
        return { id: '', content: 'ok' };
      },
    });
    const hooks = new class extends HookRunner {
      override get empty(): boolean { return false; }
      override async preTool() {
        order.push('hook');
        return { denied: false };
      }
    }();

    const results = await executeToolCalls(
      [{ id: 'call-1', name: 'interactive', args: {} }],
      {
        tools,
        policy: {
          async check() {
            order.push('policy');
            return { blocked: false, needApproval: true, reason: 'approval-required' };
          },
        },
        approval: {
          async request() {
            order.push('approval');
            return true;
          },
        },
        hooks,
        ctx: { sessionId: 'tool-broker' },
        askUser: async () => ({ answer: ['yes'] }),
        requestPlanApproval: async () => true,
        onEvent: (event) => events.push(event),
      },
    );

    expect(order).toEqual(['policy', 'approval', 'hook', 'dispatch']);
    expect(results).toEqual([{ id: 'call-1', content: 'ok' }]);
    expect(events).toContainEqual({ type: 'tool_output', toolId: 'call-1', stream: 'stdout', text: 'live' });
    expect(events).toContainEqual({ type: 'tool_result', toolId: 'call-1', name: 'interactive', isError: false });
    expect(events.some((event) => event.type === 'todo_updated')).toBe(true);
  });

  it('runs calls concurrently but returns results in model call order', async () => {
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'delayed', description: 'delayed', inputSchema: { type: 'object' } },
      run: async (args) => {
        const input = args as { value: string; delay: number };
        await new Promise((resolve) => setTimeout(resolve, input.delay));
        return { id: '', content: input.value };
      },
    });

    const results = await executeToolCalls(
      [
        { id: 'slow', name: 'delayed', args: { value: 'first', delay: 10 } },
        { id: 'fast', name: 'delayed', args: { value: 'second', delay: 0 } },
      ],
      {
        tools,
        policy: { check: async () => ({ blocked: false }) },
        ctx: { sessionId: 'tool-order' },
      },
    );

    expect(results.map((result) => result.id)).toEqual(['slow', 'fast']);
    expect(results.map((result) => result.content)).toEqual(['first', 'second']);
  });
});
