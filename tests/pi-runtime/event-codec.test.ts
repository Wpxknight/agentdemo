import { describe, expect, it } from 'vitest';
import { EventCodec } from '../../packages/pi-runtime/src/index.js';

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
      detail: { version: 1, toolCallId: 'call-1', toolName: 'lookup', input: { key: 'value' } },
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
      version: 1, kind: 'pi_harness_event', event: { type: 'future_event', value: 42 },
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
    expect(detail).toMatchObject({
      event: {
        count: '2', date: '2026-07-28T00:00:00.000Z', error: { message: 'boom' },
        signal: { aborted: true, reason: { message: 'cancelled' } },
        circular: { self: { kind: 'circular_reference' } },
      },
    });
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

    const detail = codec.fromPi({ type: 'future_event', error, signal: controller.signal } as never).detail;
    expect(() => JSON.stringify(detail)).not.toThrow();
    expect(detail).toMatchObject({ event: {
      error: { cause: { kind: 'circular_reference' } },
      signal: { aborted: true, reason: { kind: 'circular_reference' } },
    } });
  });
});
