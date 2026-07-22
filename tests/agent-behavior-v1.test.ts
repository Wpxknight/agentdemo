import { describe, expect, it, vi } from 'vitest';
import type { AgentKernel } from '../src/agent/kernel.js';
import { LegacyAgentKernel } from '../src/agent/legacy-kernel.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';
import { HookRunner } from '../src/agent/hooks.js';
import type { ChatModel, Msg, StreamEvent } from '../src/model/types.js';

function agentBehaviorV1(name: string, createKernel: () => AgentKernel): void {
  describe(`agent-behavior-v1: ${name}`, () => {
    it('preserves Anthropic thinking blocks and signatures across a tool turn', async () => {
      const tools = new ToolRegistry();
      tools.register({
        def: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
        run: async () => ({ id: '', content: 'tool-ok' }),
      });
      let turn = 0;
      const model: ChatModel = {
        id: 'thinking-signature',
        async *stream(input) {
          turn++;
          if (turn === 1) {
            yield { type: 'thinking_delta', text: '先分析。' };
            yield { type: 'thinking_block', thinking: '先分析。', signature: 'sig-v1' };
            yield { type: 'tool_call', call: { id: 'call-1', name: 'echo', args: {} } };
            yield { type: 'stop', reason: 'tool_use' };
            return;
          }
          const assistant = input.messages.find((message) => message.role === 'assistant');
          expect(assistant?.thinking).toBe('先分析。');
          expect(assistant?.thinkingBlocks).toEqual([{ thinking: '先分析。', signature: 'sig-v1' }]);
          yield { type: 'text_delta', text: '完成' };
          yield { type: 'stop', reason: 'end_turn' };
        },
      };

      const result = await createKernel().run({
        model,
        tools,
        policy: new AllowAllPolicy(),
        ctx: { sessionId: 'behavior-thinking' },
        task: 'go',
      });

      expect(result.messages.find((message) => message.thinkingBlocks)?.thinkingBlocks)
        .toEqual([{ thinking: '先分析。', signature: 'sig-v1' }]);
      expect(result.text).toBe('完成');
    });

    it('preserves retry rollback events and usage from failed attempts', async () => {
      let attempt = 0;
      const events: StreamEvent[] = [];
      const model: ChatModel = {
        id: 'retry-contract',
        async *stream() {
          attempt++;
          if (attempt === 1) {
            yield { type: 'usage', inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 };
            yield { type: 'thinking_delta', text: 'discard-thinking' };
            yield { type: 'text_delta', text: 'discard-text' };
            yield { type: 'tool_call', call: { id: 'discard-tool', name: 'missing', args: {} } };
            throw new Error('stream interrupted');
          }
          yield { type: 'usage', inputTokens: 11, outputTokens: 5, cacheCreationTokens: 4 };
          yield { type: 'text_delta', text: 'final' };
          yield { type: 'stop', reason: 'end_turn' };
        },
      };

      const result = await createKernel().run({
        model,
        tools: new ToolRegistry(),
        policy: new AllowAllPolicy(),
        ctx: { sessionId: 'behavior-retry' },
        task: 'go',
        modelRetryDelayMs: 0,
        onEvent: (event) => events.push(event),
      });

      expect(events.find((event) => event.type === 'model_retry')).toEqual({
        type: 'model_retry',
        attempt: 1,
        maxAttempts: 10,
        error: 'stream interrupted',
        discardTextChars: 'discard-text'.length,
        discardThinkingChars: 'discard-thinking'.length,
        discardToolIds: ['discard-tool'],
      });
      expect(result.usage).toEqual({
        inputTokens: 18,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      });
      expect(result.text).toBe('final');
    });

    it('keeps Policy -> Approval -> Hook -> dispatch ordering', async () => {
      const order: string[] = [];
      const tools = new ToolRegistry();
      tools.register({
        def: { name: 'ordered', description: 'ordered', inputSchema: { type: 'object' } },
        run: async () => {
          order.push('dispatch');
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
      let turn = 0;
      const model: ChatModel = {
        id: 'ordered-tool',
        async *stream() {
          turn++;
          if (turn === 1) {
            yield { type: 'tool_call', call: { id: 'ordered-1', name: 'ordered', args: {} } };
          } else {
            yield { type: 'text_delta', text: 'done' };
          }
          yield { type: 'stop', reason: turn === 1 ? 'tool_use' : 'end_turn' };
        },
      };

      await createKernel().run({
        model,
        tools,
        policy: {
          async check() {
            order.push('policy');
            return { blocked: false, needApproval: true, reason: 'verify' };
          },
        },
        approval: {
          async request() {
            order.push('approval');
            return true;
          },
        },
        hooks,
        ctx: { sessionId: 'behavior-order' },
        task: 'go',
      });

      expect(order).toEqual(['policy', 'approval', 'hook', 'dispatch']);
    });

    it('drains pending messages only at model turn boundaries', async () => {
      const seen: Msg[][] = [];
      let turn = 0;
      const model: ChatModel = {
        id: 'pending-boundary',
        async *stream(input) {
          turn++;
          seen.push(input.messages.map((message) => ({ ...message })));
          yield { type: 'text_delta', text: turn === 1 ? 'first' : 'second' };
          yield { type: 'stop', reason: 'end_turn' };
        },
      };
      let drained = false;

      const result = await createKernel().run({
        model,
        tools: new ToolRegistry(),
        policy: new AllowAllPolicy(),
        ctx: { sessionId: 'behavior-pending' },
        task: 'original',
        drainPendingMessages: () => {
          if (drained) return [];
          drained = true;
          return [{ role: 'user', text: 'pending' }];
        },
      });

      expect(seen).toHaveLength(2);
      expect(seen[0]?.some((message) => message.text === 'pending')).toBe(false);
      expect(seen[1]?.some((message) => message.text === 'pending')).toBe(true);
      expect(result.messages.map((message) => [message.role, message.text])).toEqual([
        ['user', 'original'],
        ['assistant', 'first'],
        ['user', 'pending'],
        ['assistant', 'second'],
      ]);
    });

    it('preserves compaction events, user input, and keep-last image behavior', async () => {
      const image = { type: 'image' as const, mimeType: 'image/png', data: 'a'.repeat(800) };
      const history: Msg[] = [];
      for (let index = 0; index < 6; index++) {
        history.push({
          role: 'user',
          text: `question-${index}-${'x'.repeat(2000)}`,
          contentBlocks: [image],
        });
        history.push({ role: 'assistant', text: `answer-${index}-${'y'.repeat(2000)}` });
      }
      const events: StreamEvent[] = [];
      const summarize = vi.fn(async () => 'summary-v1');
      const model: ChatModel = {
        id: 'compaction-contract',
        async *stream(input) {
          const imageCount = input.messages.reduce(
            (count, message) => count + (message.contentBlocks?.filter((block) => block.type === 'image').length ?? 0),
            0,
          );
          expect(imageCount).toBe(1);
          expect(input.messages.some((message) => message.text?.includes('question-0'))).toBe(true);
          expect(input.messages.some((message) => message.text?.includes('summary-v1'))).toBe(true);
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'stop', reason: 'end_turn' };
        },
      };

      const result = await createKernel().run({
        model,
        tools: new ToolRegistry(),
        policy: new AllowAllPolicy(),
        ctx: { sessionId: 'behavior-compaction' },
        messages: history,
        task: 'continue',
        summarize,
        compactionTriggerTokens: 1_000,
        compactionKeepRecent: 2,
        keepImages: 1,
        onEvent: (event) => events.push(event),
      });

      expect(summarize).toHaveBeenCalledOnce();
      expect(result.compacted).toBe(true);
      expect(events.some((event) => event.type === 'context_compacted')).toBe(true);
    });

    it('propagates cancellation before a later tool can be dispatched', async () => {
      const abort = new AbortController();
      const dispatch = vi.fn(async () => ({ id: '', content: 'must-not-run' }));
      const tools = new ToolRegistry();
      tools.register({
        def: { name: 'dangerous', description: 'dangerous', inputSchema: { type: 'object' } },
        run: dispatch,
      });
      const model: ChatModel = {
        id: 'abort-contract',
        async *stream() {
          yield { type: 'text_delta', text: 'partial' };
          yield { type: 'tool_call', call: { id: 'late-call', name: 'dangerous', args: {} } };
        },
      };

      await expect(createKernel().run({
        model,
        tools,
        policy: new AllowAllPolicy(),
        ctx: { sessionId: 'behavior-abort' },
        task: 'go',
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === 'text_delta') abort.abort(new Error('cancelled-v1'));
        },
      })).rejects.toThrow('cancelled-v1');
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
}

agentBehaviorV1('legacy', () => new LegacyAgentKernel());
