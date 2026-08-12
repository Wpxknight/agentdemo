// file: cron.d.ts
export declare const DEFAULT_SCHEDULER_TIMEZONE = "UTC";
export declare function nextFireAt(cron: string, after: Date, timezone?: string): Date;
export declare function isValidTimezone(timezone: string): boolean;
export declare function isValidCron(cron: string, timezone?: string): boolean;
export declare function assertValidCron(cron: string, timezone?: string): void;

// file: domain.d.ts
import type { AgentRunResult, AgentInputMessage, IdentityContext, RunExecutionProfile, RunLimits } from '@aiop/control-contracts';
export interface ScheduledTask {
    taskId: string;
    tenantId: string;
    actorId: string;
    roles?: readonly string[];
    sessionId: string;
    cron: string;
    timezone?: string;
    input: readonly AgentInputMessage[];
    nextFireAt: Date;
    preApproved?: boolean;
    enabled?: boolean;
}
export interface ScheduledRunInput {
    taskId: string;
    fireId: string;
    fireTime: Date;
    identity: IdentityContext;
    sessionId: string;
    input: readonly AgentInputMessage[];
    execution?: RunExecutionProfile;
    limits?: RunLimits;
    signal?: AbortSignal;
}
export interface RunDispatcher {
    startScheduledRun(input: ScheduledRunInput, onStarted?: (runId: string) => Promise<void>): Promise<{
        runId: string;
        result: AgentRunResult;
    }>;
}
export interface ScheduledRunLookup {
    findScheduledRun(input: ScheduledRunInput): Promise<{
        runId: string;
        result: AgentRunResult;
    } | undefined>;
}
export type ScheduledFireState = 'pending' | 'claimed' | 'bound' | 'recovering' | 'completed';
export interface ScheduledFire extends ScheduledRunInput {
    state: ScheduledFireState;
    attempts: number;
    runId?: string;
    result?: AgentRunResult;
    completedAt?: Date;
    claimToken?: string;
    claimedBy?: string;
    leaseExpiresAt?: Date;
    retryAt?: Date;
    lastError?: string;
}
export interface ClaimedScheduledFire extends ScheduledFire {
    state: 'claimed';
    claimToken: string;
    claimedBy: string;
    leaseExpiresAt: Date;
}
export interface BoundScheduledFire extends ScheduledFire {
    state: 'bound';
    runId: string;
    claimToken: string;
    leaseExpiresAt: Date;
}
export interface RecoveringScheduledFire extends ScheduledFire {
    state: 'recovering';
    runId: string;
    claimToken: string;
    claimedBy: string;
    leaseExpiresAt: Date;
}
export type BoundRunInspection = {
    kind: 'active';
} | {
    kind: 'waiting';
} | {
    kind: 'terminal';
    result: AgentRunResult;
} | {
    kind: 'recoverable';
};
export interface BoundRunRecovery {
    inspect(fire: BoundScheduledFire, now: Date): Promise<BoundRunInspection>;
    resume(fire: RecoveringScheduledFire, signal?: AbortSignal): Promise<AgentRunResult>;
}

// file: index.d.ts
export * from './domain.js';
export * from './cron.js';
export * from './store.js';
export * from './runner.js';
export * from './recovery.js';
export * from './mysql.js';
export * from './observation.js';

// file: mysql.d.ts
import type { Generated, Kysely } from 'kysely';
import type { BoundScheduledFire, ClaimedScheduledFire, RecoveringScheduledFire } from './domain.js';
import { type BindRunInput, type ClaimBoundInput, type ClaimDueInput, type CompleteFireInput, type DeferBoundInput, type ListBoundInput, type ReleaseBoundInput, type ReleaseFireInput, type SchedulerStore } from './store.js';
export interface SchedulerMysqlDatabase {
    scheduled_tasks: {
        id: Generated<number>;
        tenant_id: string;
        user_id: string;
        session_id: string;
        title: string;
        cron: string;
        timezone: string;
        task: string;
        pre_approved: number;
        enabled: number;
        deleted_at: Date | null;
        next_run_at: Date;
        last_run_at: Date | null;
        created_at: Generated<Date>;
    };
    scheduler_fires: {
        fire_id: string;
        task_id: number;
        tenant_id: string;
        actor_id: string;
        session_id: string;
        fire_time: Date;
        input_json: string;
        trigger_kind: string;
        idempotency_key: string | null;
        state: string;
        attempts: number;
        run_id: string | null;
        claim_token: string | null;
        claim_owner: string | null;
        lease_expires_at: Date | null;
        retry_at: Date | null;
        last_error: string | null;
        created_at: Date;
        updated_at: Date;
    };
}
export declare class MysqlSchedulerStore implements SchedulerStore {
    private readonly db;
    constructor(db: Kysely<SchedulerMysqlDatabase>);
    claimDue(input: ClaimDueInput): Promise<ClaimedScheduledFire[]>;
    bindRun(input: BindRunInput): Promise<void>;
    completeFire(input: CompleteFireInput): Promise<void>;
    cleanupCompleted(input: {
        before: Date;
        limit: number;
    }): Promise<number>;
    listBound(input: ListBoundInput): Promise<BoundScheduledFire[]>;
    claimBound(input: ClaimBoundInput): Promise<RecoveringScheduledFire | undefined>;
    releaseBound(input: ReleaseBoundInput): Promise<void>;
    deferBound(input: DeferBoundInput): Promise<void>;
    releaseFire(input: ReleaseFireInput): Promise<void>;
    recoverExpired(now: Date): Promise<number>;
}

