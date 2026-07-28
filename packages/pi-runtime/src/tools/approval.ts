import type { DurableInteractionUpdate, JsonValue, ToolCall, ToolExecutionContext } from '@aiop/control-contracts';
import type { ToolPolicyDecision } from './policy.js';

export interface ToolApprovalDecision {
  approved: boolean;
  pending?: boolean;
  interactionId?: string;
  payload?: JsonValue;
}

export interface ToolApproval {
  request(
    call: ToolCall,
    context: ToolExecutionContext,
    decision: ToolPolicyDecision,
  ): Promise<ToolApprovalDecision>;
}

export interface ToolInteractionStore {
  get(input: {
    tenantId: string;
    runId: string;
    interactionId: string;
  }): Promise<DurableInteractionUpdate | undefined>;
}
