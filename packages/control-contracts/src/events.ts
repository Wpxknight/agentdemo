import type { JsonValue } from './json.js';
import type { AgentKernelName, AgentRunStatus } from './run.js';

export interface AgentRunEvent {
  tenantId: string;
  runId: string;
  sequence: bigint;
  type: string;
  attemptId: string;
  turnNo: number;
  kernel: AgentKernelName;
  kernelVersion: string;
  correlationId: string;
  detail?: JsonValue;
  createdAt: Date;
}

export interface SseProjectionEvent {
  id: string;
  event: string;
  data: JsonValue;
}

export type RuntimeMetric =
  | { kind: 'counter'; name: string; value: number }
  | { kind: 'timer'; name: string; value: number; unit: 'ms' };

export interface RuntimeObservation {
  type:
    | 'run_started' | 'run_finished' | 'attempt_started' | 'attempt_finished'
    | 'turn_started' | 'turn_committed' | 'lease_lost' | 'context_compacted'
    | 'tool_call' | 'tool_result' | 'waiting' | 'recovery_required' | 'sse_replay';
  tenantId: string;
  runId: string;
  attemptId: string;
  turnNo: number;
  kernel: AgentKernelName;
  kernelVersion: string;
  correlationId: string;
  metric: RuntimeMetric;
  status?: AgentRunStatus;
  detail?: JsonValue;
  occurredAt: Date;
}
