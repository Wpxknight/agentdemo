// file: index.d.ts
export * from './pi/agent.js';
export * from './pi/compatibility.js';
export * from './pi/compaction.js';
export { EventCodec } from './pi/event-codec.js';
export type { EventCodecOptions } from './pi/event-codec.js';
export * from './pi/message-codec.js';
export * from './pi/models.js';
export * from './pi/session.js';
export * from './pi/skills.js';
export * from './pi/tool-bridge.js';
export * from './tools/adapter.js';
export * from './tools/approval.js';
export * from './tools/audit.js';
export * from './tools/concurrency.js';
export * from './tools/governance.js';
export * from './tools/ledger.js';
export * from './tools/policy.js';
export * from './tools/registry.js';
export * from './store/types.js';
export * from './store/memory.js';
export * from './store/mysql.js';
export * from './store/pi-session-mysql.js';
export * from './store/session-stats.js';
export * from './store/session-id.js';
export type { InteractionRepository, InteractionRecord, RuntimeStore, RuntimeTransaction, ToolLedgerApprovalClaim, ToolLedgerRepository, } from './store/runtime-spi.js';
export type { RunRecord as RuntimeRunRecord, TurnSnapshot as RuntimeTurnSnapshot, } from './store/runtime-spi.js';
export * from './store/runtime-memory.js';
export * from './store/runtime-mysql.js';
export * from './run/attempt.js';
export * from './run/cancellation.js';
export * from './run/event-stream.js';
export * from './run/inbox.js';
export * from './run/lease.js';
export * from './run/limits.js';
export * from './run/manager.js';
export * from './run/mysql-assembly.js';
export * from './run/memory-assembly.js';
export * from './run/recovery.js';

// file: pi/agent.d.ts
import type { AgentInputMessage, AgentRunEvent, DurableInteractionUpdate, DurableToolLedgerUpdate, IdentityContext, InteractionResolution, RunExecutionProfile } from '@aiop/control-contracts';
import { AgentHarness, type AgentHarnessResources, type AgentHarnessTool, type Session, type SessionCreateOptions, type SessionMetadata, type SessionRepo, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { Model, Models } from '@earendil-works/pi-ai';
import { EventCodec, type EventCodecOptions } from './event-codec.js';
export interface PiAgentSessionFactoryOptions<TMetadata extends SessionMetadata, TCreateOptions extends SessionCreateOptions, TListOptions> {
    repository: SessionRepo<TMetadata, TCreateOptions, TListOptions>;
    models: Models;
    model: Model<any>;
    systemPrompt?: string;
    resolveSystemPrompt?(input: {
        execution?: RunExecutionProfile;
    }): string | undefined;
    tools?: AgentHarnessTool<undefined>[];
    resolveTools?(input: {
        identity?: IdentityContext;
        sessionId?: string;
        events: EventCodecOptions;
        interactionResolution?: InteractionResolution;
        execution?: RunExecutionProfile;
    }): Promise<AgentHarnessTool<undefined>[]>;
    resources?: AgentHarnessResources;
}
type RequiredKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
type SessionCreateField<TCreateOptions extends SessionCreateOptions> = [
    RequiredKeys<Omit<TCreateOptions, 'id'>>
] extends [never] ? {
    session?: Omit<TCreateOptions, 'id'>;
} : {
    session: Omit<TCreateOptions, 'id'>;
};
export type CreatePiAgentSessionInput<TCreateOptions extends SessionCreateOptions = SessionCreateOptions> = {
    id?: string;
    identity?: IdentityContext;
    interactionResolution?: InteractionResolution;
    execution?: RunExecutionProfile;
    initialMessage: AgentInputMessage;
    events: EventCodecOptions;
} & SessionCreateField<TCreateOptions>;
export interface LoadPiAgentSessionInput<TMetadata extends SessionMetadata = SessionMetadata> {
    metadata: TMetadata;
    identity?: IdentityContext;
    interactionResolution?: InteractionResolution;
    execution?: RunExecutionProfile;
    initialMessage: AgentInputMessage;
    events: EventCodecOptions;
}
export declare class PiAgentSessionFactory<TMetadata extends SessionMetadata = SessionMetadata, TCreateOptions extends SessionCreateOptions = SessionCreateOptions, TListOptions = void> {
    private readonly options;
    constructor(options: PiAgentSessionFactoryOptions<TMetadata, TCreateOptions, TListOptions>);
    create(input: CreatePiAgentSessionInput<TCreateOptions>): Promise<PiAgentSession<TMetadata>>;
    load(input: LoadPiAgentSessionInput<TMetadata>): Promise<PiAgentSession<TMetadata>>;
    private resolveTools;
    private wrap;
}
export declare class PiAgentSession<TMetadata extends SessionMetadata = SessionMetadata> {
    private readonly session;
    private readonly harness;
    private readonly eventCodec;
    private closed;
    private closePromise?;
    private pendingMessage?;
    private activeRun?;
    private governedToolScope;
    private removeGovernedToolHook;
    private readonly pendingCustomEntries;
    private customFlushTail;
    constructor(session: Session<TMetadata>, harness: AgentHarness, initialMessage: AgentInputMessage, eventCodec: EventCodec);
    continue(signal?: AbortSignal): AsyncIterable<AgentRunEvent>;
    private iterate;
    steer(message: AgentInputMessage): Promise<void>;
    followUp(message: AgentInputMessage): Promise<void>;
    abort(): Promise<void>;
    setTools(tools: AgentHarnessTool<undefined>[]): Promise<void>;
    tools(): AgentHarnessTool<undefined>[];
    metadata(): Promise<TMetadata>;
    entries(): Promise<SessionTreeEntry[]>;
    leafId(): Promise<string | null>;
    takeToolExecutionFacts(): {
        ledgerUpdates: DurableToolLedgerUpdate[];
        interactionUpdates: DurableInteractionUpdate[];
    };
    appendCustomEntry(customType: string, data?: unknown): Promise<string>;
    close(): Promise<void>;
    private installGovernedToolHook;
    private flushPendingCustomEntries;
    private ensureOpen;
}
export {};

// file: pi/compaction.d.ts
import { compact, type CompactionError, type CompactionPreparation, type CompactionSettings, type Result, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
export declare const preparePiCompaction: (entries: readonly SessionTreeEntry[], settings: CompactionSettings) => Result<CompactionPreparation | undefined, CompactionError>;
export declare const compactPiCompaction: typeof compact;
export type { CompactionPreparation, CompactionSettings };

// file: pi/compatibility.d.ts
import type { Usage } from '@earendil-works/pi-ai';
export type CompatibleContentBlock = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    mimeType: string;
    data: string;
} | {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
};
export interface PiContentExtension {
    version: 1;
    kind: 'pi_content_block';
    value: unknown;
    index?: number;
}
export type CompatibleAgentMessage = {
    role: 'user';
    content: string | CompatibleContentBlock[];
    timestamp: number;
    extensions?: PiContentExtension[];
} | {
    role: 'assistant';
    content: CompatibleContentBlock[];
    api: string;
    provider: string;
    model: string;
    responseModel?: string;
    responseId?: string;
    diagnostics?: unknown[];
    usage: Usage;
    stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
    errorMessage?: string;
    timestamp: number;
    extensions?: PiContentExtension[];
} | {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: CompatibleContentBlock[];
    details?: unknown;
    usage?: Usage;
    addedToolNames?: string[];
    isError: boolean;
    timestamp: number;
    extensions?: PiContentExtension[];
};

// file: pi/event-codec.d.ts
import type { AgentRunEvent, JsonValue } from '@aiop/control-contracts';
import { type AgentHarnessEvent } from '@earendil-works/pi-agent-core';
export interface EventCodecOptions {
    tenantId: string;
    runId: string;
    attemptId: string;
    turnNo: number;
    correlationId: string;
    sequence: () => bigint;
    now?: () => Date;
}
export declare class EventCodec {
    private readonly options;
    private readonly now;
    private pendingCompactionMessages?;
    constructor(options: EventCodecOptions);
    fromPi(event: AgentHarnessEvent): AgentRunEvent;
}
export declare function toDurableJsonValue(value: unknown): JsonValue;

// file: pi/governed-tool-state.d.ts
import type { DurableInteractionUpdate, DurableToolLedgerUpdate, ToolCall, ToolExecutionOutcome, ToolResult } from '@aiop/control-contracts';
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
    createScoped(): {
        tool: AgentHarnessTool<undefined>;
        tracker: GovernedToolFailureTracker;
    };
}
export interface GovernedToolScope {
    tools: AgentHarnessTool<undefined>[];
    patch(event: Extract<AgentHarnessEvent, {
        type: 'tool_result';
    }>): {
        details: unknown;
        isError: true;
        terminate?: boolean;
    } | undefined;
    takeOutcome(): GovernedToolOutcomeError | undefined;
    takeFacts(): {
        ledgerUpdates: DurableToolLedgerUpdate[];
        interactionUpdates: DurableInteractionUpdate[];
    };
    hasPending(): boolean;
    clear(): void;
}
export declare function createGovernedToolFailureTracker(): GovernedToolFailureTracker;
export declare function markGovernedToolPrototype(tool: AgentHarnessTool<undefined>, descriptor: GovernedToolDescriptor): void;
export declare function markScopedGovernedTool(tool: AgentHarnessTool<undefined>, tracker: GovernedToolFailureTracker): void;
export declare function recordGovernedToolFailure(tracker: GovernedToolFailureTracker, toolCallId: string, failure: GovernedToolFailure): void;
export declare function recordGovernedToolOutcome(tracker: GovernedToolFailureTracker, toolCallId: string, outcome: GovernedToolOutcomeError): void;
export declare function recordGovernedToolFacts(tracker: GovernedToolFailureTracker, toolCallId: string, outcome: ToolExecutionOutcome): void;
export declare function scopeGovernedTools(tools: readonly AgentHarnessTool<undefined>[]): GovernedToolScope;
export declare function adoptGovernedToolScope(tools: readonly AgentHarnessTool<undefined>[]): GovernedToolScope;
export {};

