// file: index.d.ts
export type * from './kernel.js';
export * from './store.js';
export * from './memory-store.js';
export * from './model-concurrency.js';
export * from './runtime.js';

// file: kernel.d.ts
import type { AgentContentBlock, AgentKernelName, AgentPlatformErrorData, AgentRunUsage, DurableInteractionUpdate, DurableToolLedgerUpdate, IdentityContext, ResolvedInteraction, RunLimits, ToolCall, ToolDefinition, ToolResult, WaitingReason } from '@aiop/control-contracts';
export interface KernelDescriptor {
    name: AgentKernelName;
    version: string;
    protocolVersion: string;
}
export type KernelMessage = {
    role: 'user';
    content: readonly AgentContentBlock[];
} | {
    role: 'assistant';
    content: readonly AgentContentBlock[];
    thinking?: string;
    toolCalls?: readonly ToolCall[];
} | {
    role: 'tool';
    results: readonly ToolResult[];
};
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
export type KernelEvent = {
    type: 'text_delta';
    text: string;
} | {
    type: 'thinking_delta';
    text: string;
} | {
    type: 'context_compacted';
    tokensBefore: number;
    tokensAfter: number;
    summarizedMessages: number;
    version: number;
} | {
    type: 'tool_call';
    call: ToolCall;
} | {
    type: 'tool_result';
    result: ToolResult;
} | {
    type: 'usage';
    usage: AgentRunUsage;
} | {
    type: 'turn_end';
    result: KernelTurnResult;
};
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
export type ModelStreamEvent = KernelEvent | {
    type: 'stop';
    reason: string;
};

// file: memory-store.d.ts
import { type AgentRunEvent } from '@aiop/control-contracts';
import type { AttemptRecord, CommitTurnInput, InteractionRecord, LeaseRecord, RunIdentity, RunRecord, RuntimeStore, RuntimeTransaction, ToolLedgerRecord, TurnCommit, TurnSnapshot } from './store.js';
interface MemoryState {
    runs: Map<string, RunRecord>;
    attempts: Map<string, AttemptRecord>;
    snapshots: Map<string, TurnSnapshot>;
    commits: Map<string, TurnCommit>;
    interactions: Map<string, InteractionRecord>;
    ledger: Map<string, ToolLedgerRecord>;
    events: Map<string, AgentRunEvent[]>;
}
export declare class MemoryRuntimeStore implements RuntimeStore {
    private readonly transactionalView;
    private state;
    private transactionTail;
    constructor(state?: MemoryState, transactionalView?: boolean);
    readonly runs: {
        create: (record: RunRecord) => Promise<void>;
        get: (identity: RunIdentity) => Promise<RunRecord | undefined>;
        update: (identity: RunIdentity, patch: Partial<RunRecord>) => Promise<void>;
        acquireLease: (identity: RunIdentity, ownerId: string, now: Date, ttlMs: number) => Promise<LeaseRecord | undefined>;
        renewLease: (identity: RunIdentity, ownerId: string, token: bigint, now: Date, ttlMs: number) => Promise<boolean>;
        assertLease: (identity: RunIdentity, ownerId: string, token: bigint, now: Date) => Promise<void>;
    };
    readonly attempts: {
        create: (record: AttemptRecord) => Promise<void>;
        update: (identity: RunIdentity & {
            attemptId: string;
        }, patch: Partial<AttemptRecord>) => Promise<void>;
        list: (identity: RunIdentity) => Promise<AttemptRecord[]>;
    };
    readonly turns: {
        createSnapshot: (snapshot: TurnSnapshot) => Promise<void>;
        getSnapshot: (identity: RunIdentity & {
            attemptId: string;
            turnNo: number;
        }) => Promise<TurnSnapshot | undefined>;
        getLastCommitted: (identity: RunIdentity) => Promise<TurnCommit | undefined>;
        listCommitted: (identity: RunIdentity) => Promise<TurnCommit[]>;
        commit: (input: CommitTurnInput) => Promise<TurnCommit>;
    };
    readonly interactions: {
        put: (record: InteractionRecord) => Promise<void>;
        get: (identity: RunIdentity & {
            interactionId: string;
        }) => Promise<InteractionRecord | undefined>;
        getById: (tenantId: string, interactionId: string) => Promise<InteractionRecord | undefined>;
        list: (identity: RunIdentity) => Promise<InteractionRecord[]>;
        listByTenant: (tenantId: string) => Promise<InteractionRecord[]>;
    };
    readonly toolLedger: {
        putIfAbsent: (record: ToolLedgerRecord) => Promise<boolean>;
        get: (identity: RunIdentity & {
            logicalCallId: string;
        }) => Promise<ToolLedgerRecord | undefined>;
        update: (record: ToolLedgerRecord) => Promise<void>;
        claimPendingApproval: (input: import("./store.js").ToolLedgerApprovalClaim) => Promise<boolean>;
    };
    readonly events: {
        append: (event: Omit<AgentRunEvent, "sequence">) => Promise<AgentRunEvent>;
        list: (identity: RunIdentity, after?: bigint) => Promise<AgentRunEvent[]>;
    };
    transaction<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T>;
    private lastEventSequence;
}
export {};

