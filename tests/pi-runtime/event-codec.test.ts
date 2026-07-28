import { describe, expect, it } from 'vitest';
import { EventCodec, toDurableJsonValue } from '../../packages/pi-runtime/src/index.js';

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
      detail: { version: 1, toolCallId: 'call-1', toolName: 'lookup', inputKeys: ['key'] },
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
    });
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
    const codec = new EventCodec({
      tenantId: 'tenant-1', runId: 'run-1', attemptId: 'attempt-1', turnNo: 1,
      correlationId: 'correlation-1', sequence: () => 1n,
    });
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
