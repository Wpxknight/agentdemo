import type { JsonValue, ToolCall, ToolDefinition, ToolResult } from '@aiop/control-contracts';
import { Type } from '@earendil-works/pi-ai';
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';

export interface GovernedTool {
  definition: ToolDefinition;
  execute(call: ToolCall): Promise<ToolResult>;
}

export function bridgeGovernedTools(tools: readonly GovernedTool[]): AgentHarnessTool<undefined>[] {
  return tools.map(({ definition, execute }) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: Type.Unsafe(definition.inputSchema),
    executionMode: definition.capability === 'read' ? 'parallel' : 'sequential',
    execute: async (toolCallId, params, _signal, _onUpdate, _context) => {
      const result = await execute({
        id: toolCallId,
        logicalCallId: toolCallId,
        name: definition.name,
        arguments: params as JsonValue,
      });
      return {
        content: [{ type: 'text', text: result.content }],
        details: result,
      };
    },
  }));
}
