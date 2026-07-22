import { describe, expect, it, vi } from 'vitest';
import { compactAtBoundary } from '../src/agent/services/context-service.js';
import type { Msg, StreamEvent } from '../src/model/types.js';

describe('ContextService', () => {
  it('compacts stale history, retains user inputs, strips old images, and emits metrics', async () => {
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'a'.repeat(800) };
    const messages: Msg[] = [];
    for (let index = 0; index < 6; index++) {
      messages.push({ role: 'user', text: `question-${index}-${'x'.repeat(2000)}`, contentBlocks: [image] });
      messages.push({ role: 'assistant', text: `answer-${index}-${'y'.repeat(2000)}` });
    }
    const events: StreamEvent[] = [];
    const summarize = vi.fn(async () => 'summary');

    await expect(compactAtBoundary(messages, 0, {
      summarize,
      triggerTokens: 1_000,
      keepRecent: 2,
      keepImages: 1,
      onEvent: (event) => events.push(event),
    })).resolves.toBe(true);

    expect(summarize).toHaveBeenCalledOnce();
    expect(messages.some((message) => message.text?.includes('question-0'))).toBe(true);
    expect(messages.some((message) => message.text?.includes('summary'))).toBe(true);
    const imageCount = messages.reduce(
      (count, message) => count + (message.contentBlocks?.filter((block) => block.type === 'image').length ?? 0),
      0,
    );
    expect(imageCount).toBe(1);
    expect(events.some((event) => event.type === 'context_compacted')).toBe(true);
  });
});
