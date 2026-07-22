import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/services/prompt.js';
import { runModelTurn } from '../src/agent/services/model-gateway.js';
import type { ChatModel, StreamEvent } from '../src/model/types.js';
import { ToolRegistry } from '../src/agent/tools.js';

describe('PromptService', () => {
  it('combines guardrails, unattended guidance, and caller instructions in stable order', () => {
    const prompt = buildSystemPrompt('caller instructions', true);

    expect(prompt).toContain('默认中文回复');
    expect(prompt).toContain('无人值守运行说明');
    expect(prompt).toContain('caller instructions');
    expect(prompt.indexOf('默认中文回复')).toBeLessThan(prompt.indexOf('无人值守运行说明'));
    expect(prompt.indexOf('无人值守运行说明')).toBeLessThan(prompt.indexOf('caller instructions'));
  });
});

describe('ModelGateway', () => {
  it('retries a partial stream, emits rollback metadata, and retains all usage', async () => {
    let attempt = 0;
    const events: StreamEvent[] = [];
    const model: ChatModel = {
      id: 'gateway-retry',
      async *stream(input): AsyncIterable<StreamEvent> {
        expect(input.tools.map((tool) => tool.name)).toEqual(['visible']);
        attempt++;
        if (attempt === 1) {
          yield { type: 'usage', inputTokens: 3, outputTokens: 1, cacheReadTokens: 2 };
          yield { type: 'thinking_delta', text: 'old-thinking' };
          yield { type: 'thinking_block', thinking: 'old-thinking', signature: 'old-signature' };
          yield { type: 'text_delta', text: 'old-text' };
          yield { type: 'tool_call', call: { id: 'old-call', name: 'visible', args: {} } };
          throw new Error('partial stream failed');
        }
        yield { type: 'usage', inputTokens: 5, outputTokens: 4, cacheCreationTokens: 6 };
        yield { type: 'thinking_delta', text: 'new-thinking' };
        yield { type: 'thinking_block', thinking: 'new-thinking', signature: 'new-signature' };
        yield { type: 'text_delta', text: 'new-text' };
        yield { type: 'tool_call', call: { id: 'new-call', name: 'visible', args: { ok: true } } };
        yield { type: 'stop', reason: 'tool_use' };
      },
    };
    const tools = new ToolRegistry();
    tools.register({
      def: { name: 'visible', description: 'visible', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'unused' }),
    });
    tools.register({
      def: { name: 'hidden', description: 'hidden', inputSchema: { type: 'object' } },
      run: async () => ({ id: '', content: 'unused' }),
    });

    const turn = await runModelTurn({
      model,
      system: 'system',
      messages: [{ role: 'user', text: 'go' }],
      toolDefs: tools.defs(),
      filterToolDefs: (defs) => defs.filter((tool) => tool.name === 'visible'),
      modelRetryDelayMs: 0,
      onEvent: (event) => events.push(event),
    });

    expect(turn).toEqual({
      text: 'new-text',
      thinking: 'new-thinking',
      thinkingBlocks: [{ thinking: 'new-thinking', signature: 'new-signature' }],
      calls: [{ id: 'new-call', name: 'visible', args: { ok: true } }],
      usage: {
        inputTokens: 8,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheCreationTokens: 6,
      },
    });
    expect(events.find((event) => event.type === 'model_retry')).toEqual({
      type: 'model_retry',
      attempt: 1,
      maxAttempts: 10,
      error: 'partial stream failed',
      discardTextChars: 'old-text'.length,
      discardThinkingChars: 'old-thinking'.length,
      discardToolIds: ['old-call'],
    });
  });
});
