import { AgentPlatformError, type AgentRunEvent } from '@aiop/control-contracts';
import type {
  AttemptRecord,
  CommitTurnInput,
  InteractionRecord,
  LeaseRecord,
  RunIdentity,
  RunRecord,
  RuntimeStore,
  RuntimeTransaction,
  ToolLedgerRecord,
  TurnCommit,
  TurnSnapshot,
} from '@aiop/agent-runtime-core';
import type { ColumnType, Generated, Kysely, Transaction } from 'kysely';

type JsonColumn = ColumnType<unknown, string, string>;
type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;

export interface RuntimeMysqlDatabase {
  agent_runs: {
    tenant_id: string; run_id: string; user_id: string; session_id: string;
    kernel: string; kernel_version: string; graph_name: string; graph_version: string; runtime_version: string;
    status: string; waiting_reason: string | null; current_node: string | null; step_count: number;
    input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
    error_message: string | null; started_at: Date | null; updated_at: Date; completed_at: Date | null;
    cancel_requested_at: Date | null; lease_owner: string | null; lease_token: number;
    lease_expires_at: Date | null; created_at: Date;
  };
  agent_run_attempts: {
    tenant_id: string; run_id: string; attempt_id: string; worker_id: string; lease_token: number;
    kernel: string; kernel_version: string; status: string; error_code: string | null;
    error_message: string | null; started_at: Date; completed_at: Date | null;
  };
  agent_turn_snapshots: {
    tenant_id: string; run_id: string; attempt_id: string; turn_no: number; session_version: number;
    parent_commit_id: string | null; identity_json: JsonColumn; model_binding_json: JsonColumn;
    prompt_version: string; skill_set_version: string | null; tool_set_version: string;
    policy_version: string; limits_json: NullableJsonColumn; messages_json: JsonColumn;
    deadline_at: Date | null; created_at: Date;
  };
  agent_turn_commits: {
    tenant_id: string; run_id: string; attempt_id: string; turn_no: number; commit_id: string;
    transcript_version: number; stop_reason: string | null; usage_json: JsonColumn; messages_json: JsonColumn;
    event_sequence_end: number; committed_at: Date;
  };
  agent_interactions: {
    id: string; tenant_id: string; user_id: string; session_id: string; run_id: string;
    attempt_id: string | null; turn_no: number | null; kind: string; tool_call_id: string | null;
    payload: JsonColumn; status: string; resolution: ColumnType<unknown, string | null, string | null>;
    resolved_by: string | null; expires_at: Date; created_at: Date; resolved_at: Date | null;
  };
  agent_tool_executions: {
    tenant_id: string; run_id: string; attempt_id: string | null; turn_no: number | null; session_id: string;
    tool_call_id: string; logical_call_id: string; idempotency_key: string; capability: string;
    external_correlation_id: string | null; result_digest: string | null; approved_interaction_id: string | null;
    tool_name: string; args_digest: string; status: string;
    result: ColumnType<unknown, string | null, string | null>; started_at: Date; completed_at: Date | null; updated_at: Date;
  };
  agent_run_events: {
    id: Generated<number>; tenant_id: string; run_id: string; sequence: number; event_type: string;
    attempt_id: string | null; turn_no: number | null; kernel: string | null;
    kernel_version: string | null; correlation_id: string | null;
    node_name: string | null; status: string | null; detail: ColumnType<unknown, string | null, string | null>;
    created_at: Date;
  };
}

type RuntimeDb = Kysely<RuntimeMysqlDatabase> | Transaction<RuntimeMysqlDatabase>;

export class MysqlRuntimeStore implements RuntimeStore {
  constructor(private readonly db: RuntimeDb, private readonly transactionalView = false) {}

