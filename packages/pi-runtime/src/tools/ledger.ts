import { createHash } from 'node:crypto';
import type { DurableToolLedgerUpdate, JsonValue } from '@aiop/control-contracts';

export interface ToolLedgerIdentity {
  tenantId: string;
  runId: string;
  logicalCallId: string;
}

export interface ToolLedgerStore {
  putIfAbsent(record: DurableToolLedgerUpdate): Promise<boolean>;
  get(identity: ToolLedgerIdentity): Promise<DurableToolLedgerUpdate | undefined>;
  update(record: DurableToolLedgerUpdate): Promise<void>;
  claimPendingApproval(input: ToolApprovalClaim): Promise<boolean>;
}

export interface ToolApprovalClaim extends ToolLedgerIdentity {
  attemptId: string;
  turnNo: number;
  toolCallId: string;
  toolName: string;
  argsDigest: string;
  approvedInteractionId: string;
  started: DurableToolLedgerUpdate;
}

export function digestToolValue(value: JsonValue | string): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
