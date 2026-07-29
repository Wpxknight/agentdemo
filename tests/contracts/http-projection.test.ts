import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  projectDurableHttpDone,
  projectDurableHttpEvent,
  readSessionContextProjection,
  readSessionUsageProjection,
} from '../../src/server/http.js';
import { piSessionStorageId } from '../../packages/pi-runtime/src/store/session-id.js';

describe('HTTP Pi event projection compatibility', () => {
  it.each([
    ['text_delta', 'hello'],
    ['thinking_delta', 'reason'],
  ] as const)('keeps the %s SSE event name and text DTO', (type, delta) => {
    expect(projectDurableHttpEvent({
      type: 'message_update',
      detail: { update: { type, delta } },
    })).toEqual({ event: type, data: { text: delta } });
  });

  it('projects Pi message usage into the legacy usage SSE DTO', () => {
    expect(projectDurableHttpEvent({
      type: 'message_end',
      detail: {
        message: {
          role: 'assistant',
          usage: { input: 5, output: 4, cacheRead: 3, cacheWrite: 2, costTotal: 0.12 },
        },
      },
    })).toEqual({
      event: 'usage',
      data: {
        inputTokens: 5,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        cost: 0.12,
      },
    });
  });

  it.each([
    [
      { type: 'tool_call', detail: { toolCallId: 'call-1', toolName: 'lookup', input: { q: 'x' }, inputKeys: ['q'] } },
      { event: 'tool_call', data: { call: { id: 'call-1', name: 'lookup', args: { q: 'x' } } } },
    ],
    [
      { type: 'tool_execution_update', detail: { toolCallId: 'call-1', toolName: 'lookup', outputText: 'live output' } },
      { event: 'tool_output', data: { toolId: 'call-1', stream: 'stdout', text: 'live output' } },
    ],
    [
      { type: 'tool_execution_end', detail: { toolCallId: 'call-1', toolName: 'lookup', isError: false } },
      { event: 'tool_result', data: { toolId: 'call-1', name: 'lookup', isError: false } },
    ],
    [
      { type: 'session_compact', detail: { tokensBefore: 100, tokensAfter: 40, summarizedMessages: 6, summaryLength: 20 } },
      { event: 'context_compacted', data: { summarizedMessages: 6, beforeTokens: 100, afterTokens: 40 } },
    ],
    [
      { type: 'abort', detail: { reason: 'cancelled' } },
      { event: 'stop', data: { reason: 'cancelled' } },
    ],
  ])('projects governed Pi events to legacy SSE names', (input, expected) => {
    expect(projectDurableHttpEvent(input)).toEqual(expected);
  });

  it('suppresses unknown and non-product durable events', () => {
    expect(projectDurableHttpEvent({ type: 'pi_extension', detail: { secret: 'must-not-leak' } })).toBeUndefined();
    expect(projectDurableHttpEvent({ type: 'retry_scheduled', detail: { errorMessage: 'internal' } })).toBeUndefined();
    expect(projectDurableHttpEvent({ type: 'todo_updated', detail: { todos: [] } })).toBeUndefined();
    expect(projectDurableHttpEvent({ type: 'file_exported', detail: { name: 'report.txt' } })).toBeUndefined();
  });

  it('retains the legacy done DTO fields for durable results', () => {
    expect(projectDurableHttpDone({
      sessionId: 'session-a',
      result: {
        runId: 'run-a', status: 'succeeded', text: 'done',
        usage: { inputTokens: 5, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 2, costUsd: 0.12 },
      },
      steps: 2,
      context: { usedTokens: 14, maxTokens: 100, estimated: false },
    })).toEqual({
      sessionId: 'session-a', runId: 'run-a', steps: 2, text: 'done',
      usage: {
        inputTokens: 5, outputTokens: 4, cacheReadTokens: 3, cacheCreationTokens: 2, costUsd: 0.12,
        context: { usedTokens: 14, maxTokens: 100, estimated: false }, cost: 0.12,
      },
      context: { usedTokens: 14, maxTokens: 100, estimated: false }, cost: 0.12,
    });
  });

  it('uses committed Pi SessionStats for the production session usage projections', async () => {
    const rt = {
      piSessionStore: {
        async getSessionStats(tenantId: string, sessionId: string) {
          expect(tenantId).toBe('tenant-a');
          expect(sessionId).toBe(piSessionStorageId('user-a', 'session-a'));
          return { messageCount: 3, cachedTokens: 20, uncachedTokens: 30, totalTokens: 75, costTotal: 0.2 };
        },
      },
      store: {
        getSessionContextUsage: async () => { throw new Error('legacy context usage must not be used'); },
        getSessionTokenUsage: async () => { throw new Error('legacy token usage must not be used'); },
      },
    };
    const ctx = { tenantId: 'tenant-a', userId: 'user-a', role: 'user' as const };

    await expect(readSessionContextProjection(rt as never, ctx, 'session-a', 200)).resolves.toEqual({
      usedTokens: 50, maxTokens: 200, estimated: false,
    });
    await expect(readSessionUsageProjection(rt as never, ctx, 'session-a')).resolves.toEqual({ totalTokens: 75 });
  });

  it('does not retain the retired model retry and context compaction services', () => {
    const source = (path: string) => fileURLToPath(new URL(`../../src/agent/services/${path}`, import.meta.url));
    expect(existsSync(source('model-gateway.ts'))).toBe(false);
    expect(existsSync(source('context-service.ts'))).toBe(false);
  });
});