// file: pi/message-codec.d.ts
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CompatibleAgentMessage } from './compatibility.js';
export declare class MessageCodec {
    toPi(message: CompatibleAgentMessage): AgentMessage;
    fromPi(message: AgentMessage): CompatibleAgentMessage;
}

// file: pi/models.d.ts
export type { Model, Models } from '@earendil-works/pi-ai';
/** Pi model calls are delegated directly to Models; this layer intentionally owns no retry policy. */
export declare const PI_KERNEL_VERSION = "0.82.1";

// file: pi/session.d.ts
export { InMemorySessionRepo, JsonlSessionRepo, Session, type SessionMetadata, type SessionRepo, type SessionTreeEntry, } from '@earendil-works/pi-agent-core';

// file: pi/skills.d.ts
import { type ExecutionEnv, type Skill, type SkillDiagnostic } from '@earendil-works/pi-agent-core';
export { formatSkillsForSystemPrompt, loadSourcedSkills, loadSkills, type Skill, type SkillDiagnostic, } from '@earendil-works/pi-agent-core';
export interface PiSkillIdentity {
    tenantId: string;
    userId?: string;
    role?: string;
}
/** Product DTO owned by the runtime package; applications may add fields structurally. */
export interface PiSkillProduct {
    id: string;
    name: string;
    path: string;
    version: string;
    tenantId: string;
    allowedTenantIds?: readonly string[];
    ownerUserId?: string;
    submittedByUserId?: string;
    visibility: 'public' | 'private' | 'shared';
    enabled: boolean;
    reviewed: boolean;
    allowedRoles?: readonly string[];
    credentials?: readonly string[];
    credentialFile?: string;
}
export type PiAvailableSkillLoader<TProduct extends PiSkillProduct> = (env: ExecutionEnv, sources: Array<{
    path: string;
    source: TProduct;
}>) => Promise<{
    skills: Array<{
        skill: Skill;
        source: TProduct;
    }>;
    diagnostics: Array<SkillDiagnostic & {
        source: TProduct;
    }>;
}>;
export interface LoadAvailableSkillsDeps<TProduct extends PiSkillProduct> {
    loader?: PiAvailableSkillLoader<TProduct>;
    formatter?: (skills: Skill[]) => string;
}
export declare function loadAvailableSkills<TProduct extends PiSkillProduct>(env: ExecutionEnv, products: readonly TProduct[], identity: PiSkillIdentity, deps?: LoadAvailableSkillsDeps<TProduct>): Promise<{
    skills: Skill[];
    loaded: Array<{
        skill: Skill;
        product: TProduct;
    }>;
    prompt: string;
    diagnostics: Array<SkillDiagnostic & {
        source: TProduct;
    }>;
}>;

