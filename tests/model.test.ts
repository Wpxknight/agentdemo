import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../src/model/anthropic.js';
import { toOpenAIMessages } from '../src/model/openai.js';
import type { Msg } from '../src/model/types.js';

const convo: Msg[] = [
  { role: 'user', text: 'hi' },
  {
    role: 'assistant',
    text: 'let me check',
    toolCalls: [{ id: 'c1', name: 'echo', args: { v: 1 } }],
  },
  { role: 'tool', toolResults: [{ id: 'c1', content: 'ok' }] },
];

describe('toAnthropicMessages', () => {
  it('maps tool calls to tool_use and results to user tool_result blocks', () => {
    const out = toAnthropicMessages(convo);
    expect(out[0]).toEqual({ role: 'user', content: 'hi' });

    const assistant = out[1];
    expect(assistant.role).toBe('assistant');
    const blocks = assistant.content as Array<{ type: string }>;
    expect(blocks[0]).toEqual({ type: 'text', text: 'let me check' });
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'echo' });

    const toolMsg = out[2];
    expect(toolMsg.role).toBe('user');
    const trBlocks = toolMsg.content as Array<{ type: string; tool_use_id: string }>;
    expect(trBlocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' });
  });
});

describe('toOpenAIMessages', () => {
  it('puts system first and maps tool calls/results', () => {
    const out = toOpenAIMessages('SYS', convo);
    expect(out[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });

    const assistant = out[2] as { role: string; tool_calls?: unknown[] };
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toHaveLength(1);

    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });

  it('omits system message when empty', () => {
    const out = toOpenAIMessages('', [{ role: 'user', text: 'hi' }]);
    expect(out[0]).toEqual({ role: 'user', content: 'hi' });
  });
});
