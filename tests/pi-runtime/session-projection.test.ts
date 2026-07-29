import { describe, expect, it } from 'vitest';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import { MemoryStore } from '../../src/db/memory.js';
import {
  PiSessionProjection,
  projectCommittedPiSession,
  projectPiSessionStats,
  projectPiUsage,
} from '../../src/agent/projections.js';
import type { RequestContext } from '../../src/auth/types.js';

const ctx: RequestContext = { tenantId: 'tenant-a', userId: 'user-a', role: 'user' };

const usage = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 23,
  cost: { input: 0.11, output: 0.14, cacheRead: 0.01, cacheWrite: 0.02, total: 0.28 },
};

function entries(): SessionTreeEntry[] {
  return [
    {
      type: 'message', id: 'user-1', parentId: null, timestamp: '2026-07-29T00:00:00.000Z',
      message: {
        role: 'user', timestamp: 1,
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', mimeType: 'image/png', data: 'cG5n' },
        ],
      },
    },
    {
      type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp: '2026-07-29T00:00:01.000Z',
      message: {
        role: 'assistant', timestamp: 2, api: 'openai-completions', provider: 'aiop', model: 'model-a',
        content: [
          { type: 'thinking', thinking: 'reason', thinkingSignature: 'signed' },
          { type: 'text', text: 'done' },
          { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
        ],
        usage,
        stopReason: 'toolUse',
      },
    },
    {
      type: 'message', id: 'tool-1', parentId: 'assistant-1', timestamp: '2026-07-29T00:00:02.000Z',
      message: {
        role: 'toolResult', timestamp: 3, toolCallId: 'call-1', toolName: 'lookup',
        content: [{ type: 'text', text: 'result' }], isError: false,
      },
    },
  ];
}

describe('Pi session projection', () => {
  it('rebuilds the product message view idempotently from the committed Pi path', async () => {
    const store = new MemoryStore();
    const projection = new PiSessionProjection(store);
    const input = {
      ctx,
      sessionId: 'session-a',
      entries: entries(),
      committedLeafId: 'tool-1',
      assistantDurationMs: { 'assistant-1': 25 },
    };

    await projection.project(input);
    await projection.project(input);

    expect(await store.listMessages(ctx, 'session-a')).toEqual([
      {
        role: 'user', text: 'hello',
        contentBlocks: [
          { type: 'text', text: 'hello' },
          { type: 'image', mimeType: 'image/png', data: 'cG5n' },
        ],
      },
      {
        role: 'assistant', text: 'done', thinking: 'reason',
        thinkingBlocks: [{ thinking: 'reason', signature: 'signed' }],
        toolCalls: [{ id: 'call-1', name: 'lookup', args: { q: 'x' } }],
        durationMs: 25,
      },
      {
        role: 'tool',
        toolResults: [{ id: 'call-1', content: 'result', contentBlocks: [{ type: 'text', text: 'result' }], isError: false }],
      },
    ]);
  });

  it('ignores entries outside the committed leaf path', async () => {
    const store = new MemoryStore();
    const projection = new PiSessionProjection(store);
    const branch = entries();
    branch.push({
      type: 'message', id: 'uncommitted', parentId: 'user-1', timestamp: '2026-07-29T00:00:03.000Z',
      message: { role: 'user', content: 'must not project', timestamp: 4 },
    });

    await projection.project({ ctx, sessionId: 'session-a', entries: branch, committedLeafId: 'tool-1' });

    expect((await store.listMessages(ctx, 'session-a')).map((message) => message.text)).not.toContain('must not project');
  });

  it('maps Pi usage to the existing token and cost fields', () => {
    expect(projectPiUsage(usage)).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
      costUsd: 0.28,
    });
  });

  it('projects Pi SessionStats into the existing session usage APIs', () => {
    expect(projectPiSessionStats({
      messageCount: 4,
      cachedTokens: 30,
      uncachedTokens: 70,
      totalTokens: 125,
      costTotal: 0.42,
    }, 200)).toEqual({
      context: { usedTokens: 100, maxTokens: 200, estimated: false },
      usage: { totalTokens: 125 },
      costUsd: 0.42,
    });
  });

  it('loads only committed entries from the Pi store and preserves terminal duration', async () => {
    const store = new MemoryStore();
    const all = entries();
    const source = {
      async get() {
        return {
          tenantId: ctx.tenantId,
          sessionId: 'session-a',
          createdAt: new Date(),
          updatedAt: new Date(),
          currentLeafId: 'uncommitted',
          committedLeafId: 'assistant-1',
        };
      },
      async listEntries(_tenantId: string, _sessionId: string, options?: { committedOnly?: boolean }) {
        expect(options).toEqual({ committedOnly: true });
        return all.slice(0, 2).map((entry, index) => ({
          tenantId: ctx.tenantId,
          sessionId: 'session-a',
          sequence: BigInt(index + 1),
          entry,
        }));
      },
    };

    await projectCommittedPiSession({
      store,
      sessions: source as never,
      ctx,
      sessionId: 'session-a',
      durationMs: 42,
    });

    expect((await store.listMessages(ctx, 'session-a')).at(-1)).toMatchObject({
      role: 'assistant', text: 'done', durationMs: 42,
    });
  });

  it('leaves the product view unchanged until Pi has a committed leaf', async () => {
    const store = new MemoryStore();
    await store.appendMessage(ctx, 'session-a', { role: 'user', text: 'legacy history' });
    const source = {
      async get() {
        return {
          tenantId: ctx.tenantId,
          sessionId: 'session-a',
          createdAt: new Date(),
          updatedAt: new Date(),
          currentLeafId: 'uncommitted',
          committedLeafId: null,
        };
      },
      async listEntries() {
        throw new Error('uncommitted entries must not be loaded for projection');
      },
    };

    expect(await projectCommittedPiSession({
      store,
      sessions: source as never,
      ctx,
      sessionId: 'session-a',
    })).toBe(false);
    expect(await store.listMessages(ctx, 'session-a')).toEqual([{ role: 'user', text: 'legacy history' }]);
  });
});