// file: observation.d.ts
export type SchedulerObservationName = 'backlog' | 'due_lag_ms' | 'state_count' | 'retry' | 'duration_ms' | 'completion' | 'long_stuck';
/** Low-cardinality scheduler measurements. Fire IDs are correlation fields, not metric labels. */
export interface SchedulerObservation {
    name: SchedulerObservationName;
    value: number;
    fireId?: string;
    state?: 'claimed' | 'bound' | 'completed' | 'failed';
}
export interface SchedulerObserver {
    record(observation: SchedulerObservation): void;
}
/** Dependency-free observer for embedding and tests; callers may export its snapshot as desired. */
export declare class InMemorySchedulerObserver implements SchedulerObserver {
    private readonly observations;
    record(observation: SchedulerObservation): void;
    snapshot(): readonly SchedulerObservation[];
}

// file: recovery.d.ts
import type { SchedulerStore } from './store.js';
export declare class SchedulerRecovery {
    private readonly store;
    constructor(store: SchedulerStore);
    recover(now: Date): Promise<number>;
}

// file: runner.d.ts
import type { AgentRunResult, DurableRunRuntime } from '@aiop/control-contracts';
import type { BoundRunRecovery, ClaimedScheduledFire, RunDispatcher, ScheduledRunInput, ScheduledRunLookup } from './domain.js';
import type { SchedulerStore } from './store.js';
import type { SchedulerObserver } from './observation.js';
export declare class TerminalScheduledFireError extends Error {
    readonly code: string;
    constructor(code: string, message?: string);
}
export interface SchedulerRunnerOptions {
    store: SchedulerStore;
    dispatcher: RunDispatcher;
    boundRecovery: BoundRunRecovery;
    workerId: string;
    leaseMs?: number;
    retryDelayMs?: number;
    observer?: SchedulerObserver;
    prepareRun?(fire: ClaimedScheduledFire, now: Date): Promise<Pick<ScheduledRunInput, 'limits' | 'signal'>>;
    completed?(fire: ScheduledRunInput, result: AgentRunResult): Promise<void>;
}
export declare function createRunDispatcher(runtime: Pick<DurableRunRuntime, 'run'>, lookup?: ScheduledRunLookup): RunDispatcher;
export declare class SchedulerRunner {
    private readonly options;
    private readonly leaseMs;
    private readonly retryDelayMs;
    constructor(options: SchedulerRunnerOptions);
    tick(now: Date, limit: number, signal?: AbortSignal): Promise<number>;
    private observe;
}

// file: store.d.ts
import type { AgentRunResult } from '@aiop/control-contracts';
import type { BoundScheduledFire, ClaimedScheduledFire, RecoveringScheduledFire, ScheduledFire, ScheduledTask } from './domain.js';
export interface ClaimDueInput {
    now: Date;
    limit: number;
    workerId: string;
    leaseMs: number;
}
export interface CompleteFireInput {
    fireId: string;
    claimToken: string;
    runId: string;
    result: AgentRunResult;
    completedAt: Date;
}
export interface BindRunInput {
    fireId: string;
    claimToken: string;
    runId: string;
    boundAt: Date;
}
export interface ReleaseFireInput {
    fireId: string;
    claimToken: string;
    retryAt: Date;
    error: string;
}
export interface ListBoundInput {
    now: Date;
    limit: number;
}
export interface ClaimBoundInput {
    fireId: string;
    expectedClaimToken: string;
    now: Date;
    workerId: string;
    leaseMs: number;
}
export interface ReleaseBoundInput {
    fireId: string;
    claimToken: string;
    retryAt: Date;
    error: string;
}
export interface DeferBoundInput {
    fireId: string;
    claimToken: string;
    retryAt: Date;
    error: string;
}
export interface CleanupCompletedInput {
    before: Date;
    limit: number;
}
export interface SchedulerStore {
    claimDue(input: ClaimDueInput): Promise<ClaimedScheduledFire[]>;
    listBound(input: ListBoundInput): Promise<BoundScheduledFire[]>;
    claimBound(input: ClaimBoundInput): Promise<RecoveringScheduledFire | undefined>;
    releaseBound(input: ReleaseBoundInput): Promise<void>;
    deferBound(input: DeferBoundInput): Promise<void>;
    bindRun(input: BindRunInput): Promise<void>;
    completeFire(input: CompleteFireInput): Promise<void>;
    releaseFire(input: ReleaseFireInput): Promise<void>;
    recoverExpired(now: Date): Promise<number>;
    /** 删除过期 completed Fire；不触碰关联 Durable Run。 */
    cleanupCompleted(input: CleanupCompletedInput): Promise<number>;
}
export declare class MemorySchedulerStore implements SchedulerStore {
    private readonly tasks;
    private readonly fires;
    private claimSequence;
    constructor(tasks?: readonly ScheduledTask[]);
    upsertTask(task: ScheduledTask): void;
    claimDue(input: ClaimDueInput): Promise<ClaimedScheduledFire[]>;
    completeFire(input: CompleteFireInput): Promise<void>;
    bindRun(input: BindRunInput): Promise<void>;
    listBound(input: ListBoundInput): Promise<BoundScheduledFire[]>;
    claimBound(input: ClaimBoundInput): Promise<RecoveringScheduledFire | undefined>;
    releaseBound(input: ReleaseBoundInput): Promise<void>;
    deferBound(input: DeferBoundInput): Promise<void>;
    releaseFire(input: ReleaseFireInput): Promise<void>;
    recoverExpired(now: Date): Promise<number>;
    cleanupCompleted(input: CleanupCompletedInput): Promise<number>;
    listFires(): Promise<ScheduledFire[]>;
    private materializeDueFires;
    private requireClaim;
}
export declare function scheduledFireId(taskId: string, fireTime: Date): string;