// file: model-concurrency.d.ts
import type { ModelConcurrencyController, ModelConcurrencyInput } from './kernel.js';
export interface FifoModelConcurrencyControllerOptions {
    maxConcurrentPerTenantModel?: number;
}
export declare class FifoModelConcurrencyController implements ModelConcurrencyController {
    private readonly semaphores;
    private readonly limit;
    constructor(options?: FifoModelConcurrencyControllerOptions);
    acquire(input: ModelConcurrencyInput): Promise<() => void>;
}

// file: runtime.d.ts
import { type AgentKernelName, type CancelRunInput, type ResumeRunInput, type RunHandle, type RuntimeObservation, type StartRunInput, type ToolDefinition } from '@aiop/control-contracts';
import type { AgentKernel, KernelEvent, KernelMessage, ModelBinding } from './kernel.js';
import type { RuntimeStore } from './store.js';
export interface DurableAgentRuntimeOptions {
    store: RuntimeStore;
    kernels: readonly AgentKernel[];
    defaultKernel: AgentKernelName;
    workerId?: string;
    runtimeVersion?: string;
    modelBinding?: ModelBinding;
    tools?: readonly ToolDefinition[];
    promptVersion?: string;
    skillSetVersion?: string;
    toolSetVersion?: string;
    policyVersion?: string;
    leaseTtlMs?: number;
    maxDurableEventsPerTurn?: number;
    now?: () => Date;
    observeEvent?: (event: KernelEvent) => void | Promise<void>;
    observe?: (observation: RuntimeObservation) => void | Promise<void>;
}
export interface DurableRuntimeStartRunInput extends StartRunInput {
    messages?: readonly KernelMessage[];
}
export declare class DurableAgentRuntime {
    private readonly options;
    private readonly kernels;
    private readonly active;
    private readonly workerId;
    private readonly runtimeVersion;
    private readonly modelBinding;
    private readonly tools;
    private readonly promptVersion;
    private readonly skillSetVersion?;
    private readonly toolSetVersion;
    private readonly policyVersion;
    private readonly leaseTtlMs;
    private readonly leaseHeartbeatMs;
    private readonly maxDurableEventsPerTurn;
    private readonly now;
    private readonly executions;
    constructor(options: DurableAgentRuntimeOptions);
    run(input: DurableRuntimeStartRunInput): Promise<RunHandle>;
    resume(input: ResumeRunInput): Promise<RunHandle>;
    cancel(input: CancelRunInput): Promise<void>;
    shutdown(reason?: string): Promise<void>;
    private startHandle;
    private execute;
    private snapshot;
    private guard;
    private release;
    private assertAttemptBudget;
    private kernelEvent;
    private eventStream;
    private resolveKernel;
    private observe;
    private emitObservation;
}

