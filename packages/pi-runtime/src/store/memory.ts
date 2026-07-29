import { randomUUID } from 'node:crypto';
import { AgentPlatformError, LeaseLostError, RunNotFoundError, type AgentRunEvent } from '@aiop/control-contracts';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type {
  ClaimInboxInput, ConsumeInboxInput, DurableRunStore, EnqueueInboxInput, PiSessionRecord, RunInboxMessage,
  SessionEntryRecord, StoredRun,
} from './types.js';
import { assertAttemptAllowed, assertTurnAllowed } from '../run/limits.js';
import { sessionStats } from './session-stats.js';

const clone = <T>(value: T): T => structuredClone(value);
const key = (tenantId: string, id: string): string => `${tenantId}\0${id}`;

export class MemoryRunStore implements DurableRunStore {
  private readonly runs = new Map<string, StoredRun>();
  private readonly attempts = new Map<string, { tenantId: string; runId: string; attemptId: string; status: string }>();
  private readonly events = new Map<string, AgentRunEvent[]>();
  private readonly sessionRecords = new Map<string, PiSessionRecord>();
  private readonly sessionEntries = new Map<string, SessionEntryRecord[]>();
  private readonly inboxMessages = new Map<string, RunInboxMessage[]>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: Parameters<DurableRunStore['create']>[0]): Promise<StoredRun & { sessionCreated: boolean }> {
    return this.lock(async () => {
      const record: StoredRun = { ...clone(input.record), lastTurnNo: 0 };
      const runKey = key(record.tenantId, record.runId);
      if (this.runs.has(runKey)) throw conflict('Run already exists');
      const active = [...this.runs.values()].some((run) => run.tenantId === record.tenantId
        && run.sessionId === record.sessionId && ['queued', 'running', 'waiting'].includes(run.status));
      if (active) throw conflict('Session already has an active run');
      const sessionKey = key(record.tenantId, record.sessionId);
      const sessionCreated = !this.sessionRecords.has(sessionKey);
      if (sessionCreated) this.sessionRecords.set(sessionKey, {
        tenantId: record.tenantId, sessionId: record.sessionId, createdAt: record.createdAt, updatedAt: record.createdAt,
        currentLeafId: null, committedLeafId: null,
      });
      this.runs.set(runKey, record);
      return clone({ ...record, sessionCreated });
    });
  }

  async get(identity: { tenantId: string; runId: string }): Promise<StoredRun | undefined> {
    return clone(this.runs.get(key(identity.tenantId, identity.runId)));
  }

  async claim(input: Parameters<DurableRunStore['claim']>[0]): Promise<Awaited<ReturnType<DurableRunStore['claim']>>> {
    return this.lock(async () => {
      const runKey = key(input.identity.tenantId, input.runId);
      const run = this.runs.get(runKey);
      if (!run) throw new RunNotFoundError();
      if (!canManageRun(input.identity, run.actorId)) return null;
      if (['succeeded', 'cancelled'].includes(run.status)) return null;
      if (['waiting', 'failed', 'recovery_required'].includes(run.status) && !input.resume) return null;
      if (input.resume && [...this.runs.values()].some((candidate) => candidate.tenantId === run.tenantId
        && candidate.sessionId === run.sessionId && candidate.runId !== run.runId
        && ['queued', 'running', 'waiting'].includes(candidate.status))) {
        throw conflict('Session already has an active run');
      }
      assertAttemptAllowed(run.limits, [...this.attempts.values()].filter((attempt) =>
        attempt.tenantId === run.tenantId && attempt.runId === run.runId).length, input.now);
      assertTurnAllowed(run.limits, run.lastTurnNo + 1);
      if (run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt > input.now && run.leaseOwner !== input.workerId) return null;
      const sameLease = run.leaseOwner === input.workerId && Boolean(run.leaseExpiresAt && run.leaseExpiresAt > input.now);
      const fencingToken = sameLease ? run.leaseToken : run.leaseToken + 1n;
      const attemptId = randomUUID();
      Object.assign(run, {
        leaseOwner: input.workerId, leaseToken: fencingToken,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseTtlMs), status: 'running', updatedAt: input.now,
        ...(input.resume && ['waiting', 'failed', 'recovery_required'].includes(run.status) ? { appendClosedAt: undefined } : {}),
      });
      this.attempts.set(key(runKey, attemptId), { tenantId: run.tenantId, runId: run.runId, attemptId, status: 'running' });
      return { record: clone(run), attemptId, fencingToken };
    });
  }

  async renewLease(input: Parameters<DurableRunStore['renewLease']>[0]): Promise<void> {
    const run = this.requireLease(input, input.now);
    run.leaseExpiresAt = new Date(input.now.getTime() + input.leaseTtlMs);
    run.updatedAt = input.now;
  }

  async commitTurn(input: Parameters<DurableRunStore['commitTurn']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.requireLease(input, input.committedAt);
      if (input.turnNo <= run.lastTurnNo) {
        if (input.turnNo === run.lastTurnNo && JSON.stringify(run.checkpoint) === JSON.stringify(input.checkpoint)) return;
        throw conflict('Turn commit is not monotonic');
      }
      if (run.cancelRequestedAt) throw conflict('Cancellation won the commit race');
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
      const storedEvents = this.events.get(key(input.tenantId, input.runId)) ?? [];
      for (const event of input.events) storedEvents.push(clone({ ...event, sequence: BigInt(storedEvents.length + 1) }));
      this.events.set(key(input.tenantId, input.runId), storedEvents);
      run.lastTurnNo = input.turnNo;
      run.checkpoint = clone(input.checkpoint);
      run.status = input.status;
      run.usage = clone(input.usage);
      run.updatedAt = input.committedAt;
    });
  }

  async requestCancellation(input: Parameters<DurableRunStore['requestCancellation']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.runs.get(key(input.identity.tenantId, input.runId));
      if (!run || !canManageRun(input.identity, run.actorId)) throw new RunNotFoundError();
      run.cancelRequestedAt ??= input.requestedAt;
      run.cancelReason ??= input.reason;
      run.updatedAt = input.requestedAt;
    });
  }

  async complete(input: Parameters<DurableRunStore['complete']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.requireLease(input, input.completedAt);
      const status = run.cancelRequestedAt ? 'cancelled' : input.status;
      run.status = status;
      run.usage = clone(input.usage);
      run.result = { runId: input.runId, status, usage: clone(input.usage), error: input.error };
      run.appendClosedAt ??= input.completedAt;
      run.leaseOwner = undefined;
      run.leaseExpiresAt = undefined;
      run.updatedAt = input.completedAt;
      const attempt = this.attempts.get(key(key(input.tenantId, input.runId), input.attemptId));
      if (attempt) attempt.status = status;
    });
  }

  async listEvents(identity: { tenantId: string; runId: string }, after = 0n): Promise<AgentRunEvent[]> {
    return clone((this.events.get(key(identity.tenantId, identity.runId)) ?? []).filter((event) => event.sequence > after));
  }

  async appendEvents(input: Parameters<DurableRunStore['appendEvents']>[0]): Promise<void> {
    await this.lock(async () => {
      this.requireLease(input, input.appendedAt);
      const storedEvents = this.events.get(key(input.tenantId, input.runId)) ?? [];
      for (const event of input.events) storedEvents.push(clone({ ...event, sequence: BigInt(storedEvents.length + 1) }));
      this.events.set(key(input.tenantId, input.runId), storedEvents);
    });
  }

  async isCancellationRequested(identity: { tenantId: string; runId: string }): Promise<boolean> {
    return Boolean(this.runs.get(key(identity.tenantId, identity.runId))?.cancelRequestedAt);
  }

  async countAttempts(identity: { tenantId: string; runId: string }): Promise<number> {
    return [...this.attempts.values()].filter((attempt) => attempt.tenantId === identity.tenantId && attempt.runId === identity.runId).length;
  }

  async closeInbox(input: Parameters<DurableRunStore['closeInbox']>[0]): Promise<void> {
    await this.lock(async () => {
      const run = this.requireLease(input, input.now);
      run.appendClosedAt ??= input.now;
      run.updatedAt = input.now;
    });
  }

  readonly sessions = {
    create: async (input: { tenantId: string; sessionId: string; createdAt: Date; metadata?: Record<string, unknown> }): Promise<PiSessionRecord> => {
      const sessionKey = key(input.tenantId, input.sessionId);
      const existing = this.sessionRecords.get(sessionKey);
      if (existing) return clone(existing);
      const record: PiSessionRecord = {
        ...clone(input), updatedAt: input.createdAt, currentLeafId: null, committedLeafId: null,
      };
      this.sessionRecords.set(sessionKey, record);
      return clone(record);
    },
    get: async (tenantId: string, sessionId: string): Promise<PiSessionRecord | undefined> =>
      clone(this.sessionRecords.get(key(tenantId, sessionId))),
    appendEntry: async (tenantId: string, sessionId: string, entry: SessionTreeEntry): Promise<SessionEntryRecord> => {
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
    },
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
    setCurrentLeaf: async (tenantId: string, sessionId: string, leafId: string | null): Promise<void> => {
      const session = this.sessionRecords.get(key(tenantId, sessionId));
      if (!session) throw new Error('Pi session not found');
      if (leafId && !this.hasSessionEntry(tenantId, sessionId, leafId)) throw conflict('Pi leaf is outside session');
      session.currentLeafId = leafId;
      session.updatedAt = this.now();
    },
  };

  readonly inbox = {
    enqueue: async (input: EnqueueInboxInput): Promise<RunInboxMessage> => this.lock(async () => {
      const run = this.runs.get(key(input.tenantId, input.runId));
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
      const run = this.runs.get(key(input.tenantId, input.runId));
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
    const run = this.runs.get(key(input.tenantId, input.runId));
    const ownerMismatch = input.workerId !== undefined && run?.leaseOwner !== input.workerId;
    if (!run || ownerMismatch || run.leaseToken !== input.fencingToken || (checkExpiry && (!run.leaseExpiresAt || run.leaseExpiresAt <= now))) {
      throw new LeaseLostError();
    }
    return run;
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
    let release!: () => void;
    const prior = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
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
