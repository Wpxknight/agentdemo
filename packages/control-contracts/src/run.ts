import type { AgentPlatformErrorData } from './errors.js';
import type { AgentRunEvent } from './events.js';
import type { IdentityContext } from './identity.js';
import type { DurableInteractionUpdate, InteractionResolution, WaitingReason } from './interaction.js';
import type { JsonValue } from './json.js';
import type { DurableToolLedgerUpdate } from './tool.js';

export type AgentKernelName = 'pi' | (string & {});
export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required';
export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost_lease';

export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface AgentInputMessage {
  role: 'user';
  text?: string;
  content?: readonly AgentContentBlock[];
}

export interface RunLimits {
  maxAttempts?: number;
  maxTurns?: number;
  maxToolCalls?: number;
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
  kernel?: AgentKernelName;
  limits?: RunLimits;
  signal?: AbortSignal;
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

export interface AppendRunMessageInput {
  identity: IdentityContext;
  runId: string;
  message: AgentInputMessage;
  mode: 'steer' | 'follow_up';
  idempotencyKey: string;
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

/**
 * Target durable control-plane port implemented by the Pi-first run manager.
 * Migration-era AgentRuntime and runtime-core SPIs must not be treated as implementations of this port.
 */
export interface DurableRunRuntime {
  run(input: StartRunInput): Promise<RunHandle>;
  resume(input: ResumeRunInput): Promise<RunHandle>;
  cancel(input: CancelRunInput): Promise<void>;
  append(input: AppendRunMessageInput): Promise<void>;
}

/** Legacy compatibility surface retained while callers migrate to DurableRunRuntime. */
export interface AgentRuntime extends Omit<DurableRunRuntime, 'append'> {
  append?(input: AppendRunMessageInput): Promise<void>;
}

export interface RunRecord {
  tenantId: string;
  runId: string;
  actorId: string;
  sessionId: string;
  kernel: AgentKernelName;
  kernelVersion: string;
  status: AgentRunStatus;
  waitingReason?: WaitingReason;
  leaseToken: bigint;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  limits?: RunLimits;
  usage: AgentRunUsage;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRunRecord { record: RunRecord }
export interface ClaimRunInput {
  identity: IdentityContext;
  runId: string;
  workerId: string;
  now: Date;
  leaseTtlMs: number;
  /**
   * Explicit migration-era resume path. Authorized resumes may reopen appendability for
   * waiting, failed, or recovery-required runs; ordinary claims cannot revive those states.
   * Succeeded and cancelled runs remain terminal even when this is true.
   */
  resume?: boolean;
  resolution?: InteractionResolution;
}
export interface ClaimedRun { record: RunRecord; attemptId: string; fencingToken: bigint }
export interface RenewLeaseInput { tenantId: string; runId: string; workerId: string; fencingToken: bigint; now: Date; leaseTtlMs: number }
export interface CommitTurnInput {
  tenantId: string;
  runId: string;
  attemptId: string;
  turnNo: number;
  fencingToken: bigint;
  checkpoint: JsonValue;
  events: readonly Omit<AgentRunEvent, 'sequence'>[];
  status: AgentRunStatus;
  waitingReason?: WaitingReason;
  usage: AgentRunUsage;
  error?: AgentPlatformErrorData;
  ledgerUpdates?: readonly DurableToolLedgerUpdate[];
  interactionUpdates?: readonly DurableInteractionUpdate[];
  committedAt: Date;
}
export interface RequestCancellationInput { identity: IdentityContext; runId: string; reason?: string; requestedAt: Date }
export interface CompleteRunInput { tenantId: string; runId: string; attemptId: string; fencingToken: bigint; status: Extract<AgentRunStatus, 'succeeded' | 'failed' | 'cancelled' | 'recovery_required'>; usage: AgentRunUsage; error?: AgentPlatformErrorData; completedAt: Date }

/**
 * Target persistence port for durable run orchestration and fencing.
 * The migration-era runtime-core RuntimeStore is an internal SPI with different snapshot semantics.
 */
export interface RunStore {
  create(input: CreateRunRecord): Promise<RunRecord>;
  claim(input: ClaimRunInput): Promise<ClaimedRun | null>;
  renewLease(input: RenewLeaseInput): Promise<void>;
  commitTurn(input: CommitTurnInput): Promise<void>;
  requestCancellation(input: RequestCancellationInput): Promise<void>;
  complete(input: CompleteRunInput): Promise<void>;
}
