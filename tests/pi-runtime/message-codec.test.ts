import { describe, expect, it } from 'vitest';
import { MessageCodec, type CompatibleAgentMessage } from '../../packages/pi-runtime/src/index.js';

const usage = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 23,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 },
};

describe('Pi MessageCodec', () => {
  const codec = new MessageCodec();

  it.each<CompatibleAgentMessage>([
    { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 10 },
    { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], timestamp: 11 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { key: 'value' } },
      ],
      api: 'test-api', provider: 'test-provider', model: 'test-model', usage,
      stopReason: 'toolUse', timestamp: 12,
    },
    {
      role: 'toolResult', toolCallId: 'call-1', toolName: 'lookup',
      content: [{ type: 'text', text: 'done' }], details: { source: 'governed' },
      usage, isError: false, timestamp: 13,
    },
  ])('round-trips compatible messages without losing fields', (original) => {
    expect(codec.fromPi(codec.toPi(original))).toEqual(original);
  });

  it('preserves unknown Pi content blocks in a versioned extension', () => {
    const piMessage = {
      role: 'assistant',
      content: [{ type: 'futureBlock', payload: { answer: 42 } }],
      api: 'test-api', provider: 'test-provider', model: 'test-model', usage,
      stopReason: 'stop', timestamp: 14,
    } as never;

    const compatible = codec.fromPi(piMessage);
    expect(compatible.extensions).toEqual([{
      version: 1,
      kind: 'pi_content_block',
      value: { type: 'futureBlock', payload: { answer: 42 } },
    }]);
    expect(codec.toPi(compatible)).toEqual(piMessage);
  });

  it('preserves unknown Pi content block positions among known blocks', () => {
    const piMessage = {
      role: 'assistant',
      content: [
        { type: 'futureBlock', payload: 1 },
        { type: 'text', text: 'middle' },
        { type: 'futureBlock', payload: 2 },
      ],
      api: 'test-api', provider: 'test-provider', model: 'test-model', usage,
      stopReason: 'stop', timestamp: 15,
    } as never;

    expect(codec.toPi(codec.fromPi(piMessage))).toEqual(piMessage);
  });
});
