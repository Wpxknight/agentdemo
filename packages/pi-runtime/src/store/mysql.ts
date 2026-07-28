import { randomUUID } from 'node:crypto';
import {
  AgentPlatformError, LeaseLostError, RunNotFoundError, type AgentRunEvent, type AgentRunUsage,
  type RunRecord,
} from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { Kysely, Transaction } from 'kysely';
import type {
  ClaimInboxInput, ConsumeInboxInput, DurableRunStore, EnqueueInboxInput, PiSessionRecord, RunInboxMessage,
  SessionEntryRecord, StoredRun,
} from './types.js';
import { assertAttemptAllowed, assertTurnAllowed } from '../run/limits.js';

type Db = Kysely<any> | Transaction<any>;

export class MysqlRunStore implements DurableRunStore {
  constructor(private readonly db: Db, private readonly transactionalView = false, private readonly now: () => Date = () => new Date()) {}

  async create(input: Parameters<DurableRunStore['create']>[0]): Promise<RunRecord> {
    const record = input.record;
    return this.transaction(async (store) => {
      await store.db.insertInto('pi_sessions').values({
        tenant_id: record.tenantId, session_id: record.sessionId, current_leaf_id: null, committed_leaf_id: null,
        metadata_json: null, created_at: record.createdAt, updated_at: record.updatedAt,
      }).ignore().execute();
      await store.db.selectFrom('pi_sessions').select('session_id')
        .where('tenant_id', '=', record.tenantId).where('session_id', '=', record.sessionId).forUpdate().executeTakeFirstOrThrow();
      const active = await store.db.selectFrom('agent_runs').select('run_id')
        .where('tenant_id', '=', record.tenantId).where('session_id', '=', record.sessionId)
        .where('status', 'in', ['queued', 'running', 'waiting']).limit(1).executeTakeFirst();
      if (active) throw conflict('Session already has an active run');
      await store.db.insertInto('agent_runs').values({
        tenant_id: record.tenantId, run_id: record.runId, user_id: record.actorId, session_id: record.sessionId,
        kernel: record.kernel, kernel_version: record.kernelVersion, graph_name: '', graph_version: '', runtime_version: 'pi-durable-v1',
        status: record.status, waiting_reason: record.waitingReason ?? null, current_node: null, step_count: 0,
        input_tokens: record.usage.inputTokens, output_tokens: record.usage.outputTokens,
        cache_read_tokens: record.usage.cacheReadTokens, cache_creation_tokens: record.usage.cacheCreationTokens,
        cost_usd: record.usage.costUsd ?? null, limits_json: record.limits ? JSON.stringify(record.limits) : null,
        error_message: null, started_at: null, updated_at: record.updatedAt, completed_at: null,
        cancel_requested_at: null, lease_owner: record.leaseOwner ?? null, lease_token: Number(record.leaseToken),
        lease_expires_at: record.leaseExpiresAt ?? null, append_closed_at: null, created_at: record.createdAt,
      }).execute();
      return record;
    });
  }

  async get(identity: { tenantId: string; runId: string }): Promise<StoredRun | undefined> {
    const row = await this.db.selectFrom('agent_runs').selectAll().where('tenant_id', '=', identity.tenantId)
      .where('run_id', '=', identity.runId).executeTakeFirst();
    if (!row) return undefined;
    const last = await this.db.selectFrom('agent_turn_commits').selectAll().where('tenant_id', '=', identity.tenantId)
      .where('run_id', '=', identity.runId).orderBy('turn_no', 'desc').executeTakeFirst();
    return mapRun(row, last);
  }

