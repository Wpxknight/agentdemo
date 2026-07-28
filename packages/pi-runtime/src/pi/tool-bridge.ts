import type { JsonValue, ToolCall, ToolDefinition, ToolResult } from '@aiop/control-contracts';
import { Type, type TSchema } from '@earendil-works/pi-ai';
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
    parameters: toTypeBoxSchema(definition.inputSchema),
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

function toTypeBoxSchema(schema: Record<string, unknown>): TSchema {
  if (Array.isArray(schema.enum)) return Type.Union(
    schema.enum.map((value) => Type.Literal(value as never)), schema,
  );
  switch (schema.type) {
    case 'object': {
      const properties = schema.properties && typeof schema.properties === 'object'
        ? schema.properties as Record<string, Record<string, unknown>> : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      return Type.Object(Object.fromEntries(Object.entries(properties).map(([name, property]) => [
        name, required.has(name) ? toTypeBoxSchema(property) : Type.Optional(toTypeBoxSchema(property)),
      ])), { ...schema, additionalProperties: schema.additionalProperties === true });
    }
    case 'array': return Type.Array(toTypeBoxSchema(
      schema.items && typeof schema.items === 'object' ? schema.items as Record<string, unknown> : {},
    ), schema);
    case 'string': return Type.String(schema);
    case 'integer': return Type.Integer(schema);
    case 'number': return Type.Number(schema);
    case 'boolean': return Type.Boolean(schema);
    case 'null': return Type.Null(schema);
    default: return Type.Unknown();
  }
}
