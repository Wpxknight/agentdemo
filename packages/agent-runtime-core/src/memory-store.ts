import { isDeepStrictEqual } from 'node:util';
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
} from './store.js';

interface MemoryState {
  runs: Map<string, RunRecord>;
  attempts: Map<string, AttemptRecord>;
  snapshots: Map<string, TurnSnapshot>;
  commits: Map<string, TurnCommit>;
  interactions: Map<string, InteractionRecord>;
  ledger: Map<string, ToolLedgerRecord>;
  events: Map<string, AgentRunEvent[]>;
}

function emptyState(): MemoryState {
  return {
    runs: new Map(), attempts: new Map(), snapshots: new Map(), commits: new Map(),
    interactions: new Map(), ledger: new Map(), events: new Map(),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneState(state: MemoryState): MemoryState {
  return clone(state);
}

function runKey(identity: RunIdentity): string {
  return `${identity.tenantId}/${identity.runId}`;
}

function attemptKey(identity: RunIdentity & { attemptId: string }): string {
  return `${runKey(identity)}/${identity.attemptId}`;
}

function turnKey(identity: RunIdentity & { attemptId: string; turnNo: number }): string {
  return `${attemptKey(identity)}/${identity.turnNo}`;
}

function interactionKey(identity: RunIdentity & { interactionId: string }): string {
  return `${runKey(identity)}/${identity.interactionId}`;
}

function ledgerKey(identity: RunIdentity & { logicalCallId: string }): string {
  return `${runKey(identity)}/${identity.logicalCallId}`;
}

export class MemoryRuntimeStore implements RuntimeStore {
  private state: MemoryState;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(state: MemoryState = emptyState(), private readonly transactionalView = false) {
    this.state = state;
  }

  readonly runs = {
    create: async (record: RunRecord): Promise<void> => {
      const key = runKey(record);
      if (this.state.runs.has(key)) throw new Error(`Run already exists: ${key}`);
      this.state.runs.set(key, clone(record));
    },
    get: async (identity: RunIdentity): Promise<RunRecord | undefined> => clone(this.state.runs.get(runKey(identity))),
    update: async (identity: RunIdentity, patch: Partial<RunRecord>): Promise<void> => {
      const key = runKey(identity);
      const current = this.state.runs.get(key);
      if (!current) throw new Error(`Run not found: ${key}`);
      this.state.runs.set(key, clone({ ...current, ...patch, tenantId: identity.tenantId, runId: identity.runId }));
    },
    acquireLease: async (
      identity: RunIdentity, ownerId: string, now: Date, ttlMs: number,
    ): Promise<LeaseRecord | undefined> => {
      const key = runKey(identity);
      const current = this.state.runs.get(key);
      if (!current) return undefined;
      if (current.leaseOwner && current.leaseExpiresAt && current.leaseExpiresAt > now && current.leaseOwner !== ownerId) {
        return undefined;
      }
      const activeSameOwner = current.leaseOwner === ownerId
        && current.leaseExpiresAt !== undefined && current.leaseExpiresAt > now;
      const token = activeSameOwner ? current.leaseToken : current.leaseToken + 1n;
      const expiresAt = new Date(now.getTime() + ttlMs);
      this.state.runs.set(key, { ...current, leaseOwner: ownerId, leaseToken: token, leaseExpiresAt: expiresAt, updatedAt: now });
      return { ownerId, token, expiresAt: clone(expiresAt) };
    },
    renewLease: async (
      identity: RunIdentity, ownerId: string, token: bigint, now: Date, ttlMs: number,
    ): Promise<boolean> => {
      const key = runKey(identity);
      const current = this.state.runs.get(key);
      if (!current || current.leaseOwner !== ownerId || current.leaseToken !== token) return false;
      this.state.runs.set(key, {
        ...current,
        leaseExpiresAt: new Date(now.getTime() + ttlMs),
        updatedAt: now,
      });
      return true;
    },
    assertLease: async (identity: RunIdentity, ownerId: string, token: bigint, now: Date): Promise<void> => {
      const current = this.state.runs.get(runKey(identity));
      if (!current || current.leaseOwner !== ownerId || current.leaseToken !== token
        || !current.leaseExpiresAt || current.leaseExpiresAt <= now) {
        throw new AgentPlatformError({ code: 'LEASE_LOST', message: 'LEASE_LOST: stale fencing token', retryable: false });
      }
    },
  };

  readonly attempts = {
    create: async (record: AttemptRecord): Promise<void> => {
      const key = attemptKey(record);
      if (this.state.attempts.has(key)) throw new Error(`Attempt already exists: ${key}`);
      this.state.attempts.set(key, clone(record));
    },
    update: async (
      identity: RunIdentity & { attemptId: string }, patch: Partial<AttemptRecord>,
    ): Promise<void> => {
      const key = attemptKey(identity);
      const current = this.state.attempts.get(key);
      if (!current) throw new Error(`Attempt not found: ${key}`);
      this.state.attempts.set(key, clone({ ...current, ...patch, ...identity }));
    },
    list: async (identity: RunIdentity): Promise<AttemptRecord[]> => [...this.state.attempts.values()]
      .filter((item) => item.tenantId === identity.tenantId && item.runId === identity.runId)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map(clone),
  };

  readonly turns = {
    createSnapshot: async (snapshot: TurnSnapshot): Promise<void> => {
      const key = turnKey(snapshot);
      if (this.state.snapshots.has(key)) throw new Error(`TurnSnapshot is immutable: ${key}`);
      this.state.snapshots.set(key, clone(snapshot));
    },
    getSnapshot: async (
      identity: RunIdentity & { attemptId: string; turnNo: number },
    ): Promise<TurnSnapshot | undefined> => clone(this.state.snapshots.get(turnKey(identity))),
    getLastCommitted: async (identity: RunIdentity): Promise<TurnCommit | undefined> => {
      const commits = [...this.state.commits.values()]
        .filter((item) => item.tenantId === identity.tenantId && item.runId === identity.runId)
        .sort((a, b) => a.transcriptVersion > b.transcriptVersion ? -1 : a.transcriptVersion < b.transcriptVersion ? 1 : 0);
      return clone(commits[0]);
    },
    listCommitted: async (identity: RunIdentity): Promise<TurnCommit[]> => [...this.state.commits.values()]
      .filter((item) => item.tenantId === identity.tenantId && item.runId === identity.runId)
      .sort((a, b) => a.transcriptVersion < b.transcriptVersion ? -1 : a.transcriptVersion > b.transcriptVersion ? 1 : 0)
      .map(clone),
    commit: async (input: CommitTurnInput): Promise<TurnCommit> => {
      if (!this.transactionalView) return this.transaction((tx) => tx.turns.commit(input));
      await this.runs.assertLease(
        input.snapshot,
        input.leaseOwner,
        input.leaseToken,
        input.commit.committedAt,
      );
      const key = turnKey(input.snapshot);
      const snapshot = this.state.snapshots.get(key);
      if (!snapshot || !isDeepStrictEqual(snapshot, input.snapshot)) {
        throw new AgentPlatformError({ code: 'TURN_COMMIT_FAILED', message: 'TURN_COMMIT_FAILED: snapshot mismatch', retryable: true });
      }
      const existing = this.state.commits.get(key);
      if (existing) {
        if (existing.commitId === input.commit.commitId) return clone(existing);
        throw new AgentPlatformError({ code: 'TURN_COMMIT_FAILED', message: 'TURN_COMMIT_FAILED: conflicting commit', retryable: false });
      }
      for (const event of input.events) await this.events.append(event);
      for (const record of input.interactionUpdates ?? []) await this.interactions.put(record);
      for (const record of input.ledgerUpdates ?? []) {
        const stored = await this.toolLedger.get({ ...record, logicalCallId: record.logicalCallId });
        if (stored) await this.toolLedger.update(record);
        else await this.toolLedger.putIfAbsent(record);
      }
      const eventSequenceEnd = this.lastEventSequence(input.snapshot);
      const commit: TurnCommit = clone({ ...input.commit, eventSequenceEnd });
      this.state.commits.set(key, commit);
      await this.runs.update(input.snapshot, {
        status: input.runStatus,
        waitingReason: input.waitingReason,
        usage: input.commit.usage,
        updatedAt: input.commit.committedAt,
      });
      return clone(commit);
    },
  };

  readonly interactions = {
    put: async (record: InteractionRecord): Promise<void> => {
      this.state.interactions.set(interactionKey({ ...record, interactionId: record.id }), clone(record));
    },
    get: async (
      identity: RunIdentity & { interactionId: string },
    ): Promise<InteractionRecord | undefined> => clone(this.state.interactions.get(interactionKey(identity))),
    getById: async (tenantId: string, interactionId: string): Promise<InteractionRecord | undefined> => {
      const record = [...this.state.interactions.values()]
        .find((item) => item.tenantId === tenantId && item.id === interactionId);
      return clone(record);
    },
    list: async (identity: RunIdentity): Promise<InteractionRecord[]> => [...this.state.interactions.values()]
      .filter((record) => record.tenantId === identity.tenantId && record.runId === identity.runId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map(clone),
    listByTenant: async (tenantId: string): Promise<InteractionRecord[]> => [...this.state.interactions.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map(clone),
  };

  readonly toolLedger = {
    putIfAbsent: async (record: ToolLedgerRecord): Promise<boolean> => {
      const key = ledgerKey(record);
      if (this.state.ledger.has(key)) return false;
      this.state.ledger.set(key, clone(record));
      return true;
    },
    get: async (
      identity: RunIdentity & { logicalCallId: string },
    ): Promise<ToolLedgerRecord | undefined> => clone(this.state.ledger.get(ledgerKey(identity))),
    update: async (record: ToolLedgerRecord): Promise<void> => {
      const key = ledgerKey(record);
      if (!this.state.ledger.has(key)) throw new Error(`Tool ledger record not found: ${key}`);
      this.state.ledger.set(key, clone(record));
    },
  };

  readonly events = {
    append: async (event: Omit<AgentRunEvent, 'sequence'>): Promise<AgentRunEvent> => {
      const key = runKey(event);
      const events = this.state.events.get(key) ?? [];
      const stored: AgentRunEvent = clone({ ...event, sequence: BigInt(events.length + 1) });
      events.push(stored);
      this.state.events.set(key, events);
      return clone(stored);
    },
    list: async (identity: RunIdentity, after = 0n): Promise<AgentRunEvent[]> =>
      (this.state.events.get(runKey(identity)) ?? []).filter((event) => event.sequence > after).map(clone),
  };

  async transaction<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T> {
    if (this.transactionalView) return work(this);
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const isolated = new MemoryRuntimeStore(cloneState(this.state), true);
      const result = await work(isolated);
      this.state = isolated.state;
      return result;
    } finally {
      release();
    }
  }

  private lastEventSequence(identity: RunIdentity): bigint {
    return this.state.events.get(runKey(identity))?.at(-1)?.sequence ?? 0n;
  }
}
