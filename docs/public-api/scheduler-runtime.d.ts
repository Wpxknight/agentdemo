// file: cron.d.ts
export declare function nextFireAt(cron: string, after: Date): Date;
export declare function isValidCron(cron: string): boolean;

// file: domain.d.ts
import type { AgentRunResult, AgentInputMessage, IdentityContext, RunExecutionProfile, RunLimits } from '@aiop/control-contracts';
export interface ScheduledTask {
    taskId: string;
    tenantId: string;
    actorId: string;
    roles?: readonly string[];
    sessionId: string;
    cron: string;
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
export type ScheduledFireState = 'pending' | 'claimed' | 'bound' | 'recovering' | 'started';
export interface ScheduledFire extends ScheduledRunInput {
    state: ScheduledFireState;
    attempts: number;
    runId?: string;
    result?: AgentRunResult;
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

// file: index.d.ts
export * from './domain.js';
export * from './cron.js';
export * from './store.js';
export * from './runner.js';
export * from './recovery.js';
export * from './mysql.js';

// file: mysql.d.ts
import type { Generated, Kysely } from 'kysely';
import type { BoundScheduledFire, ClaimedScheduledFire, RecoveringScheduledFire } from './domain.js';
import { type BindRunInput, type ClaimBoundInput, type ClaimDueInput, type CompleteFireInput, type ListBoundInput, type ReleaseBoundInput, type ReleaseFireInput, type SchedulerStore } from './store.js';
export interface SchedulerMysqlDatabase {
    scheduled_tasks: {
        id: Generated<number>;
        tenant_id: string;
        user_id: string;
        session_id: string;
        title: string;
        cron: string;
        task: string;
        pre_approved: number;
        enabled: number;
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
    task_agent_runs: {
        tenant_id: string;
        task_id: number;
        run_id: string;
        created_at: Date;
    };
    task_runs: {
        id: Generated<number>;
        task_id: number;
        fire_id: Generated<string | null>;
        run_id: Generated<string | null>;
        status: string;
        detail: string | null;
        steps: number | null;
        created_at: Generated<Date>;
    };
}
export declare class MysqlSchedulerStore implements SchedulerStore {
    private readonly db;
    constructor(db: Kysely<SchedulerMysqlDatabase>);
    claimDue(input: ClaimDueInput): Promise<ClaimedScheduledFire[]>;
    bindRun(input: BindRunInput): Promise<void>;
    completeFire(input: CompleteFireInput): Promise<void>;
    listBound(input: ListBoundInput): Promise<BoundScheduledFire[]>;
    claimBound(input: ClaimBoundInput): Promise<RecoveringScheduledFire | undefined>;
    releaseBound(input: ReleaseBoundInput): Promise<void>;
    releaseFire(input: ReleaseFireInput): Promise<void>;
    recoverExpired(now: Date): Promise<number>;
}

// file: recovery.d.ts
import type { SchedulerStore } from './store.js';
export declare class SchedulerRecovery {
    private readonly store;
    constructor(store: SchedulerStore);
    recover(now: Date): Promise<number>;
}

// file: runner.d.ts
import type { DurableRunRuntime } from '@aiop/control-contracts';
import type { ClaimedScheduledFire, RunDispatcher, ScheduledRunInput, ScheduledRunLookup } from './domain.js';
import type { SchedulerStore } from './store.js';
export interface SchedulerRunnerOptions {
    store: SchedulerStore;
    dispatcher: RunDispatcher;
    workerId: string;
    leaseMs?: number;
    retryDelayMs?: number;
    prepareRun?(fire: ClaimedScheduledFire, now: Date): Promise<Pick<ScheduledRunInput, 'limits' | 'signal'>>;
}
export declare function createRunDispatcher(runtime: Pick<DurableRunRuntime, 'run'>, lookup?: ScheduledRunLookup): RunDispatcher;
export declare class SchedulerRunner {
    private readonly options;
    private readonly leaseMs;
    private readonly retryDelayMs;
    constructor(options: SchedulerRunnerOptions);
    tick(now: Date, limit: number, signal?: AbortSignal): Promise<number>;
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
export interface SchedulerStore {
    claimDue(input: ClaimDueInput): Promise<ClaimedScheduledFire[]>;
    listBound(input: ListBoundInput): Promise<BoundScheduledFire[]>;
    claimBound(input: ClaimBoundInput): Promise<RecoveringScheduledFire | undefined>;
    releaseBound(input: ReleaseBoundInput): Promise<void>;
    bindRun(input: BindRunInput): Promise<void>;
    completeFire(input: CompleteFireInput): Promise<void>;
    releaseFire(input: ReleaseFireInput): Promise<void>;
    recoverExpired(now: Date): Promise<number>;
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
    releaseFire(input: ReleaseFireInput): Promise<void>;
    recoverExpired(now: Date): Promise<number>;
    listFires(): Promise<ScheduledFire[]>;
    private materializeDueFires;
    private requireClaim;
}
export declare function scheduledFireId(taskId: string, fireTime: Date): string;
