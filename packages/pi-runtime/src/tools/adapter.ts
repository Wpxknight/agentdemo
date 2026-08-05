import type {
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '@aiop/control-contracts';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export interface GovernedToolDefinition extends ToolDefinition {
  interactionKind?: 'question' | 'plan';
  execute(
    call: ToolCall,
    context: ToolExecutionContext & { idempotencyKey: string },
  ): Promise<Omit<ToolResult, 'callId'>>;
}

export type ToolSource = 'pi' | 'aiop' | 'mcp' | 'sandbox';

export interface RegisteredToolSource {
  source: ToolSource;
  definition: GovernedToolDefinition;
}

export function adaptPiAgentTool(
  tool: AgentTool,
  capability: ToolDefinition['capability'],
): GovernedToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Record<string, unknown>,
    capability,
    execute: async (call, context) => {
      const output = await tool.execute(call.id, call.arguments as never, context.signal);
      const content = output.content.map((block) => block.type === 'text'
        ? block.text
        : `[image:${block.mimeType}]`).join('\n');
      return { content };
    },
  };
}

export function resourceKeyFromArguments(toolName: string, args: JsonValue): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  for (const key of ['resourceKey', 'cluster', 'namespace', 'resource', 'target']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return `${toolName}:${key}:${value.trim()}`;
  }
  return undefined;
}