// file: pi/tool-bridge.d.ts
import type { JsonValue, ToolCall, ToolDefinition, ToolExecutionOutcome, ToolResult } from '@aiop/control-contracts';
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';
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
    resolveLogicalCallId?: (input: {
        toolCallId: string;
        tool: ToolDefinition;
        arguments: JsonValue;
    }) => string;
}
export declare class GovernedToolExecutionError extends Error {
    readonly call: ToolCall;
    readonly result: ToolResult;
    constructor(message: string, call: ToolCall, result: ToolResult, cause?: unknown);
}
export declare class GovernedToolOutcomeError extends Error {
    readonly outcome: Exclude<ToolExecutionOutcome, {
        kind: 'result';
    }>;
    readonly is_bubble_up = true;
    readonly kind: Exclude<ToolExecutionOutcome['kind'], 'result'>;
    readonly interactionId?: string;
    readonly correlationId?: string;
    constructor(outcome: Exclude<ToolExecutionOutcome, {
        kind: 'result';
    }>);
}
export declare function attachGovernedToolFacts(result: ToolResult, outcome: ToolExecutionOutcome): ToolResult;
export declare function bridgeGovernedTools(tools: readonly GovernedTool[], options?: GovernedToolBridgeOptions): AgentHarnessTool<undefined>[];

// file: run/attempt.d.ts
export declare function nextTurnNo(lastTurnNo: number): number;

// file: run/cancellation.d.ts
import type { DurableRunStore } from '../store/types.js';
export declare function abortIfCancellationRequested(store: DurableRunStore, identity: {
    tenantId: string;
    runId: string;
}, abort: AbortController): Promise<void>;

// file: run/event-stream.d.ts
export declare class AsyncEventStream<T> implements AsyncIterable<T> {
    private readonly values;
    private readonly waiters;
    private closed;
    push(value: T): void;
    close(): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}

// file: run/inbox.d.ts
import type { AgentInputMessage } from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { DurableRunStore } from '../store/types.js';
export interface InboxCapableSession {
    steer(message: AgentInputMessage): Promise<void>;
    followUp(message: AgentInputMessage): Promise<void>;
    appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}
export declare function drainDurableInbox(input: {
    store: DurableRunStore;
    session: InboxCapableSession;
    entries: readonly SessionTreeEntry[];
    tenantId: string;
    runId: string;
    workerId: string;
    fencingToken: bigint;
    now: () => Date;
    claimTtlMs: number;
}): Promise<void>;

// file: run/lease.d.ts
import type { DurableRunStore } from '../store/types.js';
export declare function startLeaseHeartbeat(input: {
    store: DurableRunStore;
    tenantId: string;
    runId: string;
    workerId: string;
    fencingToken: bigint;
    leaseTtlMs: number;
    heartbeatMs: number;
    abort: AbortController;
    now: () => Date;
}): () => void;

// file: run/limits.d.ts
import { type AgentRunUsage, type RunLimits } from '@aiop/control-contracts';
export declare function assertAttemptAllowed(limits: RunLimits | undefined, attemptCount: number, now: Date): void;
export declare function assertTurnAllowed(limits: RunLimits | undefined, turnNo: number): void;
export declare function assertUsageAllowed(limits: RunLimits | undefined, usage: AgentRunUsage): void;
export declare function assertToolCallsAllowed(limits: RunLimits | undefined, toolCalls: number): void;

// file: run/manager.d.ts
import type { AgentInputMessage, AgentRunEvent, AppendRunMessageInput, CancelRunInput, DurableInteractionUpdate, DurableRunRuntime, DurableToolLedgerUpdate, RunHandle, StartRunInput, ResumeRunInput } from '@aiop/control-contracts';
import type { SessionMetadata, SessionTreeEntry } from '@earendil-works/pi-agent-core';
import { type InboxCapableSession } from './inbox.js';
import type { DurableRunStore } from '../store/types.js';
export interface ManagedPiSession extends InboxCapableSession {
    continue(signal?: AbortSignal): AsyncIterable<AgentRunEvent>;
    abort(): Promise<void>;
    close(): Promise<void>;
    metadata(): Promise<SessionMetadata & {
        tenantId?: string;
    }>;
    entries(): Promise<SessionTreeEntry[]>;
    leafId(): Promise<string | null>;
    takeToolExecutionFacts?(): {
        ledgerUpdates: DurableToolLedgerUpdate[];
        interactionUpdates: DurableInteractionUpdate[];
    };
}
export interface DurableRunSessionFactory {
    create(input: {
        id?: string;
        identity: StartRunInput['identity'];
        interactionResolution?: ResumeRunInput['resolution'];
        execution?: StartRunInput['execution'];
        initialMessage: AgentInputMessage;
        events: unknown;
        session?: Record<string, unknown>;
    }): Promise<ManagedPiSession>;
    load(input: {
        metadata: SessionMetadata & {
            tenantId?: string;
        };
        identity: StartRunInput['identity'];
        interactionResolution?: ResumeRunInput['resolution'];
        execution?: StartRunInput['execution'];
        initialMessage: AgentInputMessage;
        events: unknown;
    }): Promise<ManagedPiSession>;
}
export interface DurableRunManagerOptions {
    store: DurableRunStore;
    sessions: DurableRunSessionFactory;
    eventOptions(input: {
        tenantId: string;
        runId: string;
        attemptId: string;
        turnNo: number;
    }): unknown;
    workerId?: string;
    leaseTtlMs?: number;
    heartbeatMs?: number;
    inboxClaimTtlMs?: number;
    inboxPollMs?: number;
    now?: () => Date;
}
export declare class DurableRunManager implements DurableRunRuntime {
    private readonly options;
    private readonly workerId;
    private readonly leaseTtlMs;
    private readonly heartbeatMs;
    private readonly inboxClaimTtlMs;
    private readonly inboxPollMs;
    private readonly now;
    private readonly active;
    private readonly executions;
    constructor(options: DurableRunManagerOptions);
    run(input: StartRunInput): Promise<RunHandle>;
    resume(input: ResumeRunInput): Promise<RunHandle>;
    cancel(input: CancelRunInput): Promise<void>;
    append(input: AppendRunMessageInput): Promise<void>;
    private start;
    private execute;
    private syncEntries;
}

