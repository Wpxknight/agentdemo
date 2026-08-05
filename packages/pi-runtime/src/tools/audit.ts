import type { ToolCapability } from '@aiop/control-contracts';

export type ToolAuditStatus =
  | 'unknown_tool'
  | 'cached_completed'
  | 'ledger_mismatch'
  | 'policy_denied'
  | 'approval_waiting'
  | 'invalid_resolution'
  | 'recovery_required'
  | 'success'
  | 'failure'
  | 'internal_error';

export interface ToolAuditEvent {
  tenantId: string;
  actorId: string;
  runId: string;
  attemptId: string;
  turnNo: number;
  sessionId?: string;
  toolName: string;
  toolCallId: string;
  logicalCallId: string;
  capability?: ToolCapability;
  argsDigest: string;
  status: ToolAuditStatus;
  outcomeKind: 'result' | 'waiting' | 'recovery_required' | 'exception';
  isError: boolean;
  errorCode?: string;
  resultDigest?: string;
  durationMs: number;
  recordedAt: Date;
}

export interface ToolAudit {
  record(event: ToolAuditEvent): Promise<void>;
  failure?(error: unknown, event: ToolAuditEvent): void;
}
