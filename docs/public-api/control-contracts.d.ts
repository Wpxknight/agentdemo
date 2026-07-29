// file: errors.d.ts
export type AgentPlatformErrorCode = 'RUN_NOT_FOUND' | 'RUN_STATE_CONFLICT' | 'RUN_LIMIT_EXCEEDED' | 'LEASE_LOST' | 'TURN_COMMIT_FAILED' | 'TOOL_RESULT_UNKNOWN' | 'KERNEL_VERSION_UNAVAILABLE' | 'MODEL_PROVIDER_ERROR' | 'POLICY_DENIED';
export interface AgentPlatformErrorData {
    code: AgentPlatformErrorCode;
    message: string;
    retryable: boolean;
}
export declare class AgentPlatformError extends Error {
    readonly code: AgentPlatformErrorCode;
    readonly retryable: boolean;
    constructor(data: AgentPlatformErrorData);
}
export declare class RunNotFoundError extends AgentPlatformError {
    constructor(message?: string);
}
export declare class LeaseLostError extends AgentPlatformError {
    constructor(message?: string);
}
export declare class PolicyDeniedError extends AgentPlatformError {
    constructor(message?: string);
}
export declare class RecoveryRequiredError extends AgentPlatformError {
    constructor(message?: string);
}

// file: events.d.ts
import type { JsonValue } from './json.js';
import type { AgentKernelName, AgentRunStatus } from './run.js';
export interface AgentRunEvent {
    tenantId: string;
    runId: string;
    sequence: bigint;
    type: string;
    attemptId: string;
    turnNo: number;
    kernel: AgentKernelName;
    kernelVersion: string;
    correlationId: string;
    detail?: JsonValue;
    createdAt: Date;
}
export interface SseProjectionEvent {
    id: string;
    event: string;
    data: JsonValue;
}
export type RuntimeMetric = {
    kind: 'counter';
    name: string;
    value: number;
} | {
    kind: 'timer';
    name: string;
    value: number;
    unit: 'ms';
};
export interface RuntimeObservation {
    type: 'run_started' | 'run_finished' | 'attempt_started' | 'attempt_finished' | 'turn_started' | 'turn_committed' | 'lease_lost' | 'context_compacted' | 'tool_call' | 'tool_result' | 'waiting' | 'recovery_required' | 'sse_replay';
    tenantId: string;
    runId: string;
    attemptId: string;
    turnNo: number;
    kernel: AgentKernelName;
    kernelVersion: string;
    correlationId: string;
    metric: RuntimeMetric;
    status?: AgentRunStatus;
    detail?: JsonValue;
    occurredAt: Date;
}

// file: identity.d.ts
export type TenantId = string;
export type ActorId = string;
export type RoleName = string;
export type ResourceScope = string;
export interface IdentityContext {
    tenantId: TenantId;
    actorId: ActorId;
    roles: readonly RoleName[];
    resourceScopes?: readonly ResourceScope[];
    correlationId?: string;
}

// file: index.d.ts
export type * from './identity.js';
export type * from './json.js';
export type * from './run.js';
export type * from './interaction.js';
export type * from './tool.js';
export type * from './events.js';
export * from './errors.js';

// file: interaction.d.ts
import type { IdentityContext } from './identity.js';
import type { JsonValue } from './json.js';
export type WaitingReason = 'approval' | 'question' | 'plan' | 'external';
export type InteractionKind = Exclude<WaitingReason, 'external'>;
export type InteractionStatus = 'pending' | 'resolved' | 'cancelled' | 'expired';
export interface InteractionResolution {
    interactionId: string;
    value: JsonValue;
}
export interface ResolveInteractionInput extends InteractionResolution {
    identity: IdentityContext;
    runId: string;
}
export interface ResolvedInteraction {
    interactionId: string;
    kind: InteractionKind;
    toolCallId: string;
    value: JsonValue;
}
export interface DurableInteractionUpdate {
    tenantId: string;
    runId: string;
    id: string;
    userId?: string;
    sessionId?: string;
    attemptId: string;
    turnNo: number;
    kind: InteractionKind;
    toolCallId?: string;
    status: InteractionStatus;
    payload: JsonValue;
    resolution?: JsonValue;
    resolvedBy?: string;
    expiresAt?: Date;
    createdAt: Date;
    resolvedAt?: Date;
}

// file: json.d.ts
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};

