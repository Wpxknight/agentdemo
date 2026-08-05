import type { GovernedToolDefinition, RegisteredToolSource, ToolSource } from './adapter.js';
import { adaptPiAgentTool } from './adapter.js';
import type { ToolCapability } from '@aiop/control-contracts';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export class UnifiedToolRegistry {
  private readonly tools = new Map<string, RegisteredToolSource>();

  register(source: ToolSource, definition: GovernedToolDefinition): this {
    if (this.tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
    this.tools.set(definition.name, { source, definition });
    return this;
  }

  registerPi(tool: AgentTool, capability: ToolCapability): this {
    return this.register('pi', adaptPiAgentTool(tool, capability));
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  definitions(): GovernedToolDefinition[] {
    return [...this.tools.values()].map(({ definition }) => definition);
  }

  entries(): RegisteredToolSource[] {
    return [...this.tools.values()];
  }
}
