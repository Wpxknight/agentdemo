import { type AgentRunEvent } from '@aiop/agent-contracts';
import type { AttemptRecord, CommitTurnInput, InteractionRecord, LeaseRecord, RunIdentity, RunRecord, RuntimeStore, RuntimeTransaction, ToolLedgerRecord, TurnCommit, TurnSnapshot } from '@aiop/agent-runtime-core';
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
    };
    readonly toolLedger: {
        putIfAbsent: (record: ToolLedgerRecord) => Promise<boolean>;
        get: (identity: RunIdentity & {
            logicalCallId: string;
        }) => Promise<ToolLedgerRecord | undefined>;
        update: (record: ToolLedgerRecord) => Promise<void>;
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