  readonly runs = {
    create: async (record: RunRecord): Promise<void> => {
      await this.db.insertInto('agent_runs').values({
        tenant_id: record.tenantId, run_id: record.runId, user_id: record.actorId, session_id: record.sessionId,
        kernel: record.kernel, kernel_version: record.kernelVersion, graph_name: '', graph_version: '',
        runtime_version: record.runtimeVersion, status: record.status, waiting_reason: record.waitingReason ?? null,
        current_node: null, step_count: 0,
        input_tokens: record.usage.inputTokens, output_tokens: record.usage.outputTokens,
        cache_read_tokens: record.usage.cacheReadTokens, cache_creation_tokens: record.usage.cacheCreationTokens,
        error_message: null, started_at: null, updated_at: record.updatedAt, completed_at: null,
        cancel_requested_at: record.cancelRequestedAt ?? null, lease_owner: record.leaseOwner ?? null,
        lease_token: Number(record.leaseToken), lease_expires_at: record.leaseExpiresAt ?? null, created_at: record.createdAt,
      }).execute();
    },
    get: async (identity: RunIdentity): Promise<RunRecord | undefined> => {
      const row = await this.db.selectFrom('agent_runs').selectAll()
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId).executeTakeFirst();
      return row ? mapRun(row) : undefined;
    },
    update: async (identity: RunIdentity, patch: Partial<RunRecord>): Promise<void> => {
      const result = await this.db.updateTable('agent_runs').set({
        user_id: patch.actorId, session_id: patch.sessionId, kernel: patch.kernel,
        kernel_version: patch.kernelVersion, runtime_version: patch.runtimeVersion,
        status: patch.status, waiting_reason: patch.waitingReason === undefined ? undefined : patch.waitingReason ?? null,
        input_tokens: patch.usage?.inputTokens, output_tokens: patch.usage?.outputTokens,
        cache_read_tokens: patch.usage?.cacheReadTokens, cache_creation_tokens: patch.usage?.cacheCreationTokens,
        cancel_requested_at: patch.cancelRequestedAt === undefined ? undefined : patch.cancelRequestedAt ?? null,
        lease_owner: patch.leaseOwner === undefined ? undefined : patch.leaseOwner ?? null,
        lease_token: patch.leaseToken === undefined ? undefined : Number(patch.leaseToken),
        lease_expires_at: patch.leaseExpiresAt === undefined ? undefined : patch.leaseExpiresAt ?? null,
        updated_at: patch.updatedAt,
      }).where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId).executeTakeFirst();
      if (Number(result.numUpdatedRows ?? 0) === 0) throw new Error('Run not found');
    },
    acquireLease: async (
      identity: RunIdentity, ownerId: string, now: Date, ttlMs: number,
    ): Promise<LeaseRecord | undefined> => this.withTransaction(async (store) => {
      const row = await store.db.selectFrom('agent_runs').select(['lease_owner', 'lease_token', 'lease_expires_at'])
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId).forUpdate().executeTakeFirst();
      if (!row) return undefined;
      if (row.lease_owner && row.lease_owner !== ownerId && row.lease_expires_at && row.lease_expires_at > now) return undefined;
      const same = row.lease_owner === ownerId && row.lease_expires_at !== null && row.lease_expires_at > now;
      const token = BigInt(same ? row.lease_token : row.lease_token + 1);
      const expiresAt = new Date(now.getTime() + ttlMs);
      await store.db.updateTable('agent_runs').set({
        lease_owner: ownerId, lease_token: Number(token), lease_expires_at: expiresAt, updated_at: now,
      }).where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId).execute();
      return { ownerId, token, expiresAt };
    }),
    renewLease: async (
      identity: RunIdentity, ownerId: string, token: bigint, now: Date, ttlMs: number,
    ): Promise<boolean> => {
      const result = await this.db.updateTable('agent_runs').set({
        lease_expires_at: new Date(now.getTime() + ttlMs), updated_at: now,
      }).where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
        .where('lease_owner', '=', ownerId).where('lease_token', '=', Number(token)).executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
    assertLease: async (identity: RunIdentity, ownerId: string, token: bigint, now: Date): Promise<void> => {
      const row = await this.db.selectFrom('agent_runs').select('run_id')
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
        .where('lease_owner', '=', ownerId).where('lease_token', '=', Number(token))
        .where('lease_expires_at', '>', now).forUpdate().executeTakeFirst();
      if (!row) throw leaseLost();
    },
  };

  readonly attempts = {
    create: async (record: AttemptRecord): Promise<void> => {
      await this.db.insertInto('agent_run_attempts').values({
        tenant_id: record.tenantId, run_id: record.runId, attempt_id: record.attemptId,
        worker_id: record.workerId, lease_token: Number(record.leaseToken), kernel: record.kernel,
        kernel_version: record.kernelVersion, status: record.status, error_code: record.errorCode ?? null,
        error_message: record.errorMessage ?? null, started_at: record.startedAt, completed_at: record.completedAt ?? null,
      }).execute();
    },
    update: async (identity: RunIdentity & { attemptId: string }, patch: Partial<AttemptRecord>): Promise<void> => {
      await this.db.updateTable('agent_run_attempts').set({
        worker_id: patch.workerId, lease_token: patch.leaseToken === undefined ? undefined : Number(patch.leaseToken),
        kernel: patch.kernel, kernel_version: patch.kernelVersion, status: patch.status,
        error_code: patch.errorCode, error_message: patch.errorMessage,
        started_at: patch.startedAt, completed_at: patch.completedAt,
      }).where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
        .where('attempt_id', '=', identity.attemptId).execute();
    },
    list: async (identity: RunIdentity): Promise<AttemptRecord[]> => (await this.db.selectFrom('agent_run_attempts')
      .selectAll().where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
      .orderBy('started_at', 'asc').execute()).map(mapAttempt),
  };

  readonly turns = {
    createSnapshot: async (snapshot: TurnSnapshot): Promise<void> => {
      await this.db.insertInto('agent_turn_snapshots').values({
        tenant_id: snapshot.tenantId, run_id: snapshot.runId, attempt_id: snapshot.attemptId, turn_no: snapshot.turnNo,
        session_version: Number(snapshot.sessionVersion), parent_commit_id: snapshot.parentCommitId ?? null,
        identity_json: json(snapshot.identity), model_binding_json: json(snapshot.modelBinding),
        prompt_version: snapshot.promptVersion, skill_set_version: snapshot.skillSetVersion ?? null,
        tool_set_version: snapshot.toolSetVersion, policy_version: snapshot.policyVersion,
        limits_json: snapshot.limits ? json(withoutDeadline(snapshot.limits)) : null,
        messages_json: json(snapshot.messages), deadline_at: snapshot.deadlineAt ?? null, created_at: snapshot.createdAt,
      }).execute();
    },
    getSnapshot: async (identity: RunIdentity & { attemptId: string; turnNo: number }): Promise<TurnSnapshot | undefined> => {
      const row = await this.db.selectFrom('agent_turn_snapshots').selectAll()
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
        .where('attempt_id', '=', identity.attemptId).where('turn_no', '=', identity.turnNo).executeTakeFirst();
      return row ? mapSnapshot(row) : undefined;
    },
    getLastCommitted: async (identity: RunIdentity): Promise<TurnCommit | undefined> => {
      const row = await this.db.selectFrom('agent_turn_commits').selectAll()
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
        .orderBy('transcript_version', 'desc').executeTakeFirst();
      return row ? mapCommit(row) : undefined;
    },
    listCommitted: async (identity: RunIdentity): Promise<TurnCommit[]> => (await this.db
      .selectFrom('agent_turn_commits').selectAll()
      .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
      .orderBy('transcript_version', 'asc').execute()).map(mapCommit),
    commit: async (input: CommitTurnInput): Promise<TurnCommit> => {
      if (!this.transactionalView) return this.transaction((tx) => tx.turns.commit(input));
      await this.assertCommitLease(input.snapshot, input.leaseOwner, input.leaseToken, input.commit.committedAt);
      const snapshot = await this.turns.getSnapshot(input.snapshot);
      if (!snapshot || snapshotFingerprint(snapshot) !== snapshotFingerprint(input.snapshot)) {
        throw commitFailed('snapshot mismatch');
      }
      const existing = await this.db.selectFrom('agent_turn_commits').selectAll()
        .where('tenant_id', '=', input.snapshot.tenantId).where('run_id', '=', input.snapshot.runId)
        .where('attempt_id', '=', input.snapshot.attemptId).where('turn_no', '=', input.snapshot.turnNo).executeTakeFirst();
      if (existing) {
        if (existing.commit_id === input.commit.commitId) return mapCommit(existing);
        throw commitFailed('conflicting commit');
      }
      let eventSequenceEnd = 0n;
      for (const event of input.events) eventSequenceEnd = (await this.events.append(event)).sequence;
      for (const interaction of input.interactionUpdates ?? []) await this.interactions.put(interaction);
      for (const ledger of input.ledgerUpdates ?? []) {
        if (!await this.toolLedger.putIfAbsent(ledger)) await this.toolLedger.update(ledger);
      }
      await this.db.insertInto('agent_turn_commits').values({
        tenant_id: input.commit.tenantId, run_id: input.commit.runId, attempt_id: input.commit.attemptId,
        turn_no: input.commit.turnNo, commit_id: input.commit.commitId,
        transcript_version: Number(input.commit.transcriptVersion), stop_reason: input.commit.stopReason ?? null,
        usage_json: json(input.commit.usage), messages_json: json(input.commit.messages),
        event_sequence_end: Number(eventSequenceEnd), committed_at: input.commit.committedAt,
      }).execute();
      await this.runs.update(input.snapshot, {
        status: input.runStatus, waitingReason: input.waitingReason, usage: input.commit.usage,
        updatedAt: input.commit.committedAt,
      });
      return { ...input.commit, eventSequenceEnd };
    },
  };

  readonly interactions = {
    put: async (record: InteractionRecord): Promise<void> => {
      await this.db.insertInto('agent_interactions').values({
        id: record.id, tenant_id: record.tenantId, user_id: record.userId ?? '',
        session_id: record.sessionId ?? '', run_id: record.runId,
        attempt_id: record.attemptId, turn_no: record.turnNo, kind: record.kind,
        tool_call_id: record.toolCallId ?? null,
        payload: json(record.payload), status: record.status,
        resolution: record.resolution === undefined ? null : json(record.resolution),
        resolved_by: record.resolvedBy ?? null,
        expires_at: record.expiresAt ?? new Date('9999-12-31T23:59:59.999Z'), created_at: record.createdAt,
        resolved_at: record.resolvedAt ?? null,
      }).onDuplicateKeyUpdate({
        status: record.status, resolution: record.resolution === undefined ? null : json(record.resolution),
        resolved_by: record.resolvedBy ?? null, resolved_at: record.resolvedAt ?? null,
      }).execute();
    },
    get: async (identity: RunIdentity & { interactionId: string }): Promise<InteractionRecord | undefined> => {
      const row = await this.db.selectFrom('agent_interactions').selectAll()
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
        .where('id', '=', identity.interactionId).executeTakeFirst();
      return row ? {
        tenantId: row.tenant_id, runId: row.run_id, id: row.id,
        userId: row.user_id || undefined, sessionId: row.session_id || undefined,
        attemptId: row.attempt_id ?? '', turnNo: row.turn_no ?? 0,
        kind: row.kind as InteractionRecord['kind'], toolCallId: row.tool_call_id ?? undefined,
        status: row.status as InteractionRecord['status'],
        payload: parse(row.payload) as InteractionRecord['payload'],
        resolution: row.resolution === null ? undefined : parse(row.resolution) as InteractionRecord['resolution'],
        resolvedBy: row.resolved_by ?? undefined, expiresAt: row.expires_at,
        createdAt: row.created_at, resolvedAt: row.resolved_at ?? undefined,
      } : undefined;
    },
    list: async (identity: RunIdentity): Promise<InteractionRecord[]> => {
      const rows = await this.db.selectFrom('agent_interactions').selectAll()
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
        .orderBy('created_at', 'asc').execute();
      return rows.map((row) => ({
        tenantId: row.tenant_id, runId: row.run_id, id: row.id,
        userId: row.user_id || undefined, sessionId: row.session_id || undefined,
        attemptId: row.attempt_id ?? '', turnNo: row.turn_no ?? 0,
        kind: row.kind as InteractionRecord['kind'], toolCallId: row.tool_call_id ?? undefined,
        status: row.status as InteractionRecord['status'], payload: parse(row.payload) as InteractionRecord['payload'],
        resolution: row.resolution === null ? undefined : parse(row.resolution) as InteractionRecord['resolution'],
        resolvedBy: row.resolved_by ?? undefined, expiresAt: row.expires_at,
        createdAt: row.created_at, resolvedAt: row.resolved_at ?? undefined,
      }));
    },
  };

  readonly toolLedger = {
    putIfAbsent: async (record: ToolLedgerRecord): Promise<boolean> => {
      const result = await this.db.insertInto('agent_tool_executions').values(ledgerValues(record)).ignore().executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
    },
    get: async (identity: RunIdentity & { logicalCallId: string }): Promise<ToolLedgerRecord | undefined> => {
      const row = await this.db.selectFrom('agent_tool_executions').selectAll()
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
        .where('logical_call_id', '=', identity.logicalCallId).executeTakeFirst();
      return row ? mapLedger(row) : undefined;
    },
    update: async (record: ToolLedgerRecord): Promise<void> => {
      await this.db.updateTable('agent_tool_executions').set({
        attempt_id: record.attemptId, turn_no: record.turnNo, tool_call_id: record.toolCallId,
        idempotency_key: record.idempotencyKey, capability: record.capability,
        external_correlation_id: record.externalCorrelationId ?? null, result_digest: record.resultDigest ?? null,
        approved_interaction_id: record.approvedInteractionId ?? null, status: record.status,
        result: record.result === undefined ? null : json(record.result), completed_at: record.status === 'completed' ? record.updatedAt : null,
        updated_at: record.updatedAt,
      }).where('tenant_id', '=', record.tenantId).where('run_id', '=', record.runId)
        .where('logical_call_id', '=', record.logicalCallId).execute();
    },
    claimPendingApproval: async (input: import('@aiop/agent-runtime-core').ToolLedgerApprovalClaim): Promise<boolean> => {
      const result = await this.db.updateTable('agent_tool_executions').set({
        attempt_id: input.started.attemptId, turn_no: input.started.turnNo,
        tool_call_id: input.started.toolCallId, idempotency_key: input.started.idempotencyKey,
        capability: input.started.capability, approved_interaction_id: input.started.approvedInteractionId ?? null,
        status: input.started.status, updated_at: input.started.updatedAt,
      }).where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId)
        .where('logical_call_id', '=', input.logicalCallId).where('status', '=', 'pending_approval')
        .where('attempt_id', '=', input.attemptId).where('turn_no', '=', input.turnNo)
        .where('tool_call_id', '=', input.toolCallId).where('tool_name', '=', input.toolName)
        .where('args_digest', '=', input.argsDigest)
        .where('approved_interaction_id', '=', input.approvedInteractionId).executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) === 1;
    },
  };

  readonly events = {
    append: async (event: Omit<AgentRunEvent, 'sequence'>): Promise<AgentRunEvent> => {
      if (!this.transactionalView) return this.transaction((tx) => tx.events.append(event));
      await this.db.selectFrom('agent_runs').select('lease_token')
        .where('tenant_id', '=', event.tenantId).where('run_id', '=', event.runId).forUpdate().executeTakeFirstOrThrow();
      const last = await this.db.selectFrom('agent_run_events')
        .select(({ fn }) => fn.max<number>('sequence').as('sequence'))
        .where('tenant_id', '=', event.tenantId).where('run_id', '=', event.runId).executeTakeFirst();
      const sequence = BigInt(Number(last?.sequence ?? 0) + 1);
      await this.db.insertInto('agent_run_events').values({
        tenant_id: event.tenantId, run_id: event.runId, sequence: Number(sequence), event_type: event.type,
        attempt_id: event.attemptId, turn_no: event.turnNo, kernel: event.kernel,
        kernel_version: event.kernelVersion, correlation_id: event.correlationId,
        node_name: null, status: null, detail: event.detail === undefined ? null : json(event.detail), created_at: event.createdAt,
      }).execute();
      return { ...event, sequence };
    },
    list: async (identity: RunIdentity, after = 0n): Promise<AgentRunEvent[]> => (await this.db.selectFrom('agent_run_events')
      .selectAll().where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
      .where('sequence', '>', Number(after)).orderBy('sequence', 'asc').execute()).map((row) => ({
        tenantId: row.tenant_id, runId: row.run_id, sequence: BigInt(row.sequence), type: row.event_type,
        attemptId: row.attempt_id ?? 'legacy', turnNo: row.turn_no ?? 0,
        kernel: row.kernel ?? 'legacy', kernelVersion: row.kernel_version ?? 'unknown',
        correlationId: row.correlation_id ?? `${row.tenant_id}:${row.run_id}:${row.sequence}`,
        detail: row.detail === null ? undefined : parse(row.detail) as AgentRunEvent['detail'], createdAt: row.created_at,
      })),
  };

  async transaction<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T> {
    if (this.transactionalView) return work(this);
    return (this.db as Kysely<RuntimeMysqlDatabase>).transaction().execute((tx) => work(new MysqlRuntimeStore(tx, true)));
  }

  private withTransaction<T>(work: (store: MysqlRuntimeStore) => Promise<T>): Promise<T> {
    return this.transaction((tx) => work(tx as MysqlRuntimeStore));
  }

  private async assertCommitLease(identity: RunIdentity, ownerId: string, token: bigint, now: Date): Promise<void> {
    const row = await this.db.selectFrom('agent_runs').select('run_id')
      .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId)
      .where('lease_owner', '=', ownerId).where('lease_token', '=', Number(token))
      .where('lease_expires_at', '>', now).forUpdate().executeTakeFirst();
    if (!row) throw leaseLost();
  }
}

