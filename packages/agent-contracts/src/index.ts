export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface IdentityContext {
  tenantId: string;
  actorId: string;
  roles: readonly string[];
  resourceScopes?: readonly string[];
  correlationId?: string;
}

export type AgentKernelName = 'pi' | 'legacy' | (string & {});
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'recovery_required';
export type WaitingReason = 'approval' | 'question' | 'plan' | 'external';
export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost_lease';

export interface AgentInputMessage {
  role: 'user';
  text?: string;
  content?: readonly AgentContentBlock[];
}

export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface RunLimits {
  maxTurns?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCostUsd?: number;
  deadlineAt?: Date;
}

export interface StartRunInput {
  runId?: string;
  identity: IdentityContext;
  sessionId: string;
  input: readonly AgentInputMessage[];
  messages?: readonly KernelMessage[];
  kernel?: AgentKernelName;
  limits?: RunLimits;
  signal?: AbortSignal;
}

export interface InteractionResolution {
  interactionId: string;
  value: JsonValue;
}

export interface ResumeRunInput {
  identity: IdentityContext;
  runId: string;
  resolution?: InteractionResolution;
  signal?: AbortSignal;
}

export interface CancelRunInput {
  identity: IdentityContext;
  runId: string;
  reason?: string;
}

export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
}

export interface AgentRunResult {
  runId: string;
  status: Extract<AgentRunStatus, 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required'>;
  text?: string;
  usage: AgentRunUsage;
  error?: AgentPlatformErrorData;
}

export interface RunHandle {
  runId: string;
  status: AgentRunStatus;
  events: AsyncIterable<AgentRunEvent>;
  result(): Promise<AgentRunResult>;
}

export interface AgentRuntime {
  run(input: StartRunInput): Promise<RunHandle>;
  resume(input: ResumeRunInput): Promise<RunHandle>;
  cancel(input: CancelRunInput): Promise<void>;
}

export interface KernelDescriptor {
  name: AgentKernelName;
  version: string;
  protocolVersion: string;
}

export interface KernelRunInput {
  runId: string;
  attemptId: string;
  turnNo: number;
  identity: IdentityContext;
  messages: readonly KernelMessage[];
  model: ModelBinding;
  tools: readonly ToolDefinition[];
  limits?: RunLimits;
  continuation?: boolean;
  signal?: AbortSignal;
}

export interface KernelControl {
  emit(event: KernelEvent): Promise<void>;
  shouldStopAfterTurn(turn: KernelTurnResult): Promise<boolean>;
  guard(): Promise<void>;
}

export interface AgentKernel {
  readonly descriptor: KernelDescriptor;
  run(input: KernelRunInput, control: KernelControl): Promise<KernelExit>;
}

export type KernelMessage =
  | { role: 'user'; content: readonly AgentContentBlock[] }
  | { role: 'assistant'; content: readonly AgentContentBlock[]; toolCalls?: readonly ToolCall[] }
  | { role: 'tool'; results: readonly ToolResult[] };

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
}

export type KernelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'context_compacted';
      tokensBefore: number;
      tokensAfter: number;
      summarizedMessages: number;
      version: number;
    }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'usage'; usage: AgentRunUsage }
  | { type: 'turn_end'; result: KernelTurnResult };

export interface ModelBinding {
  provider: string;
  model: string;
  route?: string;
  thinking?: string;
  contextWindowTokens?: number;
}

export interface ModelProvider {
  stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent>;
}

export interface ModelStreamInput {
  model: ModelBinding;
  system: string;
  messages: readonly KernelMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
}

export type ModelStreamEvent = KernelEvent | { type: 'stop'; reason: string };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: ToolCapability;
}

export type ToolCapability = 'read' | 'retryable_write' | 'non_idempotent_write';

export interface ToolCall {
  id: string;
  logicalCallId: string;
  name: string;
  arguments: JsonValue;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
  digest?: string;
}

export interface ToolExecutionContext {
  identity: IdentityContext;
  runId: string;
  attemptId: string;
  turnNo: number;
  signal?: AbortSignal;
}

export interface ToolRuntime {
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome>;
}

export interface AcquireSandboxInput {
  identity: IdentityContext;
  profile: string;
  cpu?: number;
  memoryMb?: number;
  timeoutMs?: number;
  network?: 'none' | 'restricted' | 'full';
}

export interface SandboxHandle {
  id: string;
  provider: string;
  profile: string;
}

export interface SandboxCommand {
  program: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface SandboxOutput {
  stream: 'stdout' | 'stderr';
  text: string;
  exitCode?: number;
}

export interface UploadFile {
  path: string;
  content: Uint8Array;
}

export interface DownloadFile {
  path: string;
  content: Uint8Array;
}

export interface SandboxProvider {
  acquire(input: AcquireSandboxInput): Promise<SandboxHandle>;
  execute(handle: SandboxHandle, command: SandboxCommand): AsyncIterable<SandboxOutput>;
  upload(handle: SandboxHandle, file: UploadFile): Promise<void>;
  download(handle: SandboxHandle, path: string): Promise<DownloadFile>;
  release(handle: SandboxHandle): Promise<void>;
}

export type ToolExecutionOutcome =
  | { kind: 'result'; result: ToolResult }
  | { kind: 'waiting'; reason: WaitingReason; interactionId: string }
  | { kind: 'recovery_required'; correlationId?: string; message: string };

export interface AgentRunEvent {
  tenantId: string;
  runId: string;
  sequence: bigint;
  type: string;
  attemptId?: string;
  turnNo?: number;
  detail?: JsonValue;
  createdAt: Date;
}

export type AgentPlatformErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_STATE_CONFLICT'
  | 'RUN_LIMIT_EXCEEDED'
  | 'LEASE_LOST'
  | 'TURN_COMMIT_FAILED'
  | 'TOOL_RESULT_UNKNOWN'
  | 'KERNEL_VERSION_UNAVAILABLE'
  | 'MODEL_PROVIDER_ERROR'
  | 'POLICY_DENIED';

export interface AgentPlatformErrorData {
  code: AgentPlatformErrorCode;
  message: string;
  retryable: boolean;
}

export class AgentPlatformError extends Error {
  readonly code: AgentPlatformErrorCode;
  readonly retryable: boolean;

  constructor(data: AgentPlatformErrorData) {
    super(data.message);
    this.name = 'AgentPlatformError';
    this.code = data.code;
    this.retryable = data.retryable;
  }
}