// file: run.d.ts
import type { AgentPlatformErrorData } from './errors.js';
import type { AgentRunEvent } from './events.js';
import type { IdentityContext } from './identity.js';
import type { DurableInteractionUpdate, InteractionResolution, WaitingReason } from './interaction.js';
import type { JsonValue } from './json.js';
import type { DurableToolLedgerUpdate } from './tool.js';
export type AgentKernelName = 'pi' | (string & {});
export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required';
export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost_lease';
export type AgentContentBlock = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    mimeType: string;
    data: string;
};
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
export interface RunExecutionProfile {
    /** The run has no interactive user waiting for confirmations. */
    unattended?: boolean;
    /** Approval-capable task creator explicitly authorized ordinary production changes. */
    preApproved?: boolean;
}
export interface StartRunInput {
    runId?: string;
    identity: IdentityContext;
    sessionId: string;
    input: readonly AgentInputMessage[];
    kernel?: AgentKernelName;
    limits?: RunLimits;
    execution?: RunExecutionProfile;
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
export interface RunExecutionAttempt {
    attemptId: string;
    workerId: string;
    fencingToken: bigint;
}
export interface RunHandle {
    runId: string;
    status: AgentRunStatus;
    events: AsyncIterable<AgentRunEvent>;
    attempt(): Promise<RunExecutionAttempt>;
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
    execution?: RunExecutionProfile;
    usage: AgentRunUsage;
    createdAt: Date;
    updatedAt: Date;
}
export interface CreateRunRecord {
    record: RunRecord;
}
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
export interface ClaimedRun {
    record: RunRecord;
    attemptId: string;
    fencingToken: bigint;
}
export interface RenewLeaseInput {
    tenantId: string;
    runId: string;
    workerId: string;
    fencingToken: bigint;
    now: Date;
    leaseTtlMs: number;
}
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
export interface RequestCancellationInput {
    identity: IdentityContext;
    runId: string;
    reason?: string;
    requestedAt: Date;
}
export interface CompleteRunInput {
    tenantId: string;
    runId: string;
    attemptId: string;
    fencingToken: bigint;
    status: Extract<AgentRunStatus, 'succeeded' | 'failed' | 'cancelled' | 'recovery_required'>;
    usage: AgentRunUsage;
    error?: AgentPlatformErrorData;
    completedAt: Date;
}
/**
 * Minimal persistence port for durable run orchestration and fencing.
 * Product queries and repositories belong to runtime-internal extensions, not this control contract.
 */
export interface RunStore {
    create(input: CreateRunRecord): Promise<RunRecord>;
    claim(input: ClaimRunInput): Promise<ClaimedRun | null>;
    renewLease(input: RenewLeaseInput): Promise<void>;
    commitTurn(input: CommitTurnInput): Promise<void>;
    requestCancellation(input: RequestCancellationInput): Promise<void>;
    complete(input: CompleteRunInput): Promise<void>;
}

// file: tool.d.ts
import type { IdentityContext } from './identity.js';
import type { ResolvedInteraction, WaitingReason, DurableInteractionUpdate } from './interaction.js';
import type { JsonValue } from './json.js';
export type ToolCapability = 'read' | 'retryable_write' | 'non_idempotent_write';
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    capability: ToolCapability;
}
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
    sessionId?: string;
    interactionResolution?: ResolvedInteraction;
    signal?: AbortSignal;
}
export interface DurableToolLedgerUpdate {
    tenantId: string;
    runId: string;
    attemptId: string;
    turnNo: number;
    logicalCallId: string;
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    capability: ToolCapability;
    idempotencyKey: string;
    status: 'pending_approval' | 'started' | 'completed' | 'unknown' | 'recovery_required';
    externalCorrelationId?: string;
    resultDigest?: string;
    approvedInteractionId?: string;
    result?: ToolResult;
    createdAt: Date;
    updatedAt: Date;
}
export interface DurableExecutionFacts {
    ledgerUpdates?: readonly DurableToolLedgerUpdate[];
    interactionUpdates?: readonly DurableInteractionUpdate[];
}
export type ToolExecutionOutcome = ({
    kind: 'result';
    result: ToolResult;
} | {
    kind: 'waiting';
    reason: WaitingReason;
    interactionId: string;
} | {
    kind: 'recovery_required';
    correlationId?: string;
    message: string;
}) & DurableExecutionFacts;
export interface ToolRuntime {
    execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome>;
}
