import type { JsonValue, ToolCall, ToolDefinition, ToolResult } from '@aiop/control-contracts';
import type { TSchema } from '@earendil-works/pi-ai';
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
    parameters: definition.inputSchema as TSchema,
    executionMode: definition.capability === 'read' ? 'parallel' : 'sequential',
    execute: async (toolCallId, params, _signal, _onUpdate, _context) => {
      const result = await execute({
        id: toolCallId,
        logicalCallId: toolCallId,
        name: definition.name,
        arguments: params as JsonValue,
      });
      if (result.isError) throw new Error(result.content);
      return {
        content: [{ type: 'text', text: result.content }],
        details: result,
      };
    },
  }));
}
