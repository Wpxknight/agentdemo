import type { ToolCall, ToolExecutionContext } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from './adapter.js';

export interface ToolPolicyDecision {
  allowed: boolean;
  reason?: string;
  needsApproval?: boolean;
  resourceKey?: string;
}

export interface ToolPolicy {
  check(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: GovernedToolDefinition,
  ): Promise<ToolPolicyDecision>;
}
