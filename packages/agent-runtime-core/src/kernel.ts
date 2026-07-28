import type {
  AgentContentBlock,
  AgentKernelName,
  AgentPlatformErrorData,
  AgentRunUsage,
  DurableInteractionUpdate,
  DurableToolLedgerUpdate,
  IdentityContext,
  ResolvedInteraction,
  RunLimits,
  ToolCall,
  ToolDefinition,
  ToolResult,
  WaitingReason,
} from '@aiop/control-contracts';

export interface KernelDescriptor {
  name: AgentKernelName;
  version: string;
  protocolVersion: string;
}

export type KernelMessage =
  | { role: 'user'; content: readonly AgentContentBlock[] }
  | { role: 'assistant'; content: readonly AgentContentBlock[]; thinking?: string; toolCalls?: readonly ToolCall[] }
  | { role: 'tool'; results: readonly ToolResult[] };

export interface ModelBinding {
  provider: string;
  model: string;
  route?: string;
  thinking?: string;
  contextWindowTokens?: number;
  rolloutMode?: 'read-only' | 'dry-run' | 'replay' | 'full';
  comparisonRunId?: string;
}

export interface KernelRunInput {
  runId: string;
  attemptId: string;
  turnNo: number;
  sessionId?: string;
  identity: IdentityContext;
  messages: readonly KernelMessage[];
  model: ModelBinding;
  tools: readonly ToolDefinition[];
  limits?: RunLimits;
  continuation?: boolean;
  interactionResolution?: ResolvedInteraction;
  signal?: AbortSignal;
}

export interface KernelTurnResult {
  turnNo: number;
  stopReason?: string;
  usage: AgentRunUsage;
  messages: readonly KernelMessage[];
  waitingReason?: WaitingReason;
}

export interface KernelExit extends KernelTurnResult {
  outcome: 'continue' | 'waiting' | 'completed' | 'failed' | 'recovery_required';
  error?: AgentPlatformErrorData;
  ledgerUpdates?: readonly DurableToolLedgerUpdate[];
  interactionUpdates?: readonly DurableInteractionUpdate[];
}

export type KernelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'context_compacted'; tokensBefore: number; tokensAfter: number; summarizedMessages: number; version: number }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'usage'; usage: AgentRunUsage }
  | { type: 'turn_end'; result: KernelTurnResult };

export interface KernelControl {
  emit(event: KernelEvent): Promise<void>;
  shouldStopAfterTurn(turn: KernelTurnResult): Promise<boolean>;
  guard(): Promise<void>;
}

export interface AgentKernel {
  readonly descriptor: KernelDescriptor;
  run(input: KernelRunInput, control: KernelControl): Promise<KernelExit>;
}

export interface ModelProvider {
  stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent>;
}

export interface ModelConcurrencyInput {
  identity: IdentityContext;
  model: ModelBinding;
  signal?: AbortSignal;
}

export interface ModelConcurrencyController {
  acquire(input: ModelConcurrencyInput): Promise<() => void>;
}

export interface ModelStreamInput {
  model: ModelBinding;
  system: string;
  messages: readonly KernelMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
}

export type ModelStreamEvent = KernelEvent | { type: 'stop'; reason: string };