function json(value: unknown): string { return JSON.stringify(value); }
function snapshotFingerprint(snapshot: TurnSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) => {
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  });
}
function parse(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) : value; }

function mapRun(row: any): RunRecord {
  return {
    tenantId: row.tenant_id, runId: row.run_id, actorId: row.user_id, sessionId: row.session_id,
    kernel: row.kernel, kernelVersion: row.kernel_version, runtimeVersion: row.runtime_version,
    status: row.status, waitingReason: row.waiting_reason ?? undefined, leaseOwner: row.lease_owner ?? undefined,
    leaseToken: BigInt(row.lease_token), leaseExpiresAt: row.lease_expires_at ?? undefined,
    cancelRequestedAt: row.cancel_requested_at ?? undefined,
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens },
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function mapAttempt(row: any): AttemptRecord {
  return { tenantId: row.tenant_id, runId: row.run_id, attemptId: row.attempt_id, workerId: row.worker_id,
    leaseToken: BigInt(row.lease_token), kernel: row.kernel, kernelVersion: row.kernel_version, status: row.status,
    errorCode: row.error_code ?? undefined, errorMessage: row.error_message ?? undefined,
    startedAt: row.started_at, completedAt: row.completed_at ?? undefined };
}
function mapSnapshot(row: any): TurnSnapshot {
  const limits = row.limits_json === null ? undefined : parse(row.limits_json) as NonNullable<TurnSnapshot['limits']>;
  return { tenantId: row.tenant_id, runId: row.run_id, attemptId: row.attempt_id, turnNo: row.turn_no,
    sessionVersion: BigInt(row.session_version), parentCommitId: row.parent_commit_id ?? undefined,
    identity: parse(row.identity_json), modelBinding: parse(row.model_binding_json), promptVersion: row.prompt_version,
    skillSetVersion: row.skill_set_version ?? undefined, toolSetVersion: row.tool_set_version,
    limits: limits || row.deadline_at ? { ...limits, deadlineAt: row.deadline_at ?? undefined } : undefined,
    policyVersion: row.policy_version, messages: parse(row.messages_json), deadlineAt: row.deadline_at ?? undefined,
    createdAt: row.created_at } as TurnSnapshot;
}

function withoutDeadline(limits: NonNullable<TurnSnapshot['limits']>) {
  const { deadlineAt: _deadlineAt, ...rest } = limits;
  return rest;
}
function mapCommit(row: any): TurnCommit {
  return { tenantId: row.tenant_id, runId: row.run_id, attemptId: row.attempt_id, turnNo: row.turn_no,
    commitId: row.commit_id, transcriptVersion: BigInt(row.transcript_version), stopReason: row.stop_reason ?? undefined,
    usage: parse(row.usage_json), eventSequenceEnd: BigInt(row.event_sequence_end), messages: parse(row.messages_json),
    committedAt: row.committed_at } as TurnCommit;
}
function ledgerValues(record: ToolLedgerRecord) {
  return { tenant_id: record.tenantId, run_id: record.runId, attempt_id: record.attemptId, turn_no: record.turnNo,
    session_id: '', tool_call_id: record.toolCallId, logical_call_id: record.logicalCallId,
    idempotency_key: record.idempotencyKey, capability: record.capability,
    external_correlation_id: record.externalCorrelationId ?? null, result_digest: record.resultDigest ?? null,
    approved_interaction_id: record.approvedInteractionId ?? null, tool_name: record.toolName, args_digest: record.argsDigest,
    status: record.status, result: record.result === undefined ? null : json(record.result),
    started_at: record.createdAt, completed_at: record.status === 'completed' ? record.updatedAt : null, updated_at: record.updatedAt };
}
function mapLedger(row: any): ToolLedgerRecord {
  return { tenantId: row.tenant_id, runId: row.run_id, attemptId: row.attempt_id ?? '', turnNo: row.turn_no ?? 0,
    logicalCallId: row.logical_call_id, toolCallId: row.tool_call_id, toolName: row.tool_name,
    argsDigest: row.args_digest, capability: row.capability, idempotencyKey: row.idempotency_key, status: row.status,
    externalCorrelationId: row.external_correlation_id ?? undefined, resultDigest: row.result_digest ?? undefined,
    approvedInteractionId: row.approved_interaction_id ?? undefined,
    result: row.result === null ? undefined : parse(row.result), createdAt: row.started_at, updatedAt: row.updated_at } as ToolLedgerRecord;
}
function leaseLost(): AgentPlatformError { return new AgentPlatformError({ code: 'LEASE_LOST', message: 'LEASE_LOST', retryable: false }); }
function commitFailed(message: string): AgentPlatformError { return new AgentPlatformError({ code: 'TURN_COMMIT_FAILED', message, retryable: false }); }
