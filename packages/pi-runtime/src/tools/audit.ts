import type {
  ToolCall,
  ToolExecutionContext,
  ToolExecutionOutcome,
} from '@aiop/control-contracts';
import type { GovernedToolDefinition } from './adapter.js';

export interface ToolAudit {
  record(input: {
    call: ToolCall;
    context: ToolExecutionContext;
    tool: GovernedToolDefinition;
    outcome: ToolExecutionOutcome;
  }): Promise<void>;
}