  async claim(input: Parameters<DurableRunStore['claim']>[0]): Promise<Awaited<ReturnType<DurableRunStore['claim']>>> {
    return this.transaction(async (store) => {
      const candidate = await store.db.selectFrom('agent_runs').select(['session_id'])
        .where('tenant_id', '=', input.identity.tenantId).where('run_id', '=', input.runId).executeTakeFirst();
      if (!candidate) throw new RunNotFoundError();
      await store.db.selectFrom('pi_sessions').select('session_id')
        .where('tenant_id', '=', input.identity.tenantId).where('session_id', '=', candidate.session_id)
        .forUpdate().executeTakeFirstOrThrow();
      const row = await store.db.selectFrom('agent_runs').selectAll().where('tenant_id', '=', input.identity.tenantId)
        .where('run_id', '=', input.runId).forUpdate().executeTakeFirst();
      if (!row) throw new RunNotFoundError();
      if (!canManageRun(input.identity, row.user_id) || ['succeeded', 'cancelled'].includes(row.status)) return null;
      if (['waiting', 'failed', 'recovery_required'].includes(row.status) && !input.resume) return null;
      if (input.resume) {
        const active = await store.db.selectFrom('agent_runs').select('run_id')
          .where('tenant_id', '=', input.identity.tenantId).where('session_id', '=', row.session_id)
          .where('run_id', '!=', input.runId).where('status', 'in', ['queued', 'running', 'waiting'])
          .limit(1).executeTakeFirst();
        if (active) throw conflict('Session already has an active run');
      }
      const attemptCount = await store.db.selectFrom('agent_run_attempts').select(({ fn }) => fn.countAll<number>().as('count'))
        .where('tenant_id', '=', input.identity.tenantId).where('run_id', '=', input.runId).executeTakeFirstOrThrow();
      const limits = row.limits_json === null || row.limits_json === undefined ? undefined : reviveLimits(parse(row.limits_json));
      assertAttemptAllowed(limits, Number(attemptCount.count), input.now);
      const lastTurn = await store.db.selectFrom('agent_turn_commits').select(({ fn }) => fn.max<number>('turn_no').as('turn_no'))
        .where('tenant_id', '=', input.identity.tenantId).where('run_id', '=', input.runId).executeTakeFirst();
      assertTurnAllowed(limits, Number(lastTurn?.turn_no ?? 0) + 1);
      if (row.lease_owner && row.lease_owner !== input.workerId && row.lease_expires_at && row.lease_expires_at > input.now) return null;
      const same = row.lease_owner === input.workerId && row.lease_expires_at && row.lease_expires_at > input.now;
      const fencingToken = BigInt(same ? row.lease_token : Number(row.lease_token) + 1);
      const attemptId = randomUUID();
      await store.db.updateTable('agent_runs').set({
        status: 'running', lease_owner: input.workerId, lease_token: Number(fencingToken),
        lease_expires_at: new Date(input.now.getTime() + input.leaseTtlMs), updated_at: input.now,
        ...(input.resume && ['waiting', 'failed', 'recovery_required'].includes(row.status) ? { append_closed_at: null } : {}),
      }).where('tenant_id', '=', input.identity.tenantId).where('run_id', '=', input.runId).execute();
      await store.db.insertInto('agent_run_attempts').values({
        tenant_id: input.identity.tenantId, run_id: input.runId, attempt_id: attemptId, worker_id: input.workerId,
        lease_token: Number(fencingToken), kernel: row.kernel, kernel_version: row.kernel_version, status: 'running',
        error_code: null, error_message: null, started_at: input.now, completed_at: null,
      }).execute();
      return { record: mapRun({
        ...row, status: 'running', lease_owner: input.workerId, lease_token: Number(fencingToken),
        lease_expires_at: new Date(input.now.getTime() + input.leaseTtlMs),
        ...(input.resume && ['waiting', 'failed', 'recovery_required'].includes(row.status) ? { append_closed_at: null } : {}),
      }), attemptId, fencingToken };
    });
  }