// file: store.d.ts
import type { AgentKernelName, AgentRunEvent, AgentRunStatus, AgentRunUsage, AttemptStatus, DurableInteractionUpdate, DurableToolLedgerUpdate, IdentityContext, RunLimits, WaitingReason } from '@aiop/control-contracts';
import type { KernelMessage, ModelBinding } from './kernel.js';
export interface RunIdentity {
    tenantId: string;
    runId: string;
}
export interface RunRecord extends RunIdentity {
    actorId: string;
    sessionId: string;
    kernel: AgentKernelName;
    kernelVersion: string;
    runtimeVersion: string;
    status: AgentRunStatus;
    waitingReason?: WaitingReason;
    leaseOwner?: string;
    leaseToken: bigint;
    leaseExpiresAt?: Date;
    cancelRequestedAt?: Date;
    usage: AgentRunUsage;
    createdAt: Date;
    updatedAt: Date;
}
export interface AttemptRecord extends RunIdentity {
    attemptId: string;
    workerId: string;
    leaseToken: bigint;
    kernel: AgentKernelName;
    kernelVersion: string;
    status: AttemptStatus;
    errorCode?: string;
    errorMessage?: string;
    startedAt: Date;
    completedAt?: Date;
}
export interface TurnSnapshot extends RunIdentity {
    attemptId: string;
    turnNo: number;
    sessionVersion: bigint;
    parentCommitId?: string;
    identity: IdentityContext;
    modelBinding: ModelBinding;
    promptVersion: string;
    skillSetVersion?: string;
    toolSetVersion: string;
    policyVersion: string;
    limits?: RunLimits;
    deadlineAt?: Date;
    messages: readonly KernelMessage[];
    createdAt: Date;
}
export interface TurnCommit extends RunIdentity {
    attemptId: string;
    turnNo: number;
    commitId: string;
    transcriptVersion: bigint;
    stopReason?: string;
    usage: AgentRunUsage;
    eventSequenceEnd: bigint;
    messages: readonly KernelMessage[];
    committedAt: Date;
}
export interface CommitTurnInput {
    leaseOwner: string;
    leaseToken: bigint;
    snapshot: TurnSnapshot;
    commit: Omit<TurnCommit, 'eventSequenceEnd'>;
    events: readonly Omit<AgentRunEvent, 'sequence'>[];
    runStatus: AgentRunStatus;
    waitingReason?: WaitingReason;
    ledgerUpdates?: readonly ToolLedgerRecord[];
    interactionUpdates?: readonly InteractionRecord[];
}
export type InteractionRecord = DurableInteractionUpdate;
export type ToolLedgerRecord = DurableToolLedgerUpdate;
export interface LeaseRecord {
    ownerId: string;
    token: bigint;
    expiresAt: Date;
}
export interface RunRepository {
    create(record: RunRecord): Promise<void>;
    get(identity: RunIdentity): Promise<RunRecord | undefined>;
    update(identity: RunIdentity, patch: Partial<RunRecord>): Promise<void>;
    acquireLease(identity: RunIdentity, ownerId: string, now: Date, ttlMs: number): Promise<LeaseRecord | undefined>;
    renewLease(identity: RunIdentity, ownerId: string, token: bigint, now: Date, ttlMs: number): Promise<boolean>;
    assertLease(identity: RunIdentity, ownerId: string, token: bigint, now: Date): Promise<void>;
}
export interface AttemptRepository {
    create(record: AttemptRecord): Promise<void>;
    update(identity: RunIdentity & {
        attemptId: string;
    }, patch: Partial<AttemptRecord>): Promise<void>;
    list(identity: RunIdentity): Promise<AttemptRecord[]>;
}
export interface TurnRepository {
    createSnapshot(snapshot: TurnSnapshot): Promise<void>;
    getSnapshot(identity: RunIdentity & {
        attemptId: string;
        turnNo: number;
    }): Promise<TurnSnapshot | undefined>;
    getLastCommitted(identity: RunIdentity): Promise<TurnCommit | undefined>;
    listCommitted(identity: RunIdentity): Promise<TurnCommit[]>;
    commit(input: CommitTurnInput): Promise<TurnCommit>;
}
export interface InteractionRepository {
    put(record: InteractionRecord): Promise<void>;
    get(identity: RunIdentity & {
        interactionId: string;
    }): Promise<InteractionRecord | undefined>;
    list(identity: RunIdentity): Promise<InteractionRecord[]>;
}
export interface ToolLedgerRepository {
    putIfAbsent(record: ToolLedgerRecord): Promise<boolean>;
    get(identity: RunIdentity & {
        logicalCallId: string;
    }): Promise<ToolLedgerRecord | undefined>;
    update(record: ToolLedgerRecord): Promise<void>;
    claimPendingApproval(input: ToolLedgerApprovalClaim): Promise<boolean>;
}
export interface ToolLedgerApprovalClaim extends RunIdentity {
    logicalCallId: string;
    attemptId: string;
    turnNo: number;
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    approvedInteractionId: string;
    started: ToolLedgerRecord;
}
export interface RunEventRepository {
    append(event: Omit<AgentRunEvent, 'sequence'>): Promise<AgentRunEvent>;
    list(identity: RunIdentity, after?: bigint): Promise<AgentRunEvent[]>;
}
export interface RuntimeTransaction {
    runs: RunRepository;
    attempts: AttemptRepository;
    turns: TurnRepository;
    interactions: InteractionRepository;
    toolLedger: ToolLedgerRepository;
    events: RunEventRepository;
}
/** Migration-era internal runtime SPI; it is not the control-contracts RunStore target port. */
export interface RuntimeStore extends RuntimeTransaction {
    transaction<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T>;
}
