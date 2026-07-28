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
});
