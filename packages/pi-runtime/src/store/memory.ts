import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  AgentPlatformError, LeaseLostError, RunNotFoundError, type AgentRunEvent, type DurableInteractionUpdate,
  type DurableToolLedgerUpdate,
} from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type {
  ClaimInboxInput, ConsumeInboxInput, DurableRunStore, EnqueueInboxInput, PiSessionRecord, RunInboxMessage,
  SessionEntryRecord, StoredRun, DurableProductRunStore, ProductAttemptRecord, ProductTurnCommit,
} from './types.js';
import { assertAttemptAllowed, assertTurnAllowed } from '../run/limits.js';
import { sessionStats } from './session-stats.js';
import { piSessionStorageId } from './session-id.js';

const clone = <T>(value: T): T => structuredClone(value);
const key = (tenantId: string, id: string): string => `${tenantId}\0${id}`;
type MutationContext = { active: boolean };

export class MemoryRunStore implements DurableProductRunStore {
  private readonly runRecords = new Map<string, StoredRun>();
  private readonly attemptsState = new Map<string, ProductAttemptRecord>();
  private readonly commits = new Map<string, ProductTurnCommit[]>();
  private readonly eventRecords = new Map<string, AgentRunEvent[]>();
  private readonly sessionRecords = new Map<string, PiSessionRecord>();
  private readonly sessionEntries = new Map<string, SessionEntryRecord[]>();
  private readonly inboxMessages = new Map<string, RunInboxMessage[]>();
  private readonly interactionRecords = new Map<string, DurableInteractionUpdate>();
  private readonly toolLedgerRecords = new Map<string, DurableToolLedgerUpdate>();
  private transactionTail: Promise<void> = Promise.resolve();
  private readonly mutationContext = new AsyncLocalStorage<MutationContext>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: Parameters<DurableRunStore['create']>[0]): Promise<StoredRun & { sessionCreated: boolean }> {
    return this.lock(async () => {
      const record: StoredRun = {
        ...clone(input.record), lastTurnNo: 0, runtimeVersion: 'pi-durable-v1', graphName: '', graphVersion: '', stepCount: 0,
      };
      const runKey = key(record.tenantId, record.runId);
      if (this.runRecords.has(runKey)) throw conflict('Run already exists');
      const active = [...this.runRecords.values()].some((run) => run.tenantId === record.tenantId
        && run.actorId === record.actorId && run.sessionId === record.sessionId
        && ['queued', 'running', 'waiting'].includes(run.status));
      if (active) throw conflict('Session already has an active run');
      const sessionId = piSessionStorageId(record.actorId, record.sessionId);
      const sessionKey = key(record.tenantId, sessionId);
      const sessionCreated = !this.sessionRecords.has(sessionKey);
      if (sessionCreated) this.sessionRecords.set(sessionKey, {
        tenantId: record.tenantId, sessionId, createdAt: record.createdAt, updatedAt: record.createdAt,
        currentLeafId: null, committedLeafId: null,
      });
      this.runRecords.set(runKey, record);
      return clone({ ...record, sessionCreated });
    });
  }

  async get(identity: { tenantId: string; runId: string }): Promise<StoredRun | undefined> {
    return clone(this.runRecords.get(key(identity.tenantId, identity.runId)));
  }

  async listRuns(tenantId: string): Promise<StoredRun[]> {
    return clone([...this.runRecords.values()].filter((run) => run.tenantId === tenantId));
  }

  async updateProductRun(identity: { tenantId: string; runId: string }, patch: Partial<StoredRun>): Promise<boolean> {
    return this.lock(async () => {
      const run = this.runRecords.get(key(identity.tenantId, identity.runId));
      if (!run) return false;
      Object.assign(run, clone(patch), identity);
      return true;
    });
  }

  async markRecoveryRequired(input: {
    identity: Parameters<DurableRunStore['claim']>[0]['identity']; runId: string; errorMessage: string; failedAt: Date;
    expectedLease?: { ownerId: string; token: bigint };
  }): Promise<boolean> {
    return this.lock(async () => {
      const run = this.runRecords.get(key(input.identity.tenantId, input.runId));
      if (!run || !canManageRun(input.identity, run.actorId) || ['succeeded', 'cancelled'].includes(run.status)) return false;
      const activeLease = Boolean(run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt > input.failedAt);
      if (input.expectedLease) {
        if (run.leaseToken !== input.expectedLease.token
          || (run.leaseOwner && run.leaseOwner !== input.expectedLease.ownerId)) return false;
      } else if (activeLease) return false;
      run.status = 'recovery_required';
      run.waitingReason = undefined;
      run.errorMessage = input.errorMessage;
      run.completedAt = input.failedAt;
      run.appendClosedAt ??= input.failedAt;
      run.updatedAt = input.failedAt;
      run.leaseOwner = undefined;
      run.leaseExpiresAt = undefined;
      for (const attempt of this.attemptsState.values()) {
        if (attempt.tenantId === run.tenantId && attempt.runId === run.runId && attempt.status === 'running') {
          Object.assign(attempt, { status: 'failed', errorMessage: input.errorMessage, completedAt: input.failedAt });
        }
      }
      return true;
    });
  }

  async claim(input: Parameters<DurableRunStore['claim']>[0]): Promise<Awaited<ReturnType<DurableRunStore['claim']>>> {
    return this.lock(async () => {
      const runKey = key(input.identity.tenantId, input.runId);
      const run = this.runRecords.get(runKey);
      if (!run) throw new RunNotFoundError();
      if (!canManageRun(input.identity, run.actorId)) return null;
      if (['succeeded', 'cancelled'].includes(run.status)) return null;
      if (['waiting', 'failed', 'recovery_required'].includes(run.status) && !input.resume) return null;
      if (run.status === 'waiting' && !input.resolution) {
        throw conflict('Waiting run requires an interaction resolution');
      }
      if (input.resolution) {
        const interaction = this.interactionRecords.get(key(runKey, input.resolution.interactionId));
        if (!interaction || interaction.status !== 'resolved' || !interaction.toolCallId
          || interaction.runId !== run.runId || interaction.tenantId !== run.tenantId
          || (run.status === 'waiting' && interaction.kind !== run.waitingReason)
          || JSON.stringify(interaction.resolution) !== JSON.stringify(input.resolution.value)) {
          throw conflict('Interaction resolution does not match the waiting run');
        }
      }
      if (input.resume && [...this.runRecords.values()].some((candidate) => candidate.tenantId === run.tenantId
        && candidate.actorId === run.actorId && candidate.sessionId === run.sessionId && candidate.runId !== run.runId
        && ['queued', 'running', 'waiting'].includes(candidate.status))) {
        throw conflict('Session already has an active run');
      }
      assertAttemptAllowed(run.limits, [...this.attemptsState.values()].filter((attempt) =>
        attempt.tenantId === run.tenantId && attempt.runId === run.runId).length, input.now);
      assertTurnAllowed(run.limits, run.lastTurnNo + 1);
      if (run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt > input.now && run.leaseOwner !== input.workerId) return null;
      const sameLease = run.leaseOwner === input.workerId && Boolean(run.leaseExpiresAt && run.leaseExpiresAt > input.now);
      const fencingToken = sameLease ? run.leaseToken : run.leaseToken + 1n;
      const attemptId = randomUUID();
      Object.assign(run, {
        leaseOwner: input.workerId, leaseToken: fencingToken,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseTtlMs), status: 'running', updatedAt: input.now,
        waitingReason: undefined,
        ...(input.resume && ['waiting', 'failed', 'recovery_required'].includes(run.status) ? { appendClosedAt: undefined } : {}),
      });
      this.attemptsState.set(key(runKey, attemptId), {
        tenantId: run.tenantId, runId: run.runId, attemptId, workerId: input.workerId,
        leaseToken: fencingToken, kernel: run.kernel, kernelVersion: run.kernelVersion,
        status: 'running', startedAt: input.now,
      });
      return { record: clone(run), attemptId, fencingToken };
    });
  }

  async renewLease(input: Parameters<DurableRunStore['renewLease']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.requireLease(input, input.now);
      run.leaseExpiresAt = new Date(input.now.getTime() + input.leaseTtlMs);
      run.updatedAt = input.now;
    });
  }

  async commitTurn(input: Parameters<DurableRunStore['commitTurn']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.requireLease(input, input.committedAt);
      if (input.turnNo <= run.lastTurnNo) {
        if (input.turnNo === run.lastTurnNo && JSON.stringify(run.checkpoint) === JSON.stringify(input.checkpoint)) return;
        throw conflict('Turn commit is not monotonic');
      }
      if (run.cancelRequestedAt && input.status !== 'cancelled') throw conflict('Cancellation won the commit race');
      const checkpoint = asRecord(input.checkpoint);
      const piSessionId = typeof checkpoint.piSessionId === 'string' ? checkpoint.piSessionId : undefined;
      const piLeafId = typeof checkpoint.piLeafId === 'string' ? checkpoint.piLeafId : null;
      if (piSessionId) {
        const session = this.sessionRecords.get(key(input.tenantId, piSessionId));
        if (!session) throw conflict('Pi session not found');
        if (piLeafId && !this.hasSessionEntry(input.tenantId, piSessionId, piLeafId)) throw conflict('Pi leaf not found');
        session.committedLeafId = piLeafId;
        session.updatedAt = input.committedAt;
      }
      const storedEvents = this.eventRecords.get(key(input.tenantId, input.runId)) ?? [];
      for (const event of input.events) storedEvents.push(clone({ ...event, sequence: BigInt(storedEvents.length + 1) }));
      this.eventRecords.set(key(input.tenantId, input.runId), storedEvents);
      const commits = this.commits.get(key(input.tenantId, input.runId)) ?? [];
      commits.push({
        tenantId: input.tenantId, runId: input.runId, attemptId: input.attemptId, turnNo: input.turnNo,
        commitId: randomUUID(), transcriptVersion: BigInt(commits.length + 1), usage: clone(input.usage),
        eventSequenceEnd: BigInt(storedEvents.length), committedAt: input.committedAt,
      });
      this.commits.set(key(input.tenantId, input.runId), commits);
      run.lastTurnNo = input.turnNo;
      run.checkpoint = clone(input.checkpoint);
      run.status = input.status;
      run.waitingReason = input.waitingReason;
      run.usage = clone(input.usage);
      run.updatedAt = input.committedAt;
      for (const interaction of input.interactionUpdates ?? []) {
        this.interactionRecords.set(key(key(interaction.tenantId, interaction.runId), interaction.id), clone(interaction));
      }
      for (const ledger of input.ledgerUpdates ?? []) {
        this.toolLedgerRecords.set(key(key(ledger.tenantId, ledger.runId), ledger.logicalCallId), clone(ledger));
      }
      if (input.status === 'waiting') {
        run.leaseOwner = undefined;
        run.leaseExpiresAt = undefined;
        const attempt = this.attemptsState.get(key(key(input.tenantId, input.runId), input.attemptId));
        if (attempt) Object.assign(attempt, { status: 'succeeded', completedAt: input.committedAt });
      }
      if (input.status === 'recovery_required') {
        run.result = { runId: input.runId, status: input.status, usage: clone(input.usage), error: input.error };
        run.appendClosedAt ??= input.committedAt;
        run.leaseOwner = undefined;
        run.leaseExpiresAt = undefined;
        const attempt = this.attemptsState.get(key(key(input.tenantId, input.runId), input.attemptId));
        if (attempt) Object.assign(attempt, { status: 'failed', completedAt: input.committedAt });
      }
    });
  }

  async requestCancellation(input: Parameters<DurableRunStore['requestCancellation']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.runRecords.get(key(input.identity.tenantId, input.runId));
      if (!run || !canManageRun(input.identity, run.actorId)) throw new RunNotFoundError();
      run.cancelRequestedAt ??= input.requestedAt;
      run.cancelReason ??= input.reason;
      run.updatedAt = input.requestedAt;
      const inactive = !run.leaseOwner || !run.leaseExpiresAt || run.leaseExpiresAt <= input.requestedAt;
      if (inactive && (run.status === 'queued' || run.status === 'waiting')) {
        run.status = 'cancelled';
        run.waitingReason = undefined;
        run.errorMessage = input.reason;
        run.result = { runId: run.runId, status: 'cancelled', usage: clone(run.usage) };
        run.appendClosedAt ??= input.requestedAt;
        run.completedAt ??= input.requestedAt;
        run.leaseOwner = undefined;
        run.leaseExpiresAt = undefined;
        for (const attempt of this.attemptsState.values()) {
          if (attempt.tenantId === run.tenantId && attempt.runId === run.runId && attempt.status === 'running') {
            Object.assign(attempt, { status: 'cancelled', completedAt: input.requestedAt });
          }
        }
      }
    });
  }

  async complete(input: Parameters<DurableRunStore['complete']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.requireLease(input, input.completedAt);
      const status = run.cancelRequestedAt ? 'cancelled' : input.status;
      run.status = status;
      run.waitingReason = undefined;
      run.usage = clone(input.usage);
      run.result = { runId: input.runId, status, usage: clone(input.usage), error: input.error };
      run.appendClosedAt ??= input.completedAt;
      run.leaseOwner = undefined;
      run.leaseExpiresAt = undefined;
      run.updatedAt = input.completedAt;
      const attempt = this.attemptsState.get(key(key(input.tenantId, input.runId), input.attemptId));
      if (attempt) Object.assign(attempt, { status, completedAt: input.completedAt });
    });
  }

  async listEvents(identity: { tenantId: string; runId: string }, after = 0n): Promise<AgentRunEvent[]> {
    return clone((this.eventRecords.get(key(identity.tenantId, identity.runId)) ?? []).filter((event) => event.sequence > after));
  }

  async appendEvents(input: Parameters<DurableRunStore['appendEvents']>[0]): Promise<void> {
    await this.lock(async () => {
      this.requireLease(input, input.appendedAt);
      const storedEvents = this.eventRecords.get(key(input.tenantId, input.runId)) ?? [];
      for (const event of input.events) storedEvents.push(clone({ ...event, sequence: BigInt(storedEvents.length + 1) }));
      this.eventRecords.set(key(input.tenantId, input.runId), storedEvents);
    });
  }

  async isCancellationRequested(identity: { tenantId: string; runId: string }): Promise<boolean> {
    return Boolean(this.runRecords.get(key(identity.tenantId, identity.runId))?.cancelRequestedAt);
  }

  async countAttempts(identity: { tenantId: string; runId: string }): Promise<number> {
    return [...this.attemptsState.values()].filter((attempt) => attempt.tenantId === identity.tenantId && attempt.runId === identity.runId).length;
  }

  async getInteraction(
    identity: { tenantId: string; runId: string; interactionId: string },
  ): Promise<DurableInteractionUpdate | undefined> {
    return clone(this.interactionRecords.get(key(key(identity.tenantId, identity.runId), identity.interactionId)));
  }

  async resolveInteraction(record: DurableInteractionUpdate): Promise<boolean> {
    return this.lock(async () => {
      const interactionKey = key(key(record.tenantId, record.runId), record.id);
      const current = this.interactionRecords.get(interactionKey);
      if (!current || current.status !== 'pending' || record.status !== 'resolved') return false;
      this.interactionRecords.set(interactionKey, clone(record));
      return true;
    });
  }

  async closeInbox(input: Parameters<DurableRunStore['closeInbox']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.requireLease(input, input.now);
      run.appendClosedAt ??= input.now;
      run.updatedAt = input.now;
    });
  }

  readonly runs = {
    assertLease: async (
      identity: { tenantId: string; runId: string }, ownerId: string, token: bigint, now: Date,
    ): Promise<void> => {
      const run = this.runsState(identity);
      if (!run || run.leaseOwner !== ownerId || run.leaseToken !== token
        || !run.leaseExpiresAt || run.leaseExpiresAt <= now) throw new LeaseLostError();
    },
  };

  readonly attempts = {
    list: async (identity: { tenantId: string; runId: string }): Promise<ProductAttemptRecord[]> =>
      clone([...this.attemptsState.values()]
        .filter((attempt) => attempt.tenantId === identity.tenantId && attempt.runId === identity.runId)
        .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())),
  };

  readonly turns = {
    listCommitted: async (identity: { tenantId: string; runId: string }): Promise<ProductTurnCommit[]> =>
      clone(this.commits.get(key(identity.tenantId, identity.runId)) ?? []),
  };

  readonly interactions = {
    put: async (record: DurableInteractionUpdate): Promise<void> => this.lock(async () => {
      this.interactionsState().set(key(key(record.tenantId, record.runId), record.id), clone(record));
    }),
    get: async (identity: { tenantId: string; runId: string; interactionId: string }) =>
      clone(this.interactionsState().get(key(key(identity.tenantId, identity.runId), identity.interactionId))),
    getById: async (tenantId: string, interactionId: string) => clone(
      [...this.interactionsState().values()].find((record) => record.tenantId === tenantId && record.id === interactionId),
    ),
    list: async (identity: { tenantId: string; runId: string }) => clone(
      [...this.interactionsState().values()]
        .filter((record) => record.tenantId === identity.tenantId && record.runId === identity.runId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    ),
    listByTenant: async (tenantId: string) => clone(
      [...this.interactionsState().values()]
        .filter((record) => record.tenantId === tenantId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    ),
  };

  readonly toolLedger = {
    putIfAbsent: async (record: DurableToolLedgerUpdate): Promise<boolean> => this.lock(async () => {
      const ledgerKey = key(key(record.tenantId, record.runId), record.logicalCallId);
      if (this.toolLedgerState().has(ledgerKey)) return false;
      this.toolLedgerState().set(ledgerKey, clone(record));
      return true;
    }),
    get: async (identity: { tenantId: string; runId: string; logicalCallId: string }) =>
      clone(this.toolLedgerState().get(key(key(identity.tenantId, identity.runId), identity.logicalCallId))),
    update: async (record: DurableToolLedgerUpdate): Promise<void> => this.lock(async () => {
      const ledgerKey = key(key(record.tenantId, record.runId), record.logicalCallId);
      if (!this.toolLedgerState().has(ledgerKey)) throw new Error('Tool ledger record not found');
      this.toolLedgerState().set(ledgerKey, clone(record));
    }),
    claimPendingApproval: async (input: import('./types.js').ToolLedgerApprovalClaim): Promise<boolean> => this.lock(async () => {
      const ledgerKey = key(key(input.tenantId, input.runId), input.logicalCallId);
      const current = this.toolLedgerState().get(ledgerKey);
      if (!current || current.status !== 'pending_approval' || current.attemptId !== input.attemptId
        || current.turnNo !== input.turnNo || current.toolCallId !== input.toolCallId
        || current.toolName !== input.toolName || current.argsDigest !== input.argsDigest
        || current.approvedInteractionId !== input.approvedInteractionId) return false;
      this.toolLedgerState().set(ledgerKey, clone(input.started));
      return true;
    }),
    list: async (identity: { tenantId: string; runId: string }) => clone(
      [...this.toolLedgerRecords.values()]
        .filter((record) => record.tenantId === identity.tenantId && record.runId === identity.runId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    ),
  };

  readonly events = {
    append: async (event: Omit<AgentRunEvent, 'sequence'>): Promise<AgentRunEvent> => this.lock(async () => {
      const events = this.eventsState(event);
      const stored = clone({ ...event, sequence: BigInt(events.length + 1) });
      events.push(stored);
      return clone(stored);
    }),
    list: (identity: { tenantId: string; runId: string }, after = 0n) => this.listEvents(identity, after),
  };

  async transaction<T>(work: (tx: DurableProductRunStore) => Promise<T>): Promise<T> {
    return this.lock(async () => {
      const snapshot = clone({
        runRecords: this.runRecords,
        attemptsState: this.attemptsState,
        commits: this.commits,
        eventRecords: this.eventRecords,
        sessionRecords: this.sessionRecords,
        sessionEntries: this.sessionEntries,
        inboxMessages: this.inboxMessages,
        interactionRecords: this.interactionRecords,
        toolLedgerRecords: this.toolLedgerRecords,
      });
      try {
        return await work(this);
      } catch (error) {
        restoreMap(this.runRecords, snapshot.runRecords);
        restoreMap(this.attemptsState, snapshot.attemptsState);
        restoreMap(this.commits, snapshot.commits);
        restoreMap(this.eventRecords, snapshot.eventRecords);
        restoreMap(this.sessionRecords, snapshot.sessionRecords);
        restoreMap(this.sessionEntries, snapshot.sessionEntries);
        restoreMap(this.inboxMessages, snapshot.inboxMessages);
        restoreMap(this.interactionRecords, snapshot.interactionRecords);
        restoreMap(this.toolLedgerRecords, snapshot.toolLedgerRecords);
        throw error;
      }
    });
  }

  readonly sessions = {
    create: async (input: { tenantId: string; sessionId: string; createdAt: Date; metadata?: Record<string, unknown> }): Promise<PiSessionRecord> => this.lock(async () => {
      const sessionKey = key(input.tenantId, input.sessionId);
      const existing = this.sessionRecords.get(sessionKey);
      if (existing) return clone(existing);
      const record: PiSessionRecord = {
        ...clone(input), updatedAt: input.createdAt, currentLeafId: null, committedLeafId: null,
      };
      this.sessionRecords.set(sessionKey, record);
      return clone(record);
    }),
    get: async (tenantId: string, sessionId: string): Promise<PiSessionRecord | undefined> =>
      clone(this.sessionRecords.get(key(tenantId, sessionId))),
    appendEntry: async (tenantId: string, sessionId: string, entry: SessionTreeEntry): Promise<SessionEntryRecord> => this.lock(async () => {
      const sessionKey = key(tenantId, sessionId);
      const session = this.sessionRecords.get(sessionKey);
      if (!session) throw new Error('Pi session not found');
      const entries = this.sessionEntries.get(sessionKey) ?? [];
      if (entries.some((item) => item.entry.id === entry.id)) throw conflict('Pi entry already exists');
      if (entry.parentId && !entries.some((item) => item.entry.id === entry.parentId)) throw conflict('Pi parent is outside session');
      const stored = { tenantId, sessionId, sequence: BigInt(entries.length + 1), entry: clone(entry) };
      entries.push(stored);
      this.sessionEntries.set(sessionKey, entries);
      session.currentLeafId = entry.type === 'leaf' ? entry.targetId : entry.id;
      session.updatedAt = new Date(entry.timestamp);
      return clone(stored);
    }),
    listEntries: async (tenantId: string, sessionId: string, options: { afterSequence?: bigint; committedOnly?: boolean } = {}) => {
      let entries = this.sessionEntries.get(key(tenantId, sessionId)) ?? [];
      entries = entries.filter((entry) => entry.sequence > (options.afterSequence ?? 0n));
      if (options.committedOnly) {
        const leaf = this.sessionRecords.get(key(tenantId, sessionId))?.committedLeafId ?? null;
        const reachable = this.reachableEntryIds(entries, leaf);
        entries = entries.filter((entry) => reachable.has(entry.entry.id));
      }
      return clone(entries);
    },
    getSessionStats: async (tenantId: string, sessionId: string) => sessionStats(
      (await this.sessions.listEntries(tenantId, sessionId, { committedOnly: true })).map((record) => record.entry),
    ),
    setCurrentLeaf: async (tenantId: string, sessionId: string, leafId: string | null): Promise<void> => this.lock(async () => {
      const session = this.sessionRecords.get(key(tenantId, sessionId));
      if (!session) throw new Error('Pi session not found');
      if (leafId && !this.hasSessionEntry(tenantId, sessionId, leafId)) throw conflict('Pi leaf is outside session');
      session.currentLeafId = leafId;
      session.updatedAt = this.now();
    }),
  };

  readonly inbox = {
    enqueue: async (input: EnqueueInboxInput): Promise<RunInboxMessage> => this.lock(async () => {
      const run = this.runRecords.get(key(input.tenantId, input.runId));
      if (!run || !canManageRun(input.identity, run.actorId)) throw new RunNotFoundError();
      if (run.appendClosedAt || !['queued', 'running', 'waiting', 'recovery_required'].includes(run.status)) {
        throw conflict('Run no longer accepts appended messages');
      }
      const inboxKey = key(input.tenantId, input.runId);
      const messages = this.inboxMessages.get(inboxKey) ?? [];
      const duplicate = messages.find((message) => message.idempotencyKey === input.idempotencyKey);
      if (duplicate) return clone(duplicate);
      const message: RunInboxMessage = {
        ...clone(input), id: randomUUID(), sequence: BigInt(messages.length + 1), status: 'pending',
      };
      messages.push(message);
      this.inboxMessages.set(inboxKey, messages);
      return clone(message);
    }),
    claimNext: async (input: ClaimInboxInput): Promise<RunInboxMessage | undefined> => this.lock(async () => {
      const run = this.runRecords.get(key(input.tenantId, input.runId));
      if (!run || run.leaseOwner !== input.workerId || run.leaseToken !== input.fencingToken
        || !run.leaseExpiresAt || run.leaseExpiresAt <= input.now) throw new LeaseLostError();
      const message = (this.inboxMessages.get(key(input.tenantId, input.runId)) ?? [])
        .find((item) => item.status === 'pending' || (item.status === 'claimed' && item.claimExpiresAt! <= input.now));
      if (!message) return undefined;
      Object.assign(message, {
        status: 'claimed', claimOwner: input.workerId, claimToken: randomUUID(),
        claimExpiresAt: new Date(input.now.getTime() + input.claimTtlMs),
      });
      return clone(message);
    }),
    markConsumed: async (input: ConsumeInboxInput): Promise<void> => this.lock(async () => {
      this.requireLease(input, input.consumedAt);
      const message = (this.inboxMessages.get(key(input.tenantId, input.runId)) ?? []).find((item) => item.id === input.id);
      if (!message || message.claimOwner !== input.workerId || message.claimToken !== input.claimToken) throw new LeaseLostError();
      message.status = 'consumed';
      message.consumedAt = input.consumedAt;
      message.claimExpiresAt = undefined;
    }),
    list: async (tenantId: string, runId: string): Promise<RunInboxMessage[]> =>
      clone(this.inboxMessages.get(key(tenantId, runId)) ?? []),
  };

  private requireLease(input: { tenantId: string; runId: string; fencingToken: bigint; workerId?: string }, now: Date, checkExpiry = true): StoredRun {
    const run = this.runRecords.get(key(input.tenantId, input.runId));
    const ownerMismatch = input.workerId !== undefined && run?.leaseOwner !== input.workerId;
    if (!run || ownerMismatch || run.leaseToken !== input.fencingToken || (checkExpiry && (!run.leaseExpiresAt || run.leaseExpiresAt <= now))) {
      throw new LeaseLostError();
    }
    return run;
  }

  private runsState(identity: { tenantId: string; runId: string }): StoredRun | undefined {
    return this.runRecords.get(key(identity.tenantId, identity.runId));
  }

  private interactionsState(): Map<string, DurableInteractionUpdate> {
    return this.interactionRecords as unknown as Map<string, DurableInteractionUpdate>;
  }

  private toolLedgerState(): Map<string, DurableToolLedgerUpdate> {
    return this.toolLedgerRecords as unknown as Map<string, DurableToolLedgerUpdate>;
  }

  private eventsState(identity: { tenantId: string; runId: string }): AgentRunEvent[] {
    const eventKey = key(identity.tenantId, identity.runId);
    const events = this.eventRecords as unknown as Map<string, AgentRunEvent[]>;
    const stored = events.get(eventKey) ?? [];
    events.set(eventKey, stored);
    return stored;
  }

  private hasSessionEntry(tenantId: string, sessionId: string, entryId: string): boolean {
    return (this.sessionEntries.get(key(tenantId, sessionId)) ?? []).some((item) => item.entry.id === entryId);
  }

  private reachableEntryIds(entries: SessionEntryRecord[], leafId: string | null): Set<string> {
    const byId = new Map(entries.map((item) => [item.entry.id, item.entry]));
    const result = new Set<string>();
    let current = leafId;
    while (current) {
      const entry = byId.get(current);
      if (!entry || result.has(current)) break;
      result.add(current);
      current = entry.parentId;
    }
    return result;
  }

  private async lock<T>(work: () => Promise<T>): Promise<T> {
    if (this.mutationContext.getStore()?.active) return work();
    let release!: () => void;
    const prior = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    const context: MutationContext = { active: true };
    try {
      return await this.mutationContext.run(context, work);
    } finally {
      context.active = false;
      release();
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function conflict(message: string): AgentPlatformError {
  return new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message, retryable: false });
}

function canManageRun(identity: { actorId: string; roles: readonly string[] }, actorId: string): boolean {
  return identity.actorId === actorId || identity.roles.includes('tenant_admin') || identity.roles.includes('platform_admin');
}

function restoreMap<K, V>(target: Map<K, V>, snapshot: Map<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}
