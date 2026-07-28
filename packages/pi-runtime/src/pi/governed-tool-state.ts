import type { ToolCall, ToolResult } from '@aiop/control-contracts';
import type { AgentHarnessEvent, AgentHarnessTool } from '@earendil-works/pi-agent-core';

export interface GovernedToolFailure {
  call: ToolCall;
  result: ToolResult;
}

interface GovernedToolFailureTracker {
  failures: Map<string, GovernedToolFailure>;
}

const TRACKERS = new WeakMap<AgentHarnessTool<undefined>, GovernedToolFailureTracker>();

export function createGovernedToolFailureTracker(): GovernedToolFailureTracker {
  return { failures: new Map() };
}

export function associateGovernedTool(
  tool: AgentHarnessTool<undefined>, tracker: GovernedToolFailureTracker,
): void {
  TRACKERS.set(tool, tracker);
}

export function recordGovernedToolFailure(
  tracker: GovernedToolFailureTracker, toolCallId: string, failure: GovernedToolFailure,
): void {
  tracker.failures.set(toolCallId, failure);
}

export function governedToolResultHook(tools: readonly AgentHarnessTool<undefined>[]): {
  patch(event: Extract<AgentHarnessEvent, { type: 'tool_result' }>): { details: unknown; isError: true } | undefined;
  clear(): void;
} {
  const trackersByName = new Map<string, GovernedToolFailureTracker>();
  for (const tool of tools) {
    const tracker = TRACKERS.get(tool);
    if (tracker) trackersByName.set(tool.name, tracker);
  }
  const trackers = new Set(trackersByName.values());
  return {
    patch(event) {
      const failure = trackersByName.get(event.toolName)?.failures.get(event.toolCallId);
      trackersByName.get(event.toolName)?.failures.delete(event.toolCallId);
      if (!event.isError || !failure) return undefined;
      return {
        details: { version: 1, kind: 'governed_tool_error', call: failure.call, result: failure.result },
        isError: true,
      };
    },
    clear() {
      for (const tracker of trackers) tracker.failures.clear();
    },
  };
}
