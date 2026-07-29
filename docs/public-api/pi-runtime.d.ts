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
export * from './model/concurrency.js';
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

// file: model/concurrency.d.ts
import { type Models } from '@earendil-works/pi-ai';
import type { IdentityContext } from '@aiop/control-contracts';
export interface ModelConcurrencyInput {
    identity: IdentityContext;
    model: {
        provider: string;
        model: string;
        route?: string;
    };
    signal?: AbortSignal;
}
export interface ModelConcurrencyController {
    acquire(input: ModelConcurrencyInput): Promise<() => void>;
}
export interface FifoModelConcurrencyControllerOptions {
    maxConcurrentPerTenantModel?: number;
}
export declare class FifoModelConcurrencyController implements ModelConcurrencyController {
    private readonly semaphores;
    private readonly limit;
    constructor(options?: FifoModelConcurrencyControllerOptions);
    /** Diagnostic count used to verify semaphore lifecycle without exposing queue contents. */
    get activeKeyCount(): number;
    acquire(input: ModelConcurrencyInput): Promise<() => void>;
}
export declare function createConcurrentModels(models: Models, controller: ModelConcurrencyController, identity: IdentityContext): Models;

// file: pi/agent.d.ts
import type { AgentInputMessage, AgentRunEvent, DurableInteractionUpdate, DurableToolLedgerUpdate, IdentityContext, ResolvedInteraction, RunExecutionProfile } from '@aiop/control-contracts';
import { AgentHarness, type AgentHarnessResources, type AgentHarnessTool, type Session, type SessionCreateOptions, type SessionMetadata, type SessionRepo, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { Model, Models } from '@earendil-works/pi-ai';
import { EventCodec, type EventCodecOptions } from './event-codec.js';
import { type ModelConcurrencyController } from '../model/concurrency.js';
export interface PiAgentSessionFactoryOptions<TMetadata extends SessionMetadata, TCreateOptions extends SessionCreateOptions, TListOptions> {
    repository: SessionRepo<TMetadata, TCreateOptions, TListOptions>;
    models: Models;
    model: Model<any>;
    modelConcurrency?: ModelConcurrencyController;
    systemPrompt?: string;
    resolveSystemPrompt?(input: {
        execution?: RunExecutionProfile;
    }): string | undefined;
    tools?: AgentHarnessTool<undefined>[];
    resolveTools?(input: {
        identity?: IdentityContext;
        sessionId?: string;
        events: EventCodecOptions;
        interactionResolution?: ResolvedInteraction;
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
    interactionResolution?: ResolvedInteraction;
    execution?: RunExecutionProfile;
    initialMessage: AgentInputMessage;
    events: EventCodecOptions;
} & SessionCreateField<TCreateOptions>;
export interface LoadPiAgentSessionInput<TMetadata extends SessionMetadata = SessionMetadata> {
    metadata: TMetadata;
    identity?: IdentityContext;
    interactionResolution?: ResolvedInteraction;
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
    replayInteraction(resolution: ResolvedInteraction, signal?: AbortSignal): Promise<void>;
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
    isGoverned(tool: AgentHarnessTool<undefined>): boolean;
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
import type { AgentInputMessage, AgentRunEvent, AppendRunMessageInput, CancelRunInput, DurableInteractionUpdate, DurableRunRuntime, DurableToolLedgerUpdate, ResolvedInteraction, RunHandle, StartRunInput, ResumeRunInput } from '@aiop/control-contracts';
import type { SessionMetadata, SessionTreeEntry } from '@earendil-works/pi-agent-core';
import { type InboxCapableSession } from './inbox.js';
import type { DurableRunStore } from '../store/types.js';
export interface ManagedPiSession extends InboxCapableSession {
    continue(signal?: AbortSignal): AsyncIterable<AgentRunEvent>;
    replayInteraction?(resolution: ResolvedInteraction, signal?: AbortSignal): Promise<void>;
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
        interactionResolution?: ResolvedInteraction;
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
        interactionResolution?: ResolvedInteraction;
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
    store?: MemoryRunStore;
    modelConcurrency?: PiAgentSessionFactoryOptions<any, any, any>['modelConcurrency'];
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
    store?: MysqlRunStore;
    models: Models;
    model: Model<any>;
    modelConcurrency?: PiAgentSessionFactoryOptions<any, any, any>['modelConcurrency'];
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
import { type AgentRunEvent, type DurableInteractionUpdate, type DurableToolLedgerUpdate } from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { ClaimInboxInput, ConsumeInboxInput, DurableRunStore, EnqueueInboxInput, PiSessionRecord, RunInboxMessage, SessionEntryRecord, StoredRun, DurableProductRunStore, ProductAttemptRecord, ProductTurnCommit } from './types.js';
export declare class MemoryRunStore implements DurableProductRunStore {
    private readonly now;
    private readonly baseState;
    private transactionTail;
    private readonly mutationContext;
    private get runRecords();
    private get attemptsState();
    private get commits();
    private get eventRecords();
    private get sessionRecords();
    private get sessionEntries();
    private get inboxMessages();
    private get interactionRecords();
    private get toolLedgerRecords();
    constructor(now?: () => Date);
    create(input: Parameters<DurableRunStore['create']>[0]): Promise<StoredRun & {
        sessionCreated: boolean;
    }>;
    get(identity: {
        tenantId: string;
        runId: string;
    }): Promise<StoredRun | undefined>;
    listRuns(tenantId: string): Promise<StoredRun[]>;
    updateProductRun(identity: {
        tenantId: string;
        runId: string;
    }, patch: Partial<StoredRun>): Promise<boolean>;
    markRecoveryRequired(input: {
        identity: Parameters<DurableRunStore['claim']>[0]['identity'];
        runId: string;
        errorMessage: string;
        failedAt: Date;
        expectedLease?: {
            ownerId: string;
            token: bigint;
        };
    }): Promise<boolean>;
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
    readonly runs: {
        assertLease: (identity: {
            tenantId: string;
            runId: string;
        }, ownerId: string, token: bigint, now: Date) => Promise<void>;
    };
    readonly attempts: {
        list: (identity: {
            tenantId: string;
            runId: string;
        }) => Promise<ProductAttemptRecord[]>;
    };
    readonly turns: {
        listCommitted: (identity: {
            tenantId: string;
            runId: string;
        }) => Promise<ProductTurnCommit[]>;
    };
    readonly interactions: {
        put: (record: DurableInteractionUpdate) => Promise<void>;
        get: (identity: {
            tenantId: string;
            runId: string;
            interactionId: string;
        }) => Promise<DurableInteractionUpdate | undefined>;
        getById: (tenantId: string, interactionId: string) => Promise<DurableInteractionUpdate | undefined>;
        list: (identity: {
            tenantId: string;
            runId: string;
        }) => Promise<DurableInteractionUpdate[]>;
        listByTenant: (tenantId: string) => Promise<DurableInteractionUpdate[]>;
    };
    readonly toolLedger: {
        putIfAbsent: (record: DurableToolLedgerUpdate) => Promise<boolean>;
        get: (identity: {
            tenantId: string;
            runId: string;
            logicalCallId: string;
        }) => Promise<DurableToolLedgerUpdate | undefined>;
        update: (record: DurableToolLedgerUpdate) => Promise<void>;
        claimPendingApproval: (input: import("./types.js").ToolLedgerApprovalClaim) => Promise<boolean>;
        list: (identity: {
            tenantId: string;
            runId: string;
        }) => Promise<DurableToolLedgerUpdate[]>;
    };
    readonly events: {
        append: (event: Omit<AgentRunEvent, "sequence">) => Promise<AgentRunEvent>;
        list: (identity: {
            tenantId: string;
            runId: string;
        }, after?: bigint) => Promise<AgentRunEvent[]>;
    };
    transaction<T>(work: (tx: DurableProductRunStore) => Promise<T>): Promise<T>;
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
    private runsState;
    private interactionsState;
    private toolLedgerState;
    private eventsState;
    private hasSessionEntry;
    private reachableEntryIds;
    private lock;
    private currentState;
}

// file: store/mysql.d.ts
import { type AgentRunEvent, type DurableInteractionUpdate, type DurableToolLedgerUpdate, type RunRecord } from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { Kysely, Transaction } from 'kysely';
import type { ClaimInboxInput, ConsumeInboxInput, DurableRunStore, EnqueueInboxInput, PiSessionRecord, RunInboxMessage, SessionEntryRecord, StoredRun, DurableProductRunStore, ProductAttemptRecord, ProductTurnCommit } from './types.js';
type Db = Kysely<any> | Transaction<any>;
export declare class MysqlRunStore implements DurableProductRunStore {
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
    listRuns(tenantId: string): Promise<StoredRun[]>;
    updateProductRun(identity: {
        tenantId: string;
        runId: string;
    }, patch: Partial<StoredRun>): Promise<boolean>;
    markRecoveryRequired(input: {
        identity: Parameters<DurableRunStore['claim']>[0]['identity'];
        runId: string;
        errorMessage: string;
        failedAt: Date;
        expectedLease?: {
            ownerId: string;
            token: bigint;
        };
    }): Promise<boolean>;
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
    readonly runs: {
        assertLease: (identity: {
            tenantId: string;
            runId: string;
        }, ownerId: string, token: bigint, now: Date) => Promise<void>;
    };
    readonly attempts: {
        list: (identity: {
            tenantId: string;
            runId: string;
        }) => Promise<ProductAttemptRecord[]>;
    };
    readonly turns: {
        listCommitted: (identity: {
            tenantId: string;
            runId: string;
        }) => Promise<ProductTurnCommit[]>;
    };
    readonly interactions: {
        put: (record: DurableInteractionUpdate) => Promise<void>;
        get: (identity: {
            tenantId: string;
            runId: string;
            interactionId: string;
        }) => Promise<DurableInteractionUpdate | undefined>;
        getById: (tenantId: string, interactionId: string) => Promise<DurableInteractionUpdate | undefined>;
        list: (identity: {
            tenantId: string;
            runId: string;
        }) => Promise<DurableInteractionUpdate[]>;
        listByTenant: (tenantId: string) => Promise<DurableInteractionUpdate[]>;
    };
    readonly toolLedger: {
        putIfAbsent: (record: DurableToolLedgerUpdate) => Promise<boolean>;
        get: (identity: {
            tenantId: string;
            runId: string;
            logicalCallId: string;
        }) => Promise<DurableToolLedgerUpdate | undefined>;
        update: (record: DurableToolLedgerUpdate) => Promise<void>;
        claimPendingApproval: (input: import("./types.js").ToolLedgerApprovalClaim) => Promise<boolean>;
        list: (identity: {
            tenantId: string;
            runId: string;
        }) => Promise<DurableToolLedgerUpdate[]>;
    };
    readonly events: {
        append: (event: Omit<AgentRunEvent, "sequence">) => Promise<AgentRunEvent>;
        list: (identity: {
            tenantId: string;
            runId: string;
        }, after?: bigint) => Promise<AgentRunEvent[]>;
    };
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
    transaction<T>(work: (store: DurableProductRunStore & MysqlRunStore) => Promise<T>): Promise<T>;
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

// file: store/session-id.d.ts
/** Keeps the product session id stable while isolating Pi's internal session tree by owner. */
export declare function piSessionStorageId(actorId: string, sessionId: string): string;

// file: store/session-stats.d.ts
import type { SessionStats, SessionTreeEntry } from '@earendil-works/pi-agent-core';
export declare function sessionStats(entries: readonly SessionTreeEntry[]): SessionStats;

// file: store/types.d.ts
import type { AgentInputMessage, AgentKernelName, AgentRunEvent, AgentRunResult, AgentRunUsage, AttemptStatus, ClaimRunInput, ClaimedRun, CommitTurnInput, CompleteRunInput, CreateRunRecord, DurableInteractionUpdate, RenewLeaseInput, RequestCancellationInput, RunRecord, RunStore } from '@aiop/control-contracts';
import type { SessionStats, SessionTreeEntry } from '@earendil-works/pi-agent-core';
export interface StoredRun extends RunRecord {
    cancelRequestedAt?: Date;
    cancelReason?: string;
    result?: AgentRunResult;
    lastTurnNo: number;
    checkpoint?: unknown;
    appendClosedAt?: Date;
    runtimeVersion?: string;
    graphName?: string;
    graphVersion?: string;
    currentNode?: string;
    stepCount?: number;
    errorMessage?: string;
    startedAt?: Date;
    completedAt?: Date;
}
export interface ProductAttemptRecord {
    tenantId: string;
    runId: string;
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
export interface ProductTurnCommit {
    tenantId: string;
    runId: string;
    attemptId: string;
    turnNo: number;
    commitId: string;
    transcriptVersion: bigint;
    stopReason?: string;
    usage: AgentRunUsage;
    eventSequenceEnd: bigint;
    committedAt: Date;
}
export interface ToolLedgerApprovalClaim {
    tenantId: string;
    runId: string;
    logicalCallId: string;
    attemptId: string;
    turnNo: number;
    toolCallId: string;
    toolName: string;
    argsDigest: string;
    approvedInteractionId: string;
    started: import('@aiop/control-contracts').DurableToolLedgerUpdate;
}
export interface InteractionRepository {
    put(record: DurableInteractionUpdate): Promise<void>;
    get(identity: {
        tenantId: string;
        runId: string;
        interactionId: string;
    }): Promise<DurableInteractionUpdate | undefined>;
    getById(tenantId: string, interactionId: string): Promise<DurableInteractionUpdate | undefined>;
    list(identity: {
        tenantId: string;
        runId: string;
    }): Promise<DurableInteractionUpdate[]>;
    listByTenant(tenantId: string): Promise<DurableInteractionUpdate[]>;
}
export interface ToolLedgerRepository {
    putIfAbsent(record: import('@aiop/control-contracts').DurableToolLedgerUpdate): Promise<boolean>;
    get(identity: {
        tenantId: string;
        runId: string;
        logicalCallId: string;
    }): Promise<import('@aiop/control-contracts').DurableToolLedgerUpdate | undefined>;
    update(record: import('@aiop/control-contracts').DurableToolLedgerUpdate): Promise<void>;
    claimPendingApproval(input: ToolLedgerApprovalClaim): Promise<boolean>;
    list(identity: {
        tenantId: string;
        runId: string;
    }): Promise<import('@aiop/control-contracts').DurableToolLedgerUpdate[]>;
}
export interface DurableProductRunStore extends DurableRunStore {
    listRuns(tenantId: string): Promise<StoredRun[]>;
    updateProductRun(identity: {
        tenantId: string;
        runId: string;
    }, patch: Partial<StoredRun>): Promise<boolean>;
    markRecoveryRequired(input: {
        identity: ClaimRunInput['identity'];
        runId: string;
        errorMessage: string;
        failedAt: Date;
        expectedLease?: {
            ownerId: string;
            token: bigint;
        };
    }): Promise<boolean>;
    runs: {
        assertLease(identity: {
            tenantId: string;
            runId: string;
        }, ownerId: string, token: bigint, now: Date): Promise<void>;
    };
    attempts: {
        list(identity: {
            tenantId: string;
            runId: string;
        }): Promise<ProductAttemptRecord[]>;
    };
    turns: {
        listCommitted(identity: {
            tenantId: string;
            runId: string;
        }): Promise<ProductTurnCommit[]>;
    };
    interactions: InteractionRepository;
    toolLedger: ToolLedgerRepository;
    events: {
        append(event: Omit<AgentRunEvent, 'sequence'>): Promise<AgentRunEvent>;
        list(identity: {
            tenantId: string;
            runId: string;
        }, after?: bigint): Promise<AgentRunEvent[]>;
    };
    transaction<T>(work: (tx: DurableProductRunStore) => Promise<T>): Promise<T>;
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
