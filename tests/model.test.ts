import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../src/model/anthropic.js';
import { normalizeOpenAIBaseURL, toOpenAIMessages } from '../src/model/openai.js';
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

  it('replays thinking blocks first with signature so tool-use turns do not 400', () => {
    const out = toAnthropicMessages([
      {
        role: 'assistant',
        text: 'checking',
        thinkingBlocks: [{ thinking: 'reasoning…', signature: 'sig-abc' }],
        toolCalls: [{ id: 'c1', name: 'echo', args: {} }],
      },
    ]);
    const blocks = out[0].content as Array<{ type: string; signature?: string }>;
    // 思考块必须在最前，且带回签名
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'reasoning…', signature: 'sig-abc' });
    expect(blocks[1]).toMatchObject({ type: 'text' });
    expect(blocks[2]).toMatchObject({ type: 'tool_use' });
  });

  it('drops thinking blocks lacking a signature (cannot be replayed)', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', text: 'hi', thinkingBlocks: [{ thinking: 'x', signature: '' }] },
    ]);
    const blocks = out[0].content as Array<{ type: string }>;
    expect(blocks.every((b) => b.type !== 'thinking')).toBe(true);
  });

  it('maps tool image results to Anthropic image content blocks', () => {
    const out = toAnthropicMessages([
      {
        role: 'tool',
        toolResults: [
          {
            id: 'c1',
            content: 'screenshot',
            contentBlocks: [
              { type: 'text', text: 'screenshot' },
              { type: 'image', mimeType: 'image/png', data: 'AQID' },
            ],
          },
        ],
      },
    ]);

    expect(JSON.stringify(out)).toContain('"media_type":"image/png"');
    expect(JSON.stringify(out)).toContain('"data":"AQID"');
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

  it('maps tool image results to text tool result plus image user message', () => {
    const out = toOpenAIMessages('', [
      {
        role: 'tool',
        toolResults: [
          {
            id: 'c1',
            content: 'screenshot',
            contentBlocks: [
              { type: 'text', text: 'screenshot' },
              { type: 'image', mimeType: 'image/png', data: 'AQID' },
            ],
          },
        ],
      },
    ]);

    expect(out[0]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'screenshot' });
    expect(JSON.stringify(out[1])).toContain('data:image/png;base64,AQID');
  });
});

describe('normalizeOpenAIBaseURL', () => {
  it('adds /v1 when the configured endpoint is a bare host', () => {
    expect(normalizeOpenAIBaseURL('http://192.168.10.108:18317')).toBe('http://192.168.10.108:18317/v1');
  });

  it('keeps explicit API paths unchanged', () => {
    expect(normalizeOpenAIBaseURL('http://localhost:8000/v1')).toBe('http://localhost:8000/v1');
    expect(normalizeOpenAIBaseURL('https://proxy.example.com/openai')).toBe('https://proxy.example.com/openai');
  });
});
