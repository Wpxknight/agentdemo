import type { JsonValue, ToolCall, ToolDefinition, ToolResult } from '@aiop/control-contracts';
import type { TSchema } from '@earendil-works/pi-ai';
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';

export interface GovernedTool {
  definition: ToolDefinition;
  /** Optional migration resolver. New durable integrations should supply a stable logical id. */
  logicalCallId?: (toolCallId: string, argumentsValue: JsonValue) => string;
  execute(call: ToolCall, context: GovernedToolExecutionContext): Promise<ToolResult>;
}

export interface GovernedToolExecutionContext {
  signal?: AbortSignal;
  logicalCallId: string;
  piContext?: unknown;
}

export interface GovernedToolBridgeOptions {
  resolveLogicalCallId?: (input: { toolCallId: string; tool: ToolDefinition; arguments: JsonValue }) => string;
}

export class GovernedToolExecutionError extends Error {
  constructor(
    message: string,
    readonly call: ToolCall,
    readonly result: ToolResult,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'GovernedToolExecutionError';
  }
}

export function bridgeGovernedTools(
  tools: readonly GovernedTool[], options: GovernedToolBridgeOptions = {},
): AgentHarnessTool<undefined>[] {
  return tools.map((governed) => {
    const { definition, execute } = governed;
    return ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as TSchema,
    executionMode: definition.capability === 'read' ? 'parallel' : 'sequential',
    execute: async (toolCallId, params, signal, _onUpdate, piContext) => {
      const argumentsValue = params as JsonValue;
      const logicalCallId = governed.logicalCallId?.(toolCallId, argumentsValue)
        ?? options.resolveLogicalCallId?.({ toolCallId, tool: definition, arguments: argumentsValue })
        ?? toolCallId;
      const call: ToolCall = {
        id: toolCallId,
        logicalCallId,
        name: definition.name,
        arguments: argumentsValue,
      };
      const context = { signal, logicalCallId, piContext };
      let result: ToolResult;
      try {
        result = await execute(call, context);
      } catch (error) {
        if (error instanceof GovernedToolExecutionError) throw error;
        throw new GovernedToolExecutionError('Governed tool execution failed', call, {
          callId: toolCallId, content: error instanceof Error ? error.message : String(error), isError: true,
        }, error);
      }
      if (result.isError) throw new GovernedToolExecutionError(result.content, call, result);
      return {
        content: [{ type: 'text', text: result.content }],
        details: result,
      };
    },
    });
  });
}
