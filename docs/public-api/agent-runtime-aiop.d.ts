// file: index.d.ts
export interface RequestContext {
    tenantId: string;
    userId: string;
    role: 'platform_admin' | 'tenant_admin' | 'user';
}
export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required';
export interface AgentRunFilter {
    status?: AgentRunStatus;
    sessionId?: string;
    limit?: number;
    offset?: number;
}
export interface AgentRunRecord {
    tenantId: string;
    userId: string;
    sessionId: string;
    runId: string;
    kernel: 'pi';
    kernelVersion?: string;
    runtimeVersion?: string;
    graphName: string;
    graphVersion: string;
    createdAt: Date;
    status: AgentRunStatus;
    waitingReason?: 'approval' | 'question' | 'plan' | 'external';
    currentNode?: string;
    stepCount: number;
    usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        costUsd?: number;
    };
    errorMessage?: string;
    startedAt?: Date;
    updatedAt: Date;
    completedAt?: Date;
    cancelRequestedAt?: Date;
    leaseOwner?: string;
    leaseToken: number;
    leaseExpiresAt?: Date;
}
export interface AgentRunEvent {
    sequence?: number;
    type: string;
    status?: string;
    id?: number;
    tenantId: string;
    runId: string;
    attemptId?: string;
    turnNo?: number;
    kernel?: 'pi';
    kernelVersion?: string;
    correlationId?: string;
    node?: string;
    detail?: unknown;
    createdAt: Date;
}
export interface InteractionRecord {
    id: string;
    kind: string;
    status: string;
    toolCallId?: string;
    createdAt: Date;
    resolvedAt?: Date;
    expiresAt?: Date;
}
export interface ToolExecutionRecord {
    toolCallId: string;
    toolName: string;
    status: string;
    startedAt: Date;
    completedAt?: Date;
    updatedAt: Date;
}
export interface AgentRunAttemptSummary {
    attemptId: string;
    kernel: string;
    kernelVersion: string;
    status: string;
    errorCode?: string;
    startedAt: Date;
    completedAt?: Date;
}
export interface AgentRunTurnSummary {
    attemptId: string;
    turnNo: number;
    commitId: string;
    transcriptVersion: number;
    stopReason?: string;
    usage: AgentRunRecord['usage'];
    eventSequenceEnd: number;
    committedAt: Date;
}
export interface RunCenterStore {
    listAgentRuns(ctx: RequestContext, filter: AgentRunFilter): Promise<AgentRunRecord[]>;
    countAgentRuns(ctx: RequestContext, filter: AgentRunFilter): Promise<number>;
    getAgentRun(ctx: RequestContext, runId: string): Promise<AgentRunRecord | undefined>;
    listAgentRunEvents(ctx: RequestContext, runId: string): Promise<AgentRunEvent[]>;
    listAgentRunInteractions(ctx: RequestContext, runId: string): Promise<InteractionRecord[]>;
    listAgentRunToolExecutions(ctx: RequestContext, runId: string): Promise<ToolExecutionRecord[]>;
    listAgentRunAttempts(ctx: RequestContext, runId: string): Promise<AgentRunAttemptSummary[]>;
    listAgentRunTurns(ctx: RequestContext, runId: string): Promise<AgentRunTurnSummary[]>;
    requestAgentRunCancellation(ctx: RequestContext, runId: string): Promise<boolean>;
    updateAgentRun(tenantId: string, runId: string, patch: {
        status?: AgentRunStatus;
        currentNode?: string | null;
        errorMessage?: string | null;
        completedAt?: Date | null;
        cancelRequestedAt?: Date | null;
        updatedAt?: Date;
    }): Promise<boolean>;
    appendAgentRunEvent(event: AgentRunEvent): Promise<unknown>;
}
export declare class RunCenterConflictError extends Error {
    constructor(message: string);
}
export declare class RunCenterNotFoundError extends Error {
    constructor(message?: string);
}
export interface RunCenterOptions {
    abortLocal?: (ctx: RequestContext, runId: string) => number;
    recover?: (ctx: RequestContext, run: AgentRunRecord) => void;
}
export declare class RunCenterService {
    private readonly store;
    private readonly options;
    constructor(store: RunCenterStore, options?: RunCenterOptions);
    list(ctx: RequestContext, filter?: AgentRunFilter): Promise<{
        runs: {
            attemptSummary: {
                count: number;
                latest: AgentRunAttemptSummary | undefined;
            };
            turnSummary: {
                count: number;
                latest: AgentRunTurnSummary | undefined;
            };
            usage: {
                inputTokens: number;
                outputTokens: number;
                cacheReadTokens: number;
                cacheCreationTokens: number;
                costUsd?: number;
            };
            tenantId: string;
            userId: string;
            sessionId: string;
            runId: string;
            kernel: "pi";
            kernelVersion?: string | undefined;
            runtimeVersion?: string | undefined;
            graphName: string;
            graphVersion: string;
            createdAt: Date;
            status: AgentRunStatus;
            waitingReason?: "approval" | "question" | "plan" | "external" | undefined;
            currentNode?: string | undefined;
            stepCount: number;
            errorMessage?: string | undefined;
            startedAt?: Date | undefined;
            updatedAt: Date;
            completedAt?: Date | undefined;
            cancelRequestedAt?: Date | undefined;
            leaseToken: number;
            leaseExpiresAt?: Date | undefined;
            leaseActive: boolean;
        }[];
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
    }>;
    detail(ctx: RequestContext, runId: string): Promise<{
        run: Omit<AgentRunRecord, "leaseOwner"> & {
            leaseActive: boolean;
        };
        events: AgentRunEvent[];
        interactions: {
            id: string;
            kind: string;
            status: string;
            toolCallId: string | undefined;
            createdAt: Date;
            resolvedAt: Date | undefined;
            expiresAt: Date | undefined;
        }[];
        tools: {
            toolCallId: string;
            toolName: string;
            status: string;
            startedAt: Date;
            completedAt: Date | undefined;
            updatedAt: Date;
        }[];
        attempts: AgentRunAttemptSummary[];
        turns: AgentRunTurnSummary[];
        canCancel: boolean;
        canResume: boolean;
        recoveryBlockedReason: string | undefined;
    } | undefined>;
    events(ctx: RequestContext, runId: string, afterSequence?: number): Promise<AgentRunEvent[] | undefined>;
    cancel(ctx: RequestContext, runId: string): Promise<{
        abortedLocal: number;
    }>;
    resume(ctx: RequestContext, runId: string): Promise<void>;
}