  async renewLease(input: Parameters<DurableRunStore['renewLease']>[0]): Promise<void> {
    const result = await this.db.updateTable('agent_runs').set({
      lease_expires_at: new Date(input.now.getTime() + input.leaseTtlMs), updated_at: input.now,
    }).where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId)
      .where('lease_owner', '=', input.workerId).where('lease_token', '=', Number(input.fencingToken))
      .where('lease_expires_at', '>', input.now).executeTakeFirst();
    if (!affected(result)) throw new LeaseLostError();
  }

  async commitTurn(input: Parameters<DurableRunStore['commitTurn']>[0]): Promise<void> {
    await this.transaction(async (store) => {
      const run = await store.assertLease(input.tenantId, input.runId, input.fencingToken, true, undefined, input.committedAt);
      if (run.cancel_requested_at) throw conflict('Cancellation won the commit race');
      const existing = await store.db.selectFrom('agent_turn_commits').selectAll()
        .where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId)
        .where('attempt_id', '=', input.attemptId).where('turn_no', '=', input.turnNo).executeTakeFirst();
      if (existing) return;
      const checkpoint = asRecord(input.checkpoint);
      const piSessionId = stringValue(checkpoint.piSessionId);
      const piLeafId = stringValue(checkpoint.piLeafId);
      let piEntrySeq: number | null = null;
      if (piSessionId && piLeafId) {
        const entry = await store.db.selectFrom('pi_session_entries').select('entry_seq')
          .where('tenant_id', '=', input.tenantId).where('session_id', '=', piSessionId)
          .where('entry_id', '=', piLeafId).executeTakeFirst();
        if (!entry) throw conflict('Pi leaf is outside tenant/session');
        piEntrySeq = Number(entry.entry_seq);
      }
      const last = await store.db.selectFrom('agent_turn_commits').select(({ fn }) => fn.max<number>('transcript_version').as('version'))
        .where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId).executeTakeFirst();
      let eventSequenceEnd = 0;
      for (const event of input.events) {
        eventSequenceEnd = await store.appendEvent(event);
      }
      await store.db.insertInto('agent_turn_commits').values({
        tenant_id: input.tenantId, run_id: input.runId, attempt_id: input.attemptId, turn_no: input.turnNo,
        pi_session_id: piSessionId, pi_leaf_id: piLeafId, pi_entry_seq: piEntrySeq,
        commit_id: randomUUID(), transcript_version: Number(last?.version ?? 0) + 1, stop_reason: null,
        usage_json: JSON.stringify(input.usage), messages_json: JSON.stringify(input.checkpoint),
        event_sequence_end: eventSequenceEnd, committed_at: input.committedAt,
      }).execute();
      if (piSessionId) {
        await store.db.updateTable('pi_sessions').set({ committed_leaf_id: piLeafId, updated_at: input.committedAt })
          .where('tenant_id', '=', input.tenantId).where('session_id', '=', piSessionId).execute();
      }
      await store.db.updateTable('agent_runs').set({
        status: input.status, input_tokens: input.usage.inputTokens, output_tokens: input.usage.outputTokens,
        cache_read_tokens: input.usage.cacheReadTokens, cache_creation_tokens: input.usage.cacheCreationTokens,
        cost_usd: input.usage.costUsd ?? null, updated_at: input.committedAt,
      }).where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId).execute();
    });
  }

  async requestCancellation(input: Parameters<DurableRunStore['requestCancellation']>[0]): Promise<void> {
    await this.transaction(async (store) => {
      const row = await store.db.selectFrom('agent_runs').selectAll().where('tenant_id', '=', input.identity.tenantId)
        .where('run_id', '=', input.runId).forUpdate().executeTakeFirst();
      if (!row || !canManageRun(input.identity, row.user_id)) throw new RunNotFoundError();
      await store.db.updateTable('agent_runs').set({ cancel_requested_at: input.requestedAt, updated_at: input.requestedAt })
        .where('tenant_id', '=', input.identity.tenantId).where('run_id', '=', input.runId).execute();
    });
  }

  async complete(input: Parameters<DurableRunStore['complete']>[0]): Promise<void> {
    await this.transaction(async (store) => {
      const row = await store.assertLease(input.tenantId, input.runId, input.fencingToken, true);
      const status = row.cancel_requested_at ? 'cancelled' : input.status;
      await store.db.updateTable('agent_runs').set({
        status, input_tokens: input.usage.inputTokens, output_tokens: input.usage.outputTokens,
        cache_read_tokens: input.usage.cacheReadTokens, cache_creation_tokens: input.usage.cacheCreationTokens,
        cost_usd: input.usage.costUsd ?? null,
        error_message: input.error?.message ?? null, completed_at: input.completedAt, updated_at: input.completedAt,
        lease_owner: null, lease_expires_at: null, append_closed_at: row.append_closed_at ?? input.completedAt,
      }).where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId).execute();
      await store.db.updateTable('agent_run_attempts').set({ status, completed_at: input.completedAt })
        .where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId)
        .where('attempt_id', '=', input.attemptId).execute();
    });
  }

  async listEvents(identity: { tenantId: string; runId: string }, after = 0n): Promise<AgentRunEvent[]> {
    const rows = await this.db.selectFrom('agent_run_events').selectAll().where('tenant_id', '=', identity.tenantId)
      .where('run_id', '=', identity.runId).where('sequence', '>', Number(after)).orderBy('sequence', 'asc').execute();
    return rows.map(mapEvent);
  }

  async isCancellationRequested(identity: { tenantId: string; runId: string }): Promise<boolean> {
    const row = await this.db.selectFrom('agent_runs').select('cancel_requested_at').where('tenant_id', '=', identity.tenantId)
      .where('run_id', '=', identity.runId).executeTakeFirst();
    return Boolean(row?.cancel_requested_at);
  }

  async countAttempts(identity: { tenantId: string; runId: string }): Promise<number> {
    const row = await this.db.selectFrom('agent_run_attempts').select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', identity.tenantId).where('run_id', '=', identity.runId).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async closeInbox(input: Parameters<DurableRunStore['closeInbox']>[0]): Promise<void> {
    await this.transaction(async (store) => {
      const row = await store.assertLease(input.tenantId, input.runId, input.fencingToken, true, input.workerId, input.now);
      await store.db.updateTable('agent_runs').set({
        append_closed_at: row.append_closed_at ?? input.now, updated_at: input.now,
      }).where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId).execute();
    });
  }

  readonly sessions = {
    create: async (input: { tenantId: string; sessionId: string; createdAt: Date; metadata?: Record<string, unknown> }): Promise<PiSessionRecord> => {
      await this.db.insertInto('pi_sessions').values({
        tenant_id: input.tenantId, session_id: input.sessionId, current_leaf_id: null, committed_leaf_id: null,
        metadata_json: input.metadata ? JSON.stringify(input.metadata) : null, created_at: input.createdAt, updated_at: input.createdAt,
      }).ignore().execute();
      return (await this.sessions.get(input.tenantId, input.sessionId))!;
    },
    get: async (tenantId: string, sessionId: string): Promise<PiSessionRecord | undefined> => {
      const row = await this.db.selectFrom('pi_sessions').selectAll().where('tenant_id', '=', tenantId)
        .where('session_id', '=', sessionId).executeTakeFirst();
      return row ? mapSession(row) : undefined;
    },
    appendEntry: async (tenantId: string, sessionId: string, entry: SessionTreeEntry): Promise<SessionEntryRecord> => this.transaction(async (store) => {
      await store.db.selectFrom('pi_sessions').select('session_id').where('tenant_id', '=', tenantId)
        .where('session_id', '=', sessionId).forUpdate().executeTakeFirstOrThrow();
      if (entry.parentId) {
        const parent = await store.db.selectFrom('pi_session_entries').select('entry_id').where('tenant_id', '=', tenantId)
          .where('session_id', '=', sessionId).where('entry_id', '=', entry.parentId).executeTakeFirst();
        if (!parent) throw conflict('Pi parent is outside tenant/session');
      }
      const last = await store.db.selectFrom('pi_session_entries').select(({ fn }) => fn.max<number>('entry_seq').as('sequence'))
        .where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).executeTakeFirst();
      const sequence = Number(last?.sequence ?? 0) + 1;
      await store.db.insertInto('pi_session_entries').values({
        tenant_id: tenantId, session_id: sessionId, entry_id: entry.id, entry_seq: sequence,
        parent_id: entry.parentId, entry_type: entry.type, entry_json: JSON.stringify(entry), created_at: new Date(entry.timestamp),
      }).execute();
      await store.db.updateTable('pi_sessions').set({
        current_leaf_id: entry.type === 'leaf' ? entry.targetId : entry.id, updated_at: new Date(entry.timestamp),
      }).where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).execute();
      return { tenantId, sessionId, sequence: BigInt(sequence), entry };
    }),
    listEntries: async (tenantId: string, sessionId: string, options: { afterSequence?: bigint; committedOnly?: boolean } = {}): Promise<SessionEntryRecord[]> => {
      let query = this.db.selectFrom('pi_session_entries').selectAll().where('tenant_id', '=', tenantId)
        .where('session_id', '=', sessionId).where('entry_seq', '>', Number(options.afterSequence ?? 0n)).orderBy('entry_seq', 'asc');
      const rows = await query.execute();
      let records = rows.map((row: any) => ({ tenantId, sessionId, sequence: BigInt(row.entry_seq), entry: parse(row.entry_json) as SessionTreeEntry }));
      if (options.committedOnly) {
        const leaf = (await this.sessions.get(tenantId, sessionId))?.committedLeafId ?? null;
        const ids = reachable(records, leaf);
        records = records.filter((record) => ids.has(record.entry.id));
      }
      return records;
    },
    setCurrentLeaf: async (tenantId: string, sessionId: string, leafId: string | null): Promise<void> => {
      if (leafId) {
        const entry = await this.db.selectFrom('pi_session_entries').select('entry_id').where('tenant_id', '=', tenantId)
          .where('session_id', '=', sessionId).where('entry_id', '=', leafId).executeTakeFirst();
        if (!entry) throw conflict('Pi leaf is outside tenant/session');
      }
      await this.db.updateTable('pi_sessions').set({ current_leaf_id: leafId, updated_at: this.now() })
        .where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).execute();
    },
  };

  readonly inbox = {
    enqueue: async (input: EnqueueInboxInput): Promise<RunInboxMessage> => this.transaction(async (store) => {
      const run = await store.db.selectFrom('agent_runs').selectAll().where('tenant_id', '=', input.tenantId)
        .where('run_id', '=', input.runId).forUpdate().executeTakeFirst();
      if (!run || !canManageRun(input.identity, run.user_id)) throw new RunNotFoundError();
      if (run.append_closed_at || !['queued', 'running', 'waiting', 'recovery_required'].includes(run.status)) {
        throw conflict('Run no longer accepts appended messages');
      }
      const duplicate = await store.db.selectFrom('agent_run_inbox_messages').selectAll()
        .where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId)
        .where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
      if (duplicate) return mapInbox(duplicate);
      const last = await store.db.selectFrom('agent_run_inbox_messages').select(({ fn }) => fn.max<number>('sequence').as('sequence'))
        .where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId).executeTakeFirst();
      const message: RunInboxMessage = {
        ...input, id: randomUUID(), sequence: BigInt(Number(last?.sequence ?? 0) + 1), status: 'pending',
      };
      await store.db.insertInto('agent_run_inbox_messages').values(inboxValues(message)).execute();
      return message;
    }),
    claimNext: async (input: ClaimInboxInput): Promise<RunInboxMessage | undefined> => this.transaction(async (store) => {
      await store.assertLease(input.tenantId, input.runId, input.fencingToken, true, input.workerId, input.now);
      const row = await store.db.selectFrom('agent_run_inbox_messages').selectAll()
        .where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId)
        .where((eb) => eb.or([eb('status', '=', 'pending'), eb.and([eb('status', '=', 'claimed'), eb('claim_expires_at', '<=', input.now)])]))
        .orderBy('sequence', 'asc').forUpdate().executeTakeFirst();
      if (!row) return undefined;
      const claimToken = randomUUID();
      const claimExpiresAt = new Date(input.now.getTime() + input.claimTtlMs);
      await store.db.updateTable('agent_run_inbox_messages').set({
        status: 'claimed', claim_owner: input.workerId, claim_token: claimToken, claim_expires_at: claimExpiresAt,
      }).where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId)
        .where('message_id', '=', row.message_id).execute();
      return mapInbox({ ...row, status: 'claimed', claim_owner: input.workerId, claim_token: claimToken, claim_expires_at: claimExpiresAt });
    }),
    markConsumed: async (input: ConsumeInboxInput): Promise<void> => this.transaction(async (store) => {
      await store.assertLease(input.tenantId, input.runId, input.fencingToken, true, input.workerId, input.consumedAt);
      const result = await store.db.updateTable('agent_run_inbox_messages').set({
        status: 'consumed', consumed_at: input.consumedAt, claim_expires_at: null,
      }).where('tenant_id', '=', input.tenantId).where('run_id', '=', input.runId).where('message_id', '=', input.id)
        .where('claim_owner', '=', input.workerId).where('claim_token', '=', input.claimToken).executeTakeFirst();
      if (!affected(result)) throw new LeaseLostError();
    }),
    list: async (tenantId: string, runId: string): Promise<RunInboxMessage[]> =>
      (await this.db.selectFrom('agent_run_inbox_messages').selectAll().where('tenant_id', '=', tenantId)
        .where('run_id', '=', runId).orderBy('sequence', 'asc').execute()).map(mapInbox),
  };

  private async transaction<T>(work: (store: MysqlRunStore) => Promise<T>): Promise<T> {
    if (this.transactionalView) return work(this);
    return (this.db as Kysely<any>).transaction().execute((tx) => work(new MysqlRunStore(tx, true, this.now)));
  }

  private async assertLease(
    tenantId: string, runId: string, token: bigint, lock: boolean, owner?: string, at = this.now(),
  ): Promise<any> {
    let query = this.db.selectFrom('agent_runs').selectAll().where('tenant_id', '=', tenantId).where('run_id', '=', runId)
      .where('lease_token', '=', Number(token)).where('lease_expires_at', '>', at);
    if (owner) query = query.where('lease_owner', '=', owner);
    if (lock) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new LeaseLostError();
    return row;
  }

  private async appendEvent(event: Omit<AgentRunEvent, 'sequence'>): Promise<number> {
    const last = await this.db.selectFrom('agent_run_events').select(({ fn }) => fn.max<number>('sequence').as('sequence'))
      .where('tenant_id', '=', event.tenantId).where('run_id', '=', event.runId).executeTakeFirst();
    const sequence = Number(last?.sequence ?? 0) + 1;
    await this.db.insertInto('agent_run_events').values({
      tenant_id: event.tenantId, run_id: event.runId, sequence, event_type: event.type, attempt_id: event.attemptId,
      turn_no: event.turnNo, kernel: event.kernel, kernel_version: event.kernelVersion, correlation_id: event.correlationId,
      node_name: null, status: null, detail: event.detail === undefined ? null : JSON.stringify(event.detail), created_at: event.createdAt,
    }).execute();
    return sequence;
  }
}

