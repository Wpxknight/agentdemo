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
      detail: (known
        ? { version: 1, ...withoutType(event) }
        : { version: 1, kind: 'pi_harness_event', event }) as JsonValue,
      createdAt: this.now(),
    };
  }
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