// file: run/memory-assembly.d.ts
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import type { AgentHarnessResources, AgentHarnessTool } from '@earendil-works/pi-agent-core';
import type { Model, Models } from '@earendil-works/pi-ai';
import { PiAgentSessionFactory, type PiAgentSessionFactoryOptions } from '../pi/agent.js';
import { MemoryRunStore } from '../store/memory.js';
import { DurableRunManager } from './manager.js';
export interface MemoryDurablePiRuntimeOptions {
    models: Models;
    model: Model<any>;
    systemPrompt?: string;
    resolveSystemPrompt?: PiAgentSessionFactoryOptions<any, any, any>['resolveSystemPrompt'];
    tools?: AgentHarnessTool<undefined>[];
    resolveTools?: PiAgentSessionFactoryOptions<any, any, any>['resolveTools'];
    resources?: AgentHarnessResources;
    workerId?: string;
    leaseTtlMs?: number;
    heartbeatMs?: number;
    inboxClaimTtlMs?: number;
    inboxPollMs?: number;
    now?: () => Date;
}
export declare function createMemoryDurablePiRuntime(options: MemoryDurablePiRuntimeOptions): {
    runtime: DurableRunManager;
    store: MemoryRunStore;
    sessions: InMemorySessionRepo;
    factory: PiAgentSessionFactory<import("@earendil-works/pi-agent-core").SessionMetadata, import("@earendil-works/pi-agent-core").SessionCreateOptions, void>;
};

// file: run/mysql-assembly.d.ts
import type { AgentHarnessResources, AgentHarnessTool } from '@earendil-works/pi-agent-core';
import type { Model, Models } from '@earendil-works/pi-ai';
import type { Kysely } from 'kysely';
import { PiAgentSessionFactory, type PiAgentSessionFactoryOptions } from '../pi/agent.js';
import { MysqlRunStore } from '../store/mysql.js';
import { PiMysqlSessionRepo } from '../store/pi-session-mysql.js';
import { DurableRunManager } from './manager.js';
export interface MysqlDurablePiRuntimeOptions {
    db: Kysely<any>;
    models: Models;
    model: Model<any>;
    systemPrompt?: string;
    resolveSystemPrompt?: PiAgentSessionFactoryOptions<any, any, any>['resolveSystemPrompt'];
    tools?: AgentHarnessTool<undefined>[];
    resolveTools?: PiAgentSessionFactoryOptions<any, any, any>['resolveTools'];
    resources?: AgentHarnessResources;
    workerId?: string;
    leaseTtlMs?: number;
    heartbeatMs?: number;
    inboxClaimTtlMs?: number;
    inboxPollMs?: number;
    now?: () => Date;
}
export declare function createMysqlDurablePiRuntime(options: MysqlDurablePiRuntimeOptions): {
    runtime: DurableRunManager;
    store: MysqlRunStore;
    sessions: PiMysqlSessionRepo;
    factory: PiAgentSessionFactory<import("../store/pi-session-mysql.js").PiMysqlSessionMetadata, {
        id?: string;
        tenantId: string;
        metadata?: Record<string, unknown>;
    }, {
        tenantId: string;
    }>;
};

// file: run/recovery.d.ts
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
export declare function committedInboxIds(entries: readonly SessionTreeEntry[]): Set<string>;

// file: store/memory.d.ts
import { type AgentRunEvent, type DurableInteractionUpdate } from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { ClaimInboxInput, ConsumeInboxInput, DurableRunStore, EnqueueInboxInput, PiSessionRecord, RunInboxMessage, SessionEntryRecord, StoredRun } from './types.js';
export declare class MemoryRunStore implements DurableRunStore {
    private readonly now;
    private readonly runs;
    private readonly attempts;
    private readonly events;
    private readonly sessionRecords;
    private readonly sessionEntries;
    private readonly inboxMessages;
    private readonly interactions;
    private readonly toolLedger;
    private transactionTail;
    constructor(now?: () => Date);
    create(input: Parameters<DurableRunStore['create']>[0]): Promise<StoredRun & {
        sessionCreated: boolean;
    }>;
    get(identity: {
        tenantId: string;
        runId: string;
    }): Promise<StoredRun | undefined>;
    claim(input: Parameters<DurableRunStore['claim']>[0]): Promise<Awaited<ReturnType<DurableRunStore['claim']>>>;
    renewLease(input: Parameters<DurableRunStore['renewLease']>[0]): Promise<void>;
    commitTurn(input: Parameters<DurableRunStore['commitTurn']>[0]): Promise<void>;
    requestCancellation(input: Parameters<DurableRunStore['requestCancellation']>[0]): Promise<void>;
    complete(input: Parameters<DurableRunStore['complete']>[0]): Promise<void>;
    listEvents(identity: {
        tenantId: string;
        runId: string;
    }, after?: bigint): Promise<AgentRunEvent[]>;
    appendEvents(input: Parameters<DurableRunStore['appendEvents']>[0]): Promise<void>;
    isCancellationRequested(identity: {
        tenantId: string;
        runId: string;
    }): Promise<boolean>;
    countAttempts(identity: {
        tenantId: string;
        runId: string;
    }): Promise<number>;
    getInteraction(identity: {
        tenantId: string;
        runId: string;
        interactionId: string;
    }): Promise<DurableInteractionUpdate | undefined>;
    resolveInteraction(record: DurableInteractionUpdate): Promise<boolean>;
    closeInbox(input: Parameters<DurableRunStore['closeInbox']>[0]): Promise<void>;
    readonly sessions: {
        create: (input: {
            tenantId: string;
            sessionId: string;
            createdAt: Date;
            metadata?: Record<string, unknown>;
        }) => Promise<PiSessionRecord>;
        get: (tenantId: string, sessionId: string) => Promise<PiSessionRecord | undefined>;
        appendEntry: (tenantId: string, sessionId: string, entry: SessionTreeEntry) => Promise<SessionEntryRecord>;
        listEntries: (tenantId: string, sessionId: string, options?: {
            afterSequence?: bigint;
            committedOnly?: boolean;
        }) => Promise<SessionEntryRecord[]>;
        getSessionStats: (tenantId: string, sessionId: string) => Promise<import("@earendil-works/pi-agent-core").SessionStats>;
        setCurrentLeaf: (tenantId: string, sessionId: string, leafId: string | null) => Promise<void>;
    };
    readonly inbox: {
        enqueue: (input: EnqueueInboxInput) => Promise<RunInboxMessage>;
        claimNext: (input: ClaimInboxInput) => Promise<RunInboxMessage | undefined>;
        markConsumed: (input: ConsumeInboxInput) => Promise<void>;
        list: (tenantId: string, runId: string) => Promise<RunInboxMessage[]>;
    };
    private requireLease;
    private hasSessionEntry;
    private reachableEntryIds;
    private lock;
}

