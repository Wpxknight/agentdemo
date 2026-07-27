import { describe, expect, it } from 'vitest';
import { PiContextManager } from '../packages/agent-kernel-pi/src/context-manager.js';

describe('PiContextManager', () => {
  it('wraps Pi token estimation and compaction policy with neutral messages', async () => {
    const manager = new PiContextManager();
    const usage = await manager.inspect([{ role: 'user', content: [{ type: 'text', text: 'hello '.repeat(100) }] }]);
    expect(usage.tokens).toBeGreaterThan(0);
    expect(manager.shouldCompact(usage, { contextWindowTokens: usage.tokens + 10, reserveTokens: 20, keepRecentTokens: 5 }))
      .toBe(true);
  });

  it('prepares explicit stale boundaries and accounts for injected compaction usage', async () => {
    const manager = new PiContextManager({
      complete: async ({ messages }) => ({
        text: `summary:${messages.length}`,
        usage: {
          inputTokens: 11,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
          costUsd: 0.02,
        },
      }),
    });
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `message-${index} ${'x'.repeat(80)}` }],
    }));
    const prepared = manager.prepare(messages, {
      contextWindowTokens: 120,
      reserveTokens: 20,
      keepRecentTokens: 30,
    });

    expect(prepared).toMatchObject({ summarizedMessages: expect.any(Number), retainedMessages: expect.any(Array) });
    expect(prepared!.summarizedMessages).toBeGreaterThan(0);
    expect(prepared!.retainedMessages.length).toBeGreaterThan(0);
    expect(prepared!.summarizedMessages + prepared!.retainedMessages.length).toBe(messages.length);

    await expect(manager.compact({ prepared: prepared!, signal: undefined })).resolves.toMatchObject({
      summary: expect.stringMatching(/^summary:/),
      usage: {
        inputTokens: 11,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
        costUsd: 0.02,
      },
    });
  });
});
