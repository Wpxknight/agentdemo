import type {
  DurableInteractionUpdate, DurableToolLedgerUpdate, ToolCall, ToolExecutionOutcome, ToolResult,
} from '@aiop/control-contracts';
import type { AgentHarnessEvent, AgentHarnessTool } from '@earendil-works/pi-agent-core';
import type { GovernedToolOutcomeError } from './tool-bridge.js';

export interface GovernedToolFailure {
  call: ToolCall;
  result: ToolResult;
}

export interface GovernedToolFailureTracker {
  failures: Map<string, GovernedToolFailure[]>;
  outcomes: Map<string, GovernedToolOutcomeError[]>;
  facts: Map<string, ToolExecutionOutcome[]>;
}

interface GovernedToolDescriptor {
  createScoped(): { tool: AgentHarnessTool<undefined>; tracker: GovernedToolFailureTracker };
}

export interface GovernedToolScope {
  tools: AgentHarnessTool<undefined>[];
  patch(event: Extract<AgentHarnessEvent, { type: 'tool_result' }>): { details: unknown; isError: true; terminate?: boolean } | undefined;
  takeOutcome(): GovernedToolOutcomeError | undefined;
  takeFacts(): { ledgerUpdates: DurableToolLedgerUpdate[]; interactionUpdates: DurableInteractionUpdate[] };
  hasPending(): boolean;
  clear(): void;
}

const GOVERNED_TOOL_DESCRIPTOR = Symbol('aiop.pi.governedToolDescriptor');
const SCOPED_TRACKERS = new WeakMap<AgentHarnessTool<undefined>, GovernedToolFailureTracker>();

export function createGovernedToolFailureTracker(): GovernedToolFailureTracker {
  return { failures: new Map(), outcomes: new Map(), facts: new Map() };
}

export function markGovernedToolPrototype(
  tool: AgentHarnessTool<undefined>, descriptor: GovernedToolDescriptor,
): void {
  Object.defineProperty(tool, GOVERNED_TOOL_DESCRIPTOR, { value: descriptor });
}

export function markScopedGovernedTool(
  tool: AgentHarnessTool<undefined>, tracker: GovernedToolFailureTracker,
): void {
  SCOPED_TRACKERS.set(tool, tracker);
}

export function recordGovernedToolFailure(
  tracker: GovernedToolFailureTracker, toolCallId: string, failure: GovernedToolFailure,
): void {
  const queue = tracker.failures.get(toolCallId);
  if (queue) queue.push(failure);
  else tracker.failures.set(toolCallId, [failure]);
}

export function recordGovernedToolOutcome(
  tracker: GovernedToolFailureTracker, toolCallId: string, outcome: GovernedToolOutcomeError,
): void {
  const queue = tracker.outcomes.get(toolCallId);
  if (queue) queue.push(outcome);
  else tracker.outcomes.set(toolCallId, [outcome]);
}

export function recordGovernedToolFacts(
  tracker: GovernedToolFailureTracker, toolCallId: string, outcome: ToolExecutionOutcome,
): void {
  const queue = tracker.facts.get(toolCallId);
  if (queue) queue.push(outcome);
  else tracker.facts.set(toolCallId, [outcome]);
}

export function scopeGovernedTools(tools: readonly AgentHarnessTool<undefined>[]): GovernedToolScope {
  const scoped = tools.map((tool) => {
    const descriptor = governedDescriptor(tool);
    return descriptor ? descriptor.createScoped().tool : tool;
  });
  return adoptGovernedToolScope(scoped);
}

export function adoptGovernedToolScope(tools: readonly AgentHarnessTool<undefined>[]): GovernedToolScope {
  const trackersByName = new Map<string, GovernedToolFailureTracker>();
  for (const tool of tools) {
    const tracker = SCOPED_TRACKERS.get(tool);
    if (tracker) trackersByName.set(tool.name, tracker);
  }
  const trackers = new Set(trackersByName.values());
  const pendingOutcomes: GovernedToolOutcomeError[] = [];
  const ledgerUpdates: DurableToolLedgerUpdate[] = [];
  const interactionUpdates: DurableInteractionUpdate[] = [];
  return {
    tools: [...tools],
    patch(event) {
      const tracker = trackersByName.get(event.toolName);
      const factsQueue = tracker?.facts.get(event.toolCallId);
      const facts = factsQueue?.shift();
      if (factsQueue?.length === 0) tracker?.facts.delete(event.toolCallId);
      if (facts) {
        ledgerUpdates.push(...(facts.ledgerUpdates ?? []));
        interactionUpdates.push(...(facts.interactionUpdates ?? []));
      }
      if (!event.isError) return undefined;
      const outcomeQueue = tracker?.outcomes.get(event.toolCallId);
      const outcome = outcomeQueue?.shift();
      if (outcomeQueue?.length === 0) tracker?.outcomes.delete(event.toolCallId);
      if (outcome) {
        pendingOutcomes.push(outcome);
        return {
          details: { version: 1, kind: 'governed_tool_outcome', outcome: outcome.outcome },
          isError: true,
          terminate: true,
        };
      }
      const queue = tracker?.failures.get(event.toolCallId);
      const failure = queue?.shift();
      if (queue?.length === 0) tracker?.failures.delete(event.toolCallId);
      if (!failure) return undefined;
      return {
        details: { version: 1, kind: 'governed_tool_error', call: failure.call, result: failure.result },
        isError: true,
      };
    },
    takeOutcome() {
      return pendingOutcomes.shift();
    },
    takeFacts() {
      const result = { ledgerUpdates: ledgerUpdates.splice(0), interactionUpdates: interactionUpdates.splice(0) };
      return result;
    },
    hasPending() {
      if (pendingOutcomes.length > 0) return true;
      if (ledgerUpdates.length > 0 || interactionUpdates.length > 0) return true;
      for (const tracker of trackers) {
        for (const queue of tracker.facts.values()) if (queue.length > 0) return true;
        for (const queue of tracker.outcomes.values()) if (queue.length > 0) return true;
        for (const queue of tracker.failures.values()) if (queue.length > 0) return true;
      }
      return false;
    },
    clear() {
      pendingOutcomes.length = 0;
      ledgerUpdates.length = 0;
      interactionUpdates.length = 0;
      for (const tracker of trackers) {
        tracker.failures.clear();
        tracker.outcomes.clear();
        tracker.facts.clear();
      }
    },
  };
}

function governedDescriptor(tool: AgentHarnessTool<undefined>): GovernedToolDescriptor | undefined {
  return (tool as AgentHarnessTool<undefined> & {
    [GOVERNED_TOOL_DESCRIPTOR]?: GovernedToolDescriptor;
  })[GOVERNED_TOOL_DESCRIPTOR];
}
