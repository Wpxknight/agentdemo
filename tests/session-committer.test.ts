import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/db/memory.js';
import { SessionCommitter } from '../src/agent/services/session-committer.js';
import type { RequestContext } from '../src/auth/types.js';

const ctx: RequestContext = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  role: 'user',
};

describe('SessionCommitter', () => {
  it('appends only the new turn and records final assistant duration', async () => {
    const store = new MemoryStore();
    const committer = new SessionCommitter(store);
    await store.appendMessage(ctx, 'session-a', { role: 'user', text: 'old' });

    await committer.commitSuccess({
      ctx,
      sessionId: 'session-a',
      priorMessageCount: 1,
      result: {
        messages: [
          { role: 'user', text: 'old' },
          { role: 'user', text: 'new' },
          { role: 'assistant', text: 'done' },
        ],
        text: 'done',
        steps: 1,
        usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        compacted: false,
      },
      durationMs: 25,
    });

    const messages = await store.listMessages(ctx, 'session-a');
    expect(messages).toHaveLength(3);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', text: 'done', durationMs: 25 });
  });

  it('replaces the complete history after compaction', async () => {
    const store = new MemoryStore();
    const committer = new SessionCommitter(store);
    await store.appendMessages(ctx, 'session-a', [{ role: 'user', text: 'old-1' }, { role: 'assistant', text: 'old-2' }]);

    await committer.commitSuccess({
      ctx,
      sessionId: 'session-a',
      priorMessageCount: 2,
      result: {
        messages: [{ role: 'user', text: '[summary]' }, { role: 'assistant', text: 'done' }],
        text: 'done',
        steps: 1,
        usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        compacted: true,
      },
      durationMs: 10,
    });

    expect(await store.listMessages(ctx, 'session-a')).toEqual([
      { role: 'user', text: '[summary]' },
      { role: 'assistant', text: 'done', durationMs: 10 },
    ]);
  });

  it('persists streamed output and the existing failure/termination suffix', async () => {
    const store = new MemoryStore();
    const committer = new SessionCommitter(store);

    await committer.commitFailure({
      ctx,
      sessionId: 'session-a',
      task: 'do it',
      streamedText: 'partial',
      streamedThinking: 'reasoning',
      durationMs: 12,
      error: new Error('boom'),
      terminated: false,
    });
    await committer.commitFailure({
      ctx,
      sessionId: 'session-b',
      task: 'stop it',
      streamedText: '',
      streamedThinking: '',
      durationMs: 3,
      error: new Error('stop'),
      terminated: true,
    });

    expect((await store.listMessages(ctx, 'session-a')).at(-1)).toMatchObject({
      text: 'partial\n\n运行失败：boom',
      thinking: 'reasoning',
      durationMs: 12,
    });
    expect((await store.listMessages(ctx, 'session-b')).at(-1)?.text).toBe('已终止当前运行。');
  });
});