// file: store/mysql.d.ts
import { type AgentRunEvent, type DurableInteractionUpdate, type RunRecord } from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { Kysely, Transaction } from 'kysely';
import type { ClaimInboxInput, ConsumeInboxInput, DurableRunStore, EnqueueInboxInput, PiSessionRecord, RunInboxMessage, SessionEntryRecord, StoredRun } from './types.js';
type Db = Kysely<any> | Transaction<any>;
export declare class MysqlRunStore implements DurableRunStore {
    private readonly db;
    private readonly transactionalView;
    private readonly now;
    constructor(db: Db, transactionalView?: boolean, now?: () => Date);
    create(input: Parameters<DurableRunStore['create']>[0]): Promise<RunRecord & {
        sessionCreated: boolean;
    }>;
    get(identity: {
        tenantId: string;
        runId: string;
    }): Promise<StoredRun | undefined>;
    claim(input: Parameters<DurableRunStore['claim']>[0]): Promise<Awaited<ReturnType<DurableRunStore['claim']>>>;
    renewLease(input: Parameters<DurableRunStore['renewLease']>[0]): Promise<void>;
    commitTurn(input: Parameters<DurableRunStore['commitTurn']>[0]): Promise<void>;
    requestCancellation(input: Parameters<DurableRunStore['requestCancellation']>[0]): Promise<void>;
    complete(input: Parameters<DurableRunStore['complete']>[0]): Promise<void>;
    listEvents(identity: {
        tenantId: string;
        runId: string;
    }, after?: bigint): Promise<AgentRunEvent[]>;
    appendEvents(input: Parameters<DurableRunStore['appendEvents']>[0]): Promise<void>;
    isCancellationRequested(identity: {
        tenantId: string;
        runId: string;
    }): Promise<boolean>;
    countAttempts(identity: {
        tenantId: string;
        runId: string;
    }): Promise<number>;
    getInteraction(identity: {
        tenantId: string;
        runId: string;
        interactionId: string;
    }): Promise<DurableInteractionUpdate | undefined>;
    resolveInteraction(record: DurableInteractionUpdate): Promise<boolean>;
    closeInbox(input: Parameters<DurableRunStore['closeInbox']>[0]): Promise<void>;
    readonly sessions: {
        create: (input: {
            tenantId: string;
            sessionId: string;
            createdAt: Date;
            metadata?: Record<string, unknown>;
        }) => Promise<PiSessionRecord>;
        get: (tenantId: string, sessionId: string) => Promise<PiSessionRecord | undefined>;
        appendEntry: (tenantId: string, sessionId: string, entry: SessionTreeEntry) => Promise<SessionEntryRecord>;
        listEntries: (tenantId: string, sessionId: string, options?: {
            afterSequence?: bigint;
            committedOnly?: boolean;
        }) => Promise<SessionEntryRecord[]>;
        getSessionStats: (tenantId: string, sessionId: string) => Promise<import("@earendil-works/pi-agent-core").SessionStats>;
        setCurrentLeaf: (tenantId: string, sessionId: string, leafId: string | null) => Promise<void>;
    };
    readonly inbox: {
        enqueue: (input: EnqueueInboxInput) => Promise<RunInboxMessage>;
        claimNext: (input: ClaimInboxInput) => Promise<RunInboxMessage | undefined>;
        markConsumed: (input: ConsumeInboxInput) => Promise<void>;
        list: (tenantId: string, runId: string) => Promise<RunInboxMessage[]>;
    };
    private transaction;
    private assertLease;
    private appendEvent;
}
export {};

// file: store/pi-session-mysql.d.ts
import { Session, type SessionEntryCursorOptions, type SessionForkOptions, type SessionMetadata, type SessionRepo, type SessionStats, type SessionStorage, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { ColumnType, Kysely, Transaction } from 'kysely';
type JsonColumn = ColumnType<unknown, string, string>;
type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;
export interface PiMysqlSessionMetadata extends SessionMetadata {
    tenantId: string;
    metadata?: Record<string, unknown>;
}
export interface PiMysqlSessionDatabase {
    pi_sessions: {
        tenant_id: string;
        session_id: string;
        current_leaf_id: string | null;
        committed_leaf_id: string | null;
        metadata_json: NullableJsonColumn;
        created_at: Date;
        updated_at: Date;
    };
    pi_session_entries: {
        tenant_id: string;
        session_id: string;
        entry_id: string;
        entry_seq: number;
        parent_id: string | null;
        entry_type: string;
        entry_json: JsonColumn;
        created_at: Date;
    };
}
type PiDb = Kysely<PiMysqlSessionDatabase> | Transaction<PiMysqlSessionDatabase>;
export declare class PiMysqlSessionStorage implements SessionStorage<PiMysqlSessionMetadata> {
    private readonly db;
    private readonly metadata;
    private readonly startFromCommitted;
    private hasWritten;
    constructor(db: PiDb, metadata: PiMysqlSessionMetadata, startFromCommitted?: boolean);
    getMetadata(): Promise<PiMysqlSessionMetadata>;
    getLeafId(): Promise<string | null>;
    setLeafId(leafId: string | null): Promise<void>;
    createEntryId(): Promise<string>;
    appendEntry(entry: SessionTreeEntry): Promise<void>;
    getEntry(id: string): Promise<SessionTreeEntry | undefined>;
    findEntries<TType extends SessionTreeEntry['type']>(type: TType): Promise<Array<Extract<SessionTreeEntry, {
        type: TType;
    }>>>;
    getLabel(id: string): Promise<string | undefined>;
    getSessionName(): Promise<string | undefined>;
    getSessionStats(): Promise<SessionStats>;
    getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]>;
    getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]>;
    private visibleEntries;
    private sessionRow;
    private withTransaction;
}
export declare class PiMysqlSessionRepo implements SessionRepo<PiMysqlSessionMetadata, {
    id?: string;
    tenantId: string;
    metadata?: Record<string, unknown>;
}, {
    tenantId: string;
}> {
    private readonly db;
    private readonly openFromCommitted;
    constructor(db: PiDb, openFromCommitted?: boolean);
    create(options: {
        id?: string;
        tenantId: string;
        metadata?: Record<string, unknown>;
    }): Promise<Session<PiMysqlSessionMetadata>>;
    open(metadata: PiMysqlSessionMetadata): Promise<Session<PiMysqlSessionMetadata>>;
    list(options: {
        tenantId: string;
    }): Promise<PiMysqlSessionMetadata[]>;
    delete(metadata: PiMysqlSessionMetadata): Promise<void>;
    fork(source: PiMysqlSessionMetadata, options: SessionForkOptions & {
        id?: string;
        tenantId: string;
        metadata?: Record<string, unknown>;
    }): Promise<Session<PiMysqlSessionMetadata>>;
}
export {};

