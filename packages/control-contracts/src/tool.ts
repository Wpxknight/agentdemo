import type { IdentityContext } from './identity.js';
import type { ResolvedInteraction, WaitingReason, DurableInteractionUpdate } from './interaction.js';
import type { JsonValue } from './json.js';

export type ToolCapability = 'read' | 'retryable_write' | 'non_idempotent_write';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: ToolCapability;
}

export interface ToolCall {
  id: string;
  logicalCallId: string;
  name: string;
  arguments: JsonValue;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
  digest?: string;
}

export interface ToolExecutionContext {
  identity: IdentityContext;
  runId: string;
  attemptId: string;
  turnNo: number;
  sessionId?: string;
  interactionResolution?: ResolvedInteraction;
  signal?: AbortSignal;
}

export interface DurableToolLedgerUpdate {
  tenantId: string;
  runId: string;
  attemptId: string;
  turnNo: number;
  logicalCallId: string;
  toolCallId: string;
  toolName: string;
  argsDigest: string;
  capability: ToolCapability;
  idempotencyKey: string;
  status: 'pending_approval' | 'started' | 'completed' | 'unknown' | 'recovery_required';
  externalCorrelationId?: string;
  resultDigest?: string;
  approvedInteractionId?: string;
  result?: ToolResult;
  createdAt: Date;
  updatedAt: Date;
}

export interface DurableExecutionFacts {
  ledgerUpdates?: readonly DurableToolLedgerUpdate[];
  interactionUpdates?: readonly DurableInteractionUpdate[];
}

export type ToolExecutionOutcome = (
  | { kind: 'result'; result: ToolResult }
  | { kind: 'waiting'; reason: WaitingReason; interactionId: string }
  | { kind: 'recovery_required'; correlationId?: string; message: string }
) & DurableExecutionFacts;

export interface ToolRuntime {
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome>;
}
