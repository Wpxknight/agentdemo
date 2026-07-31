import { describe, expect, it } from 'vitest';
import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core';
import { EventCodec } from '../../packages/pi-runtime/src/index.js';
import { toDurableJsonValue } from '../../packages/pi-runtime/src/pi/event-codec.js';
import { projectDurableHttpEvent } from '../../src/server/http.js';

describe('Pi EventCodec', () => {
  it('projects a Harness tool event into a durable control event', () => {
    const codec = new EventCodec({
      tenantId: 'tenant-1', runId: 'run-1', attemptId: 'attempt-1', turnNo: 2,
      correlationId: 'correlation-1', sequence: () => 9n, now: () => new Date('2026-07-28T00:00:00.000Z'),
    });

    expect(codec.fromPi({
      type: 'tool_call', toolCallId: 'call-1', toolName: 'lookup', input: { key: 'value' },
    })).toEqual({
      tenantId: 'tenant-1', runId: 'run-1', attemptId: 'attempt-1', turnNo: 2,
      kernel: 'pi', kernelVersion: '0.82.1', correlationId: 'correlation-1', sequence: 9n,
      type: 'tool_call',
      detail: { version: 1, toolCallId: 'call-1', toolName: 'lookup', input: { key: 'value' }, inputKeys: ['key'] },
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
    });
  });

  it('retains bounded user-visible tool output while redacting governed input credentials', () => {
    const codec = new EventCodec({ tenantId: 't', runId: 'r', attemptId: 'a', turnNo: 1,
      correlationId: 'c', sequence: () => 1n });

    expect(codec.fromPi({
      type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'shell', args: {},
      partialResult: { content: [{ type: 'text', text: 'live output' }] },
    } as never).detail).toMatchObject({ outputText: 'live output' });
    expect(codec.fromPi({
      type: 'tool_call', toolCallId: 'call-2', toolName: 'lookup',
      input: { query: 'visible', apiKey: 'must-not-leak' },
    } as never).detail).toMatchObject({ input: { query: 'visible', apiKey: '[REDACTED]' } });
  });

  it('keeps unknown Harness events as safely ignorable versioned detail', () => {
    const codec = new EventCodec({
      tenantId: 'tenant-1', runId: 'run-1', attemptId: 'attempt-1', turnNo: 1,
      correlationId: 'correlation-1', sequence: () => 1n,
    });
    const projected = codec.fromPi({ type: 'future_event', value: 42 } as never);
    expect(projected.type).toBe('pi_extension');
    expect(projected.detail).toEqual({
      version: 1, kind: 'pi_harness_event', originalType: 'future_event', keys: ['value'],
    });
  });

  it('projects complex event detail into deterministic JSON-safe values', () => {
    const codec = new EventCodec({
      tenantId: 'tenant-1', runId: 'run-1', attemptId: 'attempt-1', turnNo: 1,
      correlationId: 'correlation-1', sequence: () => 1n,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const detail = codec.fromPi({
      type: 'future_event', date: new Date('2026-07-28T00:00:00.000Z'), count: 2n,
      error: new Error('boom'), signal: controller.signal, circular, ignored: undefined,
    } as never).detail;

    expect(() => JSON.stringify(detail)).not.toThrow();
    expect(detail).toEqual({ version: 1, kind: 'pi_harness_event', originalType: 'future_event',
      keys: ['circular', 'count', 'date', 'error', 'ignored', 'signal'] });
  });

  it('handles self-referential Error causes and AbortSignal reasons', () => {
    const error = new Error('recursive');
    error.cause = error;
    const controller = new AbortController();
    controller.abort(controller.signal);

    const detail = toDurableJsonValue({ error, signal: controller.signal });
    expect(() => JSON.stringify(detail)).not.toThrow();
    expect(detail).toMatchObject({ error: { cause: { kind: 'circular_reference' } },
      signal: { reason: { kind: 'circular_reference' } } });
    expect(JSON.stringify(detail)).not.toContain('stack');
    expect(toDurableJsonValue({ authorization: 'secret', apiKey: 'secret' })).toEqual({
      apiKey: '[REDACTED]', authorization: '[REDACTED]',
    });
  });

  it('redacts only explicit credential keys while retaining token accounting', () => {
    expect(toDurableJsonValue({
      authorization: 'Bearer secret', proxy_authorization: 'proxy secret', setCookie: 'session=secret',
      api_key: 'api secret', accessToken: 'access secret', refresh_token: 'refresh secret',
      authToken: 'auth secret', bearer_token: 'bearer secret', clientSecret: 'client secret',
      token: 'token secret', password: 'password secret', credential: 'credential secret',
      totalTokens: 101, tokensBefore: 89, tokensAfter: 55, maxTokens: 512, tokenCount: 34,
    })).toEqual({
      accessToken: '[REDACTED]', api_key: '[REDACTED]', authToken: '[REDACTED]',
      authorization: '[REDACTED]', bearer_token: '[REDACTED]', clientSecret: '[REDACTED]',
      credential: '[REDACTED]', maxTokens: 512, password: '[REDACTED]',
      proxy_authorization: '[REDACTED]', refresh_token: '[REDACTED]', setCookie: '[REDACTED]',
      token: '[REDACTED]', tokenCount: 34, tokensAfter: 55, tokensBefore: 89, totalTokens: 101,
    });

    const codec = new EventCodec({ tenantId: 't', runId: 'r', attemptId: 'a', turnNo: 1,
      correlationId: 'c', sequence: () => 1n });
    expect(codec.fromPi({ type: 'message_end', message: {
      role: 'assistant', content: [], stopReason: 'stop', timestamp: 1,
      usage: { input: 40, output: 10, cacheRead: 2, cacheWrite: 1, totalTokens: 53,
        cost: { input: 0.4, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.63 } },
    } } as never).detail).toMatchObject({ message: { usage: { totalTokens: 53, costTotal: 0.63 } } });
    expect(codec.fromPi({ type: 'session_before_compact', branchEntries: [], preparation: {
      tokensBefore: 987, messagesToSummarize: [], turnPrefixMessages: [], retainedTail: [], firstKeptEntryId: undefined,
    }, signal: new AbortController().signal } as never).detail).toMatchObject({ tokensBefore: 987 });
  });

  it('emits the real compaction fields required by the HTTP compatibility projection', () => {
    const codec = new EventCodec({ tenantId: 't', runId: 'r', attemptId: 'a', turnNo: 1,
      correlationId: 'c', sequence: () => 1n });
    const beforeCompactEvent = { type: 'session_before_compact', branchEntries: [], preparation: {
      tokensBefore: 100, messagesToSummarize: [
        { role: 'user', content: 'old question', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 2,
          api: 'openai-completions', provider: 'aiop', model: 'm', stopReason: 'stop', usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          } },
      ], turnPrefixMessages: [
        { role: 'user', content: 'current split-turn question', timestamp: 3 },
      ], retainedTail: [], firstKeptEntryId: 'kept', isSplitTurn: true,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 },
    }, signal: new AbortController().signal } satisfies Extract<AgentHarnessEvent, { type: 'session_before_compact' }>;
    codec.fromPi(beforeCompactEvent);

    const compactEvent = { type: 'session_compact', fromHook: false, compactionEntry: {
      type: 'compaction', id: 'compact', parentId: 'kept', timestamp: '2026-07-29T00:00:00.000Z',
      summary: 'short summary', firstKeptEntryId: 'kept', tokensBefore: 100, retainedTail: [],
    } } satisfies Extract<AgentHarnessEvent, { type: 'session_compact' }>;
    const durableEvent = codec.fromPi(compactEvent);

    expect(durableEvent.detail).toMatchObject({
      tokensBefore: 100,
      tokensAfter: expect.any(Number),
      summarizedMessages: 3,
    });
    expect(projectDurableHttpEvent(durableEvent)).toEqual({
      event: 'context_compacted',
      data: {
        summarizedMessages: 3,
        beforeTokens: 100,
        afterTokens: expect.any(Number),
      },
    });
  });

  it('turns throwing keys, getters, and proxies into stable unserializable detail', () => {
    const keysThrow = new Proxy({}, { ownKeys: () => { throw new Error('ownKeys failed'); } });
    const getterThrow = Object.defineProperty({}, 'value', {
      enumerable: true, get: () => { throw new Error('getter failed'); },
    });

    expect(toDurableJsonValue(keysThrow)).toEqual({ kind: 'unserializable' });
    expect(toDurableJsonValue(getterThrow)).toEqual({ kind: 'unserializable' });
    expect(() => JSON.stringify(toDurableJsonValue({ nested: keysThrow }))).not.toThrow();
    expect(toDurableJsonValue({ nested: keysThrow })).toEqual({ nested: { kind: 'unserializable' } });
  });

  it('allowlists provider fields and enforces a strict durable detail bound', () => {
    const codec = new EventCodec({ tenantId: 't', runId: 'r', attemptId: 'a', turnNo: 1,
      correlationId: 'c', sequence: () => 1n });
    const projected = codec.fromPi({
      type: 'before_provider_request',
      model: { id: 'm', provider: 'p', api: 'a' }, sessionId: 's',
      streamOptions: { headers: { authorization: 'Bearer secret', cookie: 'secret' }, metadata: { token: 'secret' } },
    } as never);
    const json = JSON.stringify(projected.detail);
    expect(json).not.toContain('Bearer secret');
    expect(json).not.toContain('cookie');
    expect(projected.detail).toMatchObject({ streamOptionKeys: ['headers', 'metadata'], streamOptionCount: 2 });
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(8192);
  });

  it('does not mark shared non-cyclic references as circular and truncates message text', () => {
    const codec = new EventCodec({ tenantId: 't', runId: 'r', attemptId: 'a', turnNo: 1,
      correlationId: 'c', sequence: () => 1n });
    const shared = { value: 'ok' };
    expect(JSON.stringify(toDurableJsonValue({ left: shared, right: shared }))).not.toContain('circular_reference');
    const message = codec.fromPi({ type: 'message_end', message: {
      role: 'user', content: [{ type: 'text', text: 'x'.repeat(20_000) }], timestamp: 1,
    } } as never);
    expect(Buffer.byteLength(JSON.stringify(message.detail))).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(message.detail)).not.toContain('x'.repeat(1000));
  });
});
