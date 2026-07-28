import type { ToolExecutionContext } from '@aiop/control-contracts';
import {
  UnifiedToolRegistry,
  type GovernedToolDefinition,
  type ToolSource,
} from '@aiop/pi-runtime';
import type { ToolContext, ToolHandler } from '../agent/tools.js';

export interface ProductToolRegistryOptions {
  source?: Exclude<ToolSource, 'pi'>;
  resolveContext(context: ToolExecutionContext): ToolContext;
}

/**
 * Keeps product services in ToolHandler while exposing explicit Pi-compatible
 * definitions to the unified runtime registry.
 */
export function registerProductTools(
  registry: UnifiedToolRegistry,
  handlers: readonly ToolHandler[],
  options: ProductToolRegistryOptions,
): UnifiedToolRegistry {
  for (const handler of handlers) {
    if (!handler.def.capability) throw new Error(`tool capability is required: ${handler.def.name}`);
    const definition: GovernedToolDefinition = {
      ...handler.def,
      capability: handler.def.capability,
      execute: async (call, context) => {
        const result = await handler.run(call.arguments, {
          ...options.resolveContext(context),
          idempotencyKey: context.idempotencyKey,
        });
        return { content: result.content, isError: result.isError };
      },
    };
    registry.register(options.source ?? 'aiop', definition);
  }
  return registry;
}
