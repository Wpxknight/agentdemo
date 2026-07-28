import type { AgentRunEvent, JsonValue } from '@aiop/control-contracts';
import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core';

export interface EventCodecOptions {
  tenantId: string;
  runId: string;
  attemptId: string;
  turnNo: number;
  correlationId: string;
  sequence: () => bigint;
  now?: () => Date;
}

export class EventCodec {
  private readonly now: () => Date;

  constructor(private readonly options: EventCodecOptions) {
    this.now = options.now ?? (() => new Date());
  }

  fromPi(event: AgentHarnessEvent): AgentRunEvent {
    const known = KNOWN_EVENTS.has(event.type);
    return {
      tenantId: this.options.tenantId,
      runId: this.options.runId,
      attemptId: this.options.attemptId,
      turnNo: this.options.turnNo,
      kernel: 'pi',
      kernelVersion: '0.82.1',
      correlationId: this.options.correlationId,
      sequence: this.options.sequence(),
      type: known ? event.type : 'pi_extension',
      detail: toJsonValue(known
        ? { version: 1, ...withoutType(event) }
        : { version: 1, kind: 'pi_harness_event', event }) as JsonValue,
      createdAt: this.now(),
    };
  }
}

function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return toJsonValue({
    name: value.name, message: value.message, stack: value.stack, cause: value.cause,
  }, seen);
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) {
    return toJsonValue({ aborted: value.aborted, ...(value.aborted ? { reason: value.reason } : {}) }, seen);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return { kind: 'circular_reference' };
    seen.add(value);
    return value.map((item) => toJsonValue(item, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return { kind: 'circular_reference' };
    seen.add(value);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol') continue;
      result[key] = toJsonValue(item, seen);
    }
    return result;
  }
  return String(value);
}

const KNOWN_EVENTS = new Set([
  'agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'tool_call', 'tool_result',
  'queue_update', 'save_point', 'abort', 'settled', 'before_agent_start', 'context',
  'before_provider_request', 'before_provider_payload', 'after_provider_response', 'session_before_compact',
  'session_compact', 'session_before_tree', 'session_tree', 'retry_scheduled', 'retry_attempt_start',
  'retry_finished', 'model_update', 'thinking_level_update', 'resources_update', 'tools_update',
]);

function withoutType(event: AgentHarnessEvent): Record<string, unknown> {
  const { type: _type, ...detail } = event;
  return detail;
}