// file: store/runtime-kernel.d.ts
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

// file: store/runtime-memory.d.ts
import { type AgentRunEvent } from '@aiop/control-contracts';
import type { AttemptRecord, CommitTurnInput, InteractionRecord, LeaseRecord, RunIdentity, RunRecord, RuntimeStore, RuntimeTransaction, ToolLedgerRecord, TurnCommit, TurnSnapshot } from './runtime-spi.js';
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
        claimPendingApproval: (input: import("./runtime-spi.js").ToolLedgerApprovalClaim) => Promise<boolean>;
    };
    readonly events: {
        append: (event: Omit<AgentRunEvent, "sequence">) => Promise<AgentRunEvent>;
        list: (identity: RunIdentity, after?: bigint) => Promise<AgentRunEvent[]>;
    };
    transaction<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T>;
    private lastEventSequence;
}
export {};

// file: store/runtime-mysql.d.ts
import { type AgentRunEvent } from '@aiop/control-contracts';
import type { AttemptRecord, CommitTurnInput, InteractionRecord, LeaseRecord, RunIdentity, RunRecord, RuntimeStore, RuntimeTransaction, ToolLedgerRecord, TurnCommit, TurnSnapshot } from './runtime-spi.js';
import type { ColumnType, Generated, Kysely, Transaction } from 'kysely';
type JsonColumn = ColumnType<unknown, string, string>;
type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;
export interface RuntimeMysqlDatabase {
    agent_runs: {
        tenant_id: string;
        run_id: string;
        user_id: string;
        session_id: string;
        kernel: string;
        kernel_version: string;
        graph_name: string;
        graph_version: string;
        runtime_version: string;
        status: string;
        waiting_reason: string | null;
        current_node: string | null;
        step_count: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        error_message: string | null;
        started_at: Date | null;
        updated_at: Date;
        completed_at: Date | null;
        cancel_requested_at: Date | null;
        lease_owner: string | null;
        lease_token: number;
        lease_expires_at: Date | null;
        created_at: Date;
    };
    agent_run_attempts: {
        tenant_id: string;
        run_id: string;
        attempt_id: string;
        worker_id: string;
        lease_token: number;
        kernel: string;
        kernel_version: string;
        status: string;
        error_code: string | null;
        error_message: string | null;
        started_at: Date;
        completed_at: Date | null;
    };
    agent_turn_snapshots: {
        tenant_id: string;
        run_id: string;
        attempt_id: string;
        turn_no: number;
        session_version: number;
        parent_commit_id: string | null;
        identity_json: JsonColumn;
        model_binding_json: JsonColumn;
        prompt_version: string;
        skill_set_version: string | null;
        tool_set_version: string;
        policy_version: string;
        limits_json: NullableJsonColumn;
        messages_json: JsonColumn;
        deadline_at: Date | null;
        created_at: Date;
    };
    agent_turn_commits: {
        tenant_id: string;
        run_id: string;
        attempt_id: string;
        turn_no: number;
        commit_id: string;
        transcript_version: number;
        stop_reason: string | null;
        usage_json: JsonColumn;
        messages_json: JsonColumn;
        event_sequence_end: number;
        committed_at: Date;
    };
    agent_interactions: {
        id: string;
        tenant_id: string;
        user_id: string;
        session_id: string;
        run_id: string;
        attempt_id: string | null;
        turn_no: number | null;
        kind: string;
        tool_call_id: string | null;
        payload: JsonColumn;
        status: string;
        resolution: ColumnType<unknown, string | null, string | null>;
        resolved_by: string | null;
        expires_at: Date;
        created_at: Date;
        resolved_at: Date | null;
    };
    agent_tool_executions: {
        tenant_id: string;
        run_id: string;
        attempt_id: string | null;
        turn_no: number | null;
        session_id: string;
        tool_call_id: string;
        logical_call_id: string;
        idempotency_key: string;
        capability: string;
        external_correlation_id: string | null;
        result_digest: string | null;
        approved_interaction_id: string | null;
        tool_name: string;
        args_digest: string;
        status: string;
        result: ColumnType<unknown, string | null, string | null>;
        started_at: Date;
        completed_at: Date | null;
        updated_at: Date;
    };
    agent_run_events: {
        id: Generated<number>;
        tenant_id: string;
        run_id: string;
        sequence: number;
        event_type: string;
        attempt_id: string | null;
        turn_no: number | null;
        kernel: string | null;
        kernel_version: string | null;
        correlation_id: string | null;
        node_name: string | null;
        status: string | null;
        detail: ColumnType<unknown, string | null, string | null>;
        created_at: Date;
    };
}
type RuntimeDb = Kysely<RuntimeMysqlDatabase> | Transaction<RuntimeMysqlDatabase>;
export declare class MysqlRuntimeStore implements RuntimeStore {
    private readonly db;
    private readonly transactionalView;
    constructor(db: RuntimeDb, transactionalView?: boolean);
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
        list: (identity: RunIdentity) => Promise<InteractionRecord[]>;
    };
    readonly toolLedger: {
        putIfAbsent: (record: ToolLedgerRecord) => Promise<boolean>;
        get: (identity: RunIdentity & {
            logicalCallId: string;
        }) => Promise<ToolLedgerRecord | undefined>;
        update: (record: ToolLedgerRecord) => Promise<void>;
        claimPendingApproval: (input: import("./runtime-spi.js").ToolLedgerApprovalClaim) => Promise<boolean>;
    };
    readonly events: {
        append: (event: Omit<AgentRunEvent, "sequence">) => Promise<AgentRunEvent>;
        list: (identity: RunIdentity, after?: bigint) => Promise<AgentRunEvent[]>;
    };
    transaction<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T>;
    private withTransaction;
    private assertCommitLease;
}
export {};