function mapRun(row: any, commit?: any): StoredRun {
  return {
    tenantId: row.tenant_id, runId: row.run_id, actorId: row.user_id, sessionId: row.session_id,
    kernel: row.kernel, kernelVersion: row.kernel_version, status: row.status, waitingReason: row.waiting_reason ?? undefined,
    leaseToken: BigInt(row.lease_token), leaseOwner: row.lease_owner ?? undefined, leaseExpiresAt: row.lease_expires_at ?? undefined,
    limits: row.limits_json === null || row.limits_json === undefined ? undefined : reviveLimits(parse(row.limits_json)),
    usage: usage(row), createdAt: row.created_at, updatedAt: row.updated_at,
    cancelRequestedAt: row.cancel_requested_at ?? undefined, lastTurnNo: Number(commit?.turn_no ?? 0),
    checkpoint: commit ? parse(commit.messages_json) : undefined, appendClosedAt: row.append_closed_at ?? undefined,
  };
}
function mapSession(row: any): PiSessionRecord { return {
  tenantId: row.tenant_id, sessionId: row.session_id, currentLeafId: row.current_leaf_id,
  committedLeafId: row.committed_leaf_id, metadata: row.metadata_json === null ? undefined : parse(row.metadata_json),
  createdAt: row.created_at, updatedAt: row.updated_at,
}; }
function mapInbox(row: any): RunInboxMessage { return {
  tenantId: row.tenant_id, runId: row.run_id, id: row.message_id, sequence: BigInt(row.sequence),
  idempotencyKey: row.idempotency_key, mode: row.mode, message: parse(row.message_json), status: row.status,
  claimOwner: row.claim_owner ?? undefined, claimToken: row.claim_token ?? undefined,
  claimExpiresAt: row.claim_expires_at ?? undefined, createdAt: row.created_at, consumedAt: row.consumed_at ?? undefined,
}; }
function mapEvent(row: any): AgentRunEvent { return {
  tenantId: row.tenant_id, runId: row.run_id, sequence: BigInt(row.sequence), type: row.event_type,
  attemptId: row.attempt_id, turnNo: row.turn_no, kernel: row.kernel, kernelVersion: row.kernel_version,
  correlationId: row.correlation_id, detail: row.detail === null ? undefined : parse(row.detail), createdAt: row.created_at,
}; }
function inboxValues(message: RunInboxMessage) { return {
  tenant_id: message.tenantId, run_id: message.runId, message_id: message.id, sequence: Number(message.sequence),
  idempotency_key: message.idempotencyKey, mode: message.mode, message_json: JSON.stringify(message.message),
  status: message.status, claim_owner: null, claim_token: null, claim_expires_at: null,
  created_at: message.createdAt, consumed_at: null,
}; }
function reachable(records: SessionEntryRecord[], leaf: string | null): Set<string> {
  const byId = new Map(records.map((record) => [record.entry.id, record.entry]));
  const ids = new Set<string>();
  while (leaf) { const entry = byId.get(leaf); if (!entry || ids.has(leaf)) break; ids.add(leaf); leaf = entry.parentId; }
  return ids;
}
function usage(row: any): AgentRunUsage { return {
  inputTokens: row.input_tokens, outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens,
  costUsd: row.cost_usd === null || row.cost_usd === undefined ? undefined : Number(row.cost_usd),
}; }
function affected(result: any): boolean { return Number(result.numUpdatedRows ?? result.numAffectedRows ?? 0) > 0; }
function parse(value: unknown): any { return typeof value === 'string' ? JSON.parse(value) : value; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function conflict(message: string): AgentPlatformError { return new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message, retryable: false }); }
function canManageRun(identity: { actorId: string; roles: readonly string[] }, actorId: string): boolean {
  return identity.actorId === actorId || identity.roles.includes('tenant_admin') || identity.roles.includes('platform_admin');
}
function reviveLimits(value: any): any {
  return value && typeof value === 'object' && value.deadlineAt
    ? { ...value, deadlineAt: new Date(value.deadlineAt) }
    : value;
}
