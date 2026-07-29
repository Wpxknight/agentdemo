import type { JsonValue, ToolCall, ToolDefinition, ToolExecutionOutcome, ToolResult } from '@aiop/control-contracts';
import type { TSchema } from '@earendil-works/pi-ai';
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';
import {
  createGovernedToolFailureTracker,
  markGovernedToolPrototype,
  markScopedGovernedTool,
  recordGovernedToolFailure,
  recordGovernedToolFacts,
  recordGovernedToolOutcome,
  type GovernedToolFailureTracker,
} from './governed-tool-state.js';

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

export class GovernedToolOutcomeError extends Error {
  readonly is_bubble_up = true;
  readonly kind: Exclude<ToolExecutionOutcome['kind'], 'result'>;
  readonly interactionId?: string;
  readonly correlationId?: string;

  constructor(readonly outcome: Exclude<ToolExecutionOutcome, { kind: 'result' }>) {
    super(outcome.kind === 'waiting' ? `tool waiting for ${outcome.reason}` : outcome.message);
    this.name = 'GovernedToolOutcomeError';
    this.kind = outcome.kind;
    this.interactionId = outcome.kind === 'waiting' ? outcome.interactionId : undefined;
    this.correlationId = outcome.kind === 'recovery_required' ? outcome.correlationId : undefined;
  }
}

const GOVERNED_TOOL_FACTS = Symbol('aiop.pi.governedToolFacts');

export function attachGovernedToolFacts(result: ToolResult, outcome: ToolExecutionOutcome): ToolResult {
  Object.defineProperty(result, GOVERNED_TOOL_FACTS, { value: outcome, configurable: true });
  return result;
}

export function bridgeGovernedTools(
  tools: readonly GovernedTool[], options: GovernedToolBridgeOptions = {},
): AgentHarnessTool<undefined>[] {
  return tools.map((governed) => {
    const descriptor = {
      definition: governed.definition,
      createScoped: () => {
        const tracker = createGovernedToolFailureTracker();
        const tool = createAgentTool(governed, options, tracker);
        markGovernedToolPrototype(tool, descriptor);
        markScopedGovernedTool(tool, tracker);
        return { tool, tracker };
      },
    };
    const prototype = createAgentTool(governed, options);
    markGovernedToolPrototype(prototype, descriptor);
    return prototype;
  });
}

function createAgentTool(
  governed: GovernedTool,
  options: GovernedToolBridgeOptions,
  tracker?: GovernedToolFailureTracker,
): AgentHarnessTool<undefined> {
  const { definition, execute } = governed;
  return {
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
        if (error instanceof GovernedToolOutcomeError) {
          if (tracker) {
            recordGovernedToolFacts(tracker, toolCallId, error.outcome);
            recordGovernedToolOutcome(tracker, toolCallId, error);
          }
          throw error;
        }
        const governedError = error instanceof GovernedToolExecutionError ? error
          : new GovernedToolExecutionError('Governed tool execution failed', call, {
          callId: toolCallId, content: error instanceof Error ? error.message : String(error), isError: true,
        }, error);
        if (tracker) recordGovernedToolFailure(tracker, toolCallId, governedError);
        throw governedError;
      }
      const facts = (result as ToolResult & { [GOVERNED_TOOL_FACTS]?: ToolExecutionOutcome })[GOVERNED_TOOL_FACTS];
      if (tracker && facts) recordGovernedToolFacts(tracker, toolCallId, facts);
      if (result.isError) {
        const error = new GovernedToolExecutionError(result.content, call, result);
        if (tracker) recordGovernedToolFailure(tracker, toolCallId, error);
        throw error;
      }
      return {
        content: [{ type: 'text', text: result.content }],
        details: result,
      };
    },
  };
}