// file: store/runtime-spi.d.ts
import type { AgentKernelName, AgentRunEvent, AgentRunStatus, AgentRunUsage, AttemptStatus, DurableInteractionUpdate, DurableToolLedgerUpdate, IdentityContext, RunLimits, WaitingReason } from '@aiop/control-contracts';
import type { KernelMessage, ModelBinding } from './runtime-kernel.js';
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

// file: store/session-id.d.ts
/** Keeps the product session id stable while isolating Pi's internal session tree by owner. */
export declare function piSessionStorageId(actorId: string, sessionId: string): string;

// file: store/session-stats.d.ts
import type { SessionStats, SessionTreeEntry } from '@earendil-works/pi-agent-core';
export declare function sessionStats(entries: readonly SessionTreeEntry[]): SessionStats;

// file: store/types.d.ts
import type { AgentInputMessage, AgentRunEvent, AgentRunResult, ClaimRunInput, ClaimedRun, CommitTurnInput, CompleteRunInput, CreateRunRecord, DurableInteractionUpdate, RenewLeaseInput, RequestCancellationInput, RunRecord, RunStore } from '@aiop/control-contracts';
import type { SessionStats, SessionTreeEntry } from '@earendil-works/pi-agent-core';
export interface StoredRun extends RunRecord {
    cancelRequestedAt?: Date;
    cancelReason?: string;
    result?: AgentRunResult;
    lastTurnNo: number;
    checkpoint?: unknown;
    appendClosedAt?: Date;
}
export type DurableRunCreateResult = RunRecord & {
    sessionCreated: boolean;
};
export interface PiSessionRecord {
    tenantId: string;
    sessionId: string;
    createdAt: Date;
    updatedAt: Date;
    currentLeafId: string | null;
    committedLeafId: string | null;
    metadata?: Record<string, unknown>;
}
export interface SessionEntryRecord {
    tenantId: string;
    sessionId: string;
    sequence: bigint;
    entry: SessionTreeEntry;
}
export interface RunInboxMessage {
    tenantId: string;
    runId: string;
    id: string;
    sequence: bigint;
    idempotencyKey: string;
    mode: 'steer' | 'follow_up';
    message: AgentInputMessage;
    status: 'pending' | 'claimed' | 'consumed';
    claimOwner?: string;
    claimToken?: string;
    claimExpiresAt?: Date;
    createdAt: Date;
    consumedAt?: Date;
}
export interface EnqueueInboxInput {
    identity: ClaimRunInput['identity'];
    tenantId: string;
    runId: string;
    idempotencyKey: string;
    mode: RunInboxMessage['mode'];
    message: AgentInputMessage;
    createdAt: Date;
}
export interface CloseInboxInput {
    tenantId: string;
    runId: string;
    workerId: string;
    fencingToken: bigint;
    now: Date;
}
export interface AppendRunEventsInput {
    tenantId: string;
    runId: string;
    attemptId: string;
    fencingToken: bigint;
    events: readonly Omit<AgentRunEvent, 'sequence'>[];
    appendedAt: Date;
}
export interface ClaimInboxInput {
    tenantId: string;
    runId: string;
    workerId: string;
    fencingToken: bigint;
    now: Date;
    claimTtlMs: number;
}
export interface ConsumeInboxInput extends ClaimInboxInput {
    id: string;
    claimToken: string;
    consumedAt: Date;
}
export interface PiSessionStore {
    create(input: {
        tenantId: string;
        sessionId: string;
        createdAt: Date;
        metadata?: Record<string, unknown>;
    }): Promise<PiSessionRecord>;
    get(tenantId: string, sessionId: string): Promise<PiSessionRecord | undefined>;
    appendEntry(tenantId: string, sessionId: string, entry: SessionTreeEntry): Promise<SessionEntryRecord>;
    listEntries(tenantId: string, sessionId: string, options?: {
        afterSequence?: bigint;
        committedOnly?: boolean;
    }): Promise<SessionEntryRecord[]>;
    getSessionStats(tenantId: string, sessionId: string): Promise<SessionStats>;
    setCurrentLeaf(tenantId: string, sessionId: string, leafId: string | null): Promise<void>;
}
export interface RunInboxStore {
    enqueue(input: EnqueueInboxInput): Promise<RunInboxMessage>;
    claimNext(input: ClaimInboxInput): Promise<RunInboxMessage | undefined>;
    markConsumed(input: ConsumeInboxInput): Promise<void>;
    list(tenantId: string, runId: string): Promise<RunInboxMessage[]>;
}
export interface DurableRunStore extends RunStore {
    create(input: CreateRunRecord): Promise<DurableRunCreateResult>;
    get(identity: {
        tenantId: string;
        runId: string;
    }): Promise<StoredRun | undefined>;
    listEvents(identity: {
        tenantId: string;
        runId: string;
    }, after?: bigint): Promise<AgentRunEvent[]>;
    appendEvents(input: AppendRunEventsInput): Promise<void>;
    isCancellationRequested(identity: {
        tenantId: string;
        runId: string;
    }): Promise<boolean>;
    countAttempts(identity: {
        tenantId: string;
        runId: string;
    }): Promise<number>;
    getInteraction(identity: {
        tenantId: string;
        runId: string;
        interactionId: string;
    }): Promise<DurableInteractionUpdate | undefined>;
    resolveInteraction(record: DurableInteractionUpdate): Promise<boolean>;
    closeInbox(input: CloseInboxInput): Promise<void>;
    sessions: PiSessionStore;
    inbox: RunInboxStore;
}
export type { ClaimRunInput, ClaimedRun, CommitTurnInput, CompleteRunInput, CreateRunRecord, RenewLeaseInput, RequestCancellationInput };

// file: tools/adapter.d.ts
import type { JsonValue, ToolCall, ToolDefinition, ToolExecutionContext, ToolResult } from '@aiop/control-contracts';
import type { AgentTool } from '@earendil-works/pi-agent-core';
export interface GovernedToolDefinition extends ToolDefinition {
    interactionKind?: 'question' | 'plan';
    execute(call: ToolCall, context: ToolExecutionContext & {
        idempotencyKey: string;
    }): Promise<Omit<ToolResult, 'callId'>>;
}
export type ToolSource = 'pi' | 'aiop' | 'mcp' | 'sandbox';
export interface RegisteredToolSource {
    source: ToolSource;
    definition: GovernedToolDefinition;
}
export declare function adaptPiAgentTool(tool: AgentTool, capability: ToolDefinition['capability']): GovernedToolDefinition;
export declare function resourceKeyFromArguments(toolName: string, args: JsonValue): string | undefined;

// file: tools/approval.d.ts
import type { DurableInteractionUpdate, JsonValue, ToolCall, ToolExecutionContext } from '@aiop/control-contracts';
import type { ToolPolicyDecision } from './policy.js';
export interface ToolApprovalDecision {
    approved: boolean;
    pending?: boolean;
    interactionId?: string;
    payload?: JsonValue;
}
export interface ToolApproval {
    request(call: ToolCall, context: ToolExecutionContext, decision: ToolPolicyDecision): Promise<ToolApprovalDecision>;
}
export interface ToolInteractionStore {
    get(input: {
        tenantId: string;
        runId: string;
        interactionId: string;
    }): Promise<DurableInteractionUpdate | undefined>;
}

// file: tools/audit.d.ts
import type { ToolCapability } from '@aiop/control-contracts';
export type ToolAuditStatus = 'unknown_tool' | 'cached_completed' | 'ledger_mismatch' | 'policy_denied' | 'approval_waiting' | 'invalid_resolution' | 'recovery_required' | 'success' | 'failure' | 'internal_error';
export interface ToolAuditEvent {
    tenantId: string;
    actorId: string;
    runId: string;
    attemptId: string;
    turnNo: number;
    sessionId?: string;
    toolName: string;
    toolCallId: string;
    logicalCallId: string;
    capability?: ToolCapability;
    argsDigest: string;
    status: ToolAuditStatus;
    outcomeKind: 'result' | 'waiting' | 'recovery_required' | 'exception';
    isError: boolean;
    errorCode?: string;
    resultDigest?: string;
    durationMs: number;
    recordedAt: Date;
}
export interface ToolAudit {
    record(event: ToolAuditEvent): Promise<void>;
    failure?(error: unknown, event: ToolAuditEvent): void;
}

// file: tools/concurrency.d.ts
export interface ResourceConcurrency {
    run<T>(input: {
        tenantId: string;
        resourceKey?: string;
        signal?: AbortSignal;
    }, work: () => Promise<T>): Promise<T>;
}
export declare class ResourceConcurrencyController implements ResourceConcurrency {
    private readonly maxConcurrentPerResource;
    private readonly tenants;
    constructor(maxConcurrentPerResource?: number);
    run<T>(input: {
        tenantId: string;
        resourceKey?: string;
        signal?: AbortSignal;
    }, work: () => Promise<T>): Promise<T>;
}

// file: tools/governance.d.ts
import type { ToolRuntime } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from './adapter.js';
import type { ToolApproval, ToolInteractionStore } from './approval.js';
import type { ToolAudit } from './audit.js';
import { type ResourceConcurrency } from './concurrency.js';
import { type ToolLedgerStore } from './ledger.js';
import type { ToolPolicy } from './policy.js';
export interface GovernedToolFactoryOptions {
    ledger: ToolLedgerStore;
    policy?: ToolPolicy;
    approval?: ToolApproval;
    interactions?: ToolInteractionStore;
    concurrency?: ResourceConcurrency;
    audit?: ToolAudit;
    now?: () => Date;
}
export declare class GovernedToolFactory {
    private readonly options;
    constructor(options: GovernedToolFactoryOptions);
    create(definitions: readonly GovernedToolDefinition[]): ToolRuntime;
}

// file: tools/ledger.d.ts
import type { DurableToolLedgerUpdate, JsonValue } from '@aiop/control-contracts';
export interface ToolLedgerIdentity {
    tenantId: string;
    runId: string;
    logicalCallId: string;
}
export interface ToolLedgerStore {
    putIfAbsent(record: DurableToolLedgerUpdate): Promise<boolean>;
    get(identity: ToolLedgerIdentity): Promise<DurableToolLedgerUpdate | undefined>;
    update(record: DurableToolLedgerUpdate): Promise<void>;
    claimPendingApproval(input: ToolApprovalClaim): Promise<boolean>;
}
export interface ToolApprovalClaim extends ToolLedgerIdentity {
    attemptId: string;
    turnNo: number;
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    approvedInteractionId: string;
    started: DurableToolLedgerUpdate;
}
export declare function digestToolValue(value: JsonValue | string): string;

// file: tools/policy.d.ts
import type { ToolCall, ToolExecutionContext } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from './adapter.js';
export interface ToolPolicyDecision {
    allowed: boolean;
    reason?: string;
    needsApproval?: boolean;
    resourceKey?: string;
}
export interface ToolPolicy {
    check(call: ToolCall, context: ToolExecutionContext, tool: GovernedToolDefinition): Promise<ToolPolicyDecision>;
}

// file: tools/registry.d.ts
import type { GovernedToolDefinition, RegisteredToolSource, ToolSource } from './adapter.js';
import type { ToolCapability } from '@aiop/control-contracts';
import type { AgentTool } from '@earendil-works/pi-agent-core';
export declare class UnifiedToolRegistry {
    private readonly tools;
    register(source: ToolSource, definition: GovernedToolDefinition): this;
    registerPi(tool: AgentTool, capability: ToolCapability): this;
    unregister(name: string): boolean;
    names(): string[];
    definitions(): GovernedToolDefinition[];
    entries(): RegisteredToolSource[];
}
