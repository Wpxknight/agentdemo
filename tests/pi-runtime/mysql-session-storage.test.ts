import { describe, expect, it } from 'vitest';
import { InMemorySessionRepo, InMemorySessionStorage, Session, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
import { EventCodec, PiAgentSession, PiMysqlSessionRepo, PiMysqlSessionStorage } from '../../packages/pi-runtime/src/index.js';
import { drainDurableInbox, MysqlRunStore } from '../../packages/pi-runtime/src/index.js';
import { readMysqlConfig } from '../../src/config/mysql.js';
import { createKysely, createMysqlPool, runMigrations } from '../../src/db/index.js';

describe('PiMysqlSessionStorage behavior', () => {
  it('advances current leaf on append and records moveTo as an append-only leaf entry', async () => {
    const db = new SessionTestDb('tenant-a', 'session-a');
    const storage = new PiMysqlSessionStorage(db as never, metadata(), false);
    const root = messageEntry('root', null, 'root');
    const child = messageEntry('child', 'root', 'child');

    await storage.appendEntry(root);
    expect(await storage.getLeafId()).toBe('root');
    await storage.appendEntry(child);
    expect(await storage.getLeafId()).toBe('child');

    await storage.setLeafId('root');
    expect(await storage.getLeafId()).toBe('root');
    expect(await storage.getEntries()).toEqual([
      root,
      child,
      expect.objectContaining({ type: 'leaf', parentId: 'child', targetId: 'root' }),
    ]);
  });

  it('builds recovery context from committed leaf while retaining all entries for inbox reconciliation', async () => {
    const db = new SessionTestDb('tenant-a', 'session-a');
    const writer = new PiMysqlSessionStorage(db as never, metadata(), false);
    await writer.appendEntry(messageEntry('committed', null, 'committed'));
    db.sessions[0]!.committed_leaf_id = 'committed';
    await writer.appendEntry(messageEntry('uncommitted', 'committed', 'must stay hidden'));
    await writer.appendEntry({
      type: 'custom', customType: 'aiop.inbox_consumed', data: { inboxMessageId: 'inbox-a' },
      id: 'marker', parentId: 'uncommitted', timestamp: new Date().toISOString(),
    });

    const recovery = await new PiMysqlSessionRepo(db as never).open(metadata());
    const recoveryStorage = recovery.getStorage();
    expect((await recovery.buildContext()).messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'committed' }),
    ]);
    expect(await recoveryStorage.getEntries()).toEqual([
      expect.objectContaining({ id: 'committed' }),
      expect.objectContaining({ id: 'uncommitted' }),
      expect.objectContaining({ id: 'marker', customType: 'aiop.inbox_consumed' }),
    ]);
  });

  it('keeps the ordinary compaction tail through firstKeptEntryId', async () => {
    const db = new SessionTestDb('tenant-a', 'session-a');
    const storage = new PiMysqlSessionStorage(db as never, metadata(), false);
    await storage.appendEntry(messageEntry('old', null, 'old'));
    await storage.appendEntry(messageEntry('kept', 'old', 'kept'));
    await storage.appendEntry({
      type: 'compaction', id: 'compaction', parentId: 'kept', timestamp: new Date().toISOString(),
      summary: 'summary', firstKeptEntryId: 'kept', tokensBefore: 100,
    });

    expect((await storage.getPathToRootOrCompaction('compaction')).map((entry) => entry.id))
      .toEqual(['kept', 'compaction']);
  });

  it('matches Pi 0.82.1 stats, label, and session-name behavior', async () => {
    const db = new SessionTestDb('tenant-a', 'session-a');
    const mysql = new PiMysqlSessionStorage(db as never, metadata(), false);
    const memory = new InMemorySessionStorage({ metadata: metadata() });
    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({
      input, output, cacheRead, cacheWrite, totalTokens: total,
      cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1, total: total / 100 },
    });
    const entries: SessionTreeEntry[] = [
      messageEntry('user', null, 'question'),
      {
        type: 'message', id: 'assistant', parentId: 'user', timestamp: new Date().toISOString(),
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'answer' }], api: 'test', provider: 'test', model: 'test',
          stopReason: 'stop', timestamp: Date.now(), usage: usage(10, 5, 2, 3, 20),
        },
      },
      {
        type: 'compaction', id: 'compact', parentId: 'assistant', timestamp: new Date().toISOString(),
        summary: 'summary', tokensBefore: 100, usage: usage(7, 4, 1, 2, 14),
      },
      {
        type: 'branch_summary', id: 'branch', parentId: 'compact', timestamp: new Date().toISOString(),
        fromId: 'user', summary: 'branch summary', usage: usage(6, 3, 4, 1, 14),
      },
      { type: 'label', id: 'label-set', parentId: 'branch', timestamp: new Date().toISOString(), targetId: 'assistant', label: '  useful  ' },
      { type: 'session_info', id: 'name-set', parentId: 'label-set', timestamp: new Date().toISOString(), name: '  Session name  ' },
    ];
    for (const entry of entries) {
      await memory.appendEntry(entry);
      await mysql.appendEntry(entry);
    }

    expect(await mysql.getSessionStats()).toEqual(await memory.getSessionStats());
    expect(await mysql.getLabel('assistant')).toBe(await memory.getLabel('assistant'));
    expect(await mysql.getSessionName()).toBe(await memory.getSessionName());

    const blankLabel: SessionTreeEntry = {
      type: 'label', id: 'label-clear', parentId: 'name-set', timestamp: new Date().toISOString(), targetId: 'assistant', label: '   ',
    };
    const blankName: SessionTreeEntry = {
      type: 'session_info', id: 'name-clear', parentId: 'label-clear', timestamp: new Date().toISOString(), name: '   ',
    };
    for (const entry of [blankLabel, blankName]) {
      await memory.appendEntry(entry);
      await mysql.appendEntry(entry);
    }
    expect(await mysql.getLabel('assistant')).toBe(await memory.getLabel('assistant'));
    expect(await mysql.getSessionName()).toBe(await memory.getSessionName());
  });

  it('matches Pi 0.82.1 fork ancestry, default position, validation, and entry shape', async () => {
    const db = new SessionTestDb('tenant-a', 'source');
    const mysqlRepo = new PiMysqlSessionRepo(db as never, false);
    const mysqlSource = await mysqlRepo.open({ id: 'source', tenantId: 'tenant-a', createdAt: new Date().toISOString() });
    const memoryRepo = new InMemorySessionRepo();
    const memorySource = await memoryRepo.create({ id: 'source' });
    const entries: SessionTreeEntry[] = [
      messageEntry('root', null, 'root'),
      assistantEntry('assistant-a', 'root', 'answer'),
      { type: 'custom', customType: 'side', data: {}, id: 'unrelated', parentId: 'root', timestamp: new Date().toISOString() },
      messageEntry('user-b', 'assistant-a', 'branch question'),
      assistantEntry('assistant-b', 'user-b', 'branch answer'),
    ];
    for (const entry of entries) {
      await mysqlSource.getStorage().appendEntry(entry);
      await memorySource.getStorage().appendEntry(entry);
    }

    const mysqlFork = await mysqlRepo.fork(await mysqlSource.getMetadata(), {
      id: 'mysql-fork', tenantId: 'tenant-a', entryId: 'user-b',
    });
    const memoryFork = await memoryRepo.fork(await memorySource.getMetadata(), { id: 'memory-fork', entryId: 'user-b' });
    expect(await mysqlFork.getEntries()).toEqual(await memoryFork.getEntries());
    expect((await mysqlFork.getEntries()).map((entry) => entry.id)).toEqual(['root', 'assistant-a']);
    expect((await mysqlFork.getEntries()).some((entry) => entry.type === 'leaf')).toBe(false);

    const mysqlAt = await mysqlRepo.fork(await mysqlSource.getMetadata(), {
      id: 'mysql-at', tenantId: 'tenant-a', entryId: 'assistant-b', position: 'at',
    });
    const memoryAt = await memoryRepo.fork(await memorySource.getMetadata(), {
      id: 'memory-at', entryId: 'assistant-b', position: 'at',
    });
    expect(await mysqlAt.getEntries()).toEqual(await memoryAt.getEntries());
    expect((await mysqlAt.getEntries()).map((entry) => entry.id)).toEqual(['root', 'assistant-a', 'user-b', 'assistant-b']);

    await expect(mysqlRepo.fork(await mysqlSource.getMetadata(), {
      id: 'invalid-missing', tenantId: 'tenant-a', entryId: 'missing',
    })).rejects.toMatchObject({ code: 'invalid_fork_target' });
    await expect(mysqlRepo.fork(await mysqlSource.getMetadata(), {
      id: 'invalid-before', tenantId: 'tenant-a', entryId: 'assistant-a', position: 'before',
    })).rejects.toMatchObject({ code: 'invalid_fork_target' });
  });
});

describe.runIf(Boolean(process.env.MYSQL_HOST))('Pi MySQL crash recovery integration', () => {
  it('acks a persisted consumed marker without redelivery or exposing its uncommitted branch', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const suffix = `${Date.now()}`;
    const tenantId = 'pi-marker-contract';
    const runId = `run-${suffix}`;
    const sessionId = `session-${suffix}`;
    const identity = { tenantId, actorId: 'user-a', roles: ['user'] } as const;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const start = new Date();
    const store = new MysqlRunStore(db);
    try {
      await store.create({ record: {
        tenantId, runId, actorId: identity.actorId, sessionId, kernel: 'pi', kernelVersion: '0.82.1',
        status: 'queued', leaseToken: 0n, usage, createdAt: start, updatedAt: start,
      } });
      await store.sessions.create({ tenantId, sessionId, createdAt: start });
      const storage = new PiMysqlSessionStorage(db as never, { id: sessionId, tenantId, createdAt: start.toISOString() });
      await storage.appendEntry(messageEntry('root', null, 'committed context'));
      const first = await store.claim({ identity, runId, workerId: 'worker-a', now: start, leaseTtlMs: 1000 });
      await store.commitTurn({
        tenantId, runId, attemptId: first!.attemptId, turnNo: 1, fencingToken: first!.fencingToken,
        checkpoint: { piSessionId: sessionId, piLeafId: 'root' }, events: [], status: 'running', usage, committedAt: start,
      });
      await storage.appendEntry(messageEntry('uncommitted', 'root', 'hidden branch'));
      const inbox = await store.inbox.enqueue({
        identity,
        tenantId, runId, idempotencyKey: 'marker-before-ack', mode: 'steer',
        message: { role: 'user', text: 'only once' }, createdAt: start,
      });
      await storage.appendEntry({
        type: 'custom', customType: 'aiop.inbox_consumed', data: { inboxMessageId: inbox.id }, id: 'marker',
        parentId: 'uncommitted', timestamp: new Date().toISOString(),
      });
      await store.inbox.claimNext({
        tenantId, runId, workerId: 'worker-a', fencingToken: first!.fencingToken, now: start, claimTtlMs: 10,
      });
      const recoveredAt = new Date(start.getTime() + 1001);
      const second = await store.claim({ identity, runId, workerId: 'worker-b', now: recoveredAt, leaseTtlMs: 1000 });
      const recoveryStorage = new PiMysqlSessionStorage(
        db as never, { id: sessionId, tenantId, createdAt: start.toISOString() }, true,
      );
      const recoverySession = new Session(recoveryStorage);
      expect((await recoverySession.buildContext()).messages).toEqual([
        expect.objectContaining({ content: 'committed context' }),
      ]);
      let deliveries = 0;
      await drainDurableInbox({
        store, tenantId, runId, workerId: 'worker-b', fencingToken: second!.fencingToken,
        now: () => recoveredAt, claimTtlMs: 10, entries: await recoveryStorage.getEntries(),
        session: {
          async steer() { deliveries += 1; }, async followUp() { deliveries += 1; },
          async appendCustomEntry() { return 'unexpected'; },
        },
      });
      expect(deliveries).toBe(0);
      expect((await store.inbox.list(tenantId, runId))[0]?.status).toBe('consumed');
    } finally {
      for (const table of ['agent_run_inbox_messages', 'agent_run_events', 'agent_turn_commits', 'agent_run_attempts'] as const) {
        await db.deleteFrom(table).where('tenant_id', '=', tenantId).where('run_id', '=', runId).execute();
      }
      await db.deleteFrom('agent_runs').where('tenant_id', '=', tenantId).where('run_id', '=', runId).execute();
      await db.deleteFrom('pi_session_entries').where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).execute();
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).execute();
      await db.destroy();
    }
  });

  it('keeps an overlapping assistant write and inbox marker on one MySQL branch', async () => {
    const pool = createMysqlPool(readMysqlConfig()!);
    await runMigrations(pool);
    const db = createKysely(pool);
    const tenantId = 'pi-write-race';
    const sessionId = `session-${Date.now()}`;
    try {
      const created = await new PiMysqlSessionRepo(db as never).create({ id: sessionId, tenantId });
      const base = created.getStorage();
      await base.appendEntry(messageEntry('root', null, 'start'));
      let assistantPaused!: () => void;
      const paused = new Promise<void>((resolve) => { assistantPaused = resolve; });
      let releaseAssistant!: () => void;
      const gate = new Promise<void>((resolve) => { releaseAssistant = resolve; });
      const storage = new Proxy(base, {
        get(target, property) {
          if (property === 'appendEntry') return async (entry: SessionTreeEntry) => {
            if (entry.type === 'message' && entry.message.role === 'assistant') {
              assistantPaused();
              await gate;
            }
            return base.appendEntry(entry);
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const session = new Session(storage);
      const handlers = new Map<string, Array<(event: never) => Promise<void> | void>>();
      let sequence = 0n;
      const harness = {
        subscribe: () => () => {}, getTools: () => [], async abort() {}, async waitForIdle() {},
        on(type: string, handler: (event: never) => Promise<void> | void) {
          const current = handlers.get(type) ?? [];
          current.push(handler);
          handlers.set(type, current);
          return () => handlers.set(type, (handlers.get(type) ?? []).filter((candidate) => candidate !== handler));
        },
        async prompt() {
          await session.appendMessage({
            role: 'assistant', content: [{ type: 'text', text: 'answer' }], api: 'test', provider: 'test', model: 'test',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop', timestamp: Date.now(),
          });
          for (const handler of handlers.get('save_point') ?? []) await handler({ type: 'save_point' } as never);
          for (const handler of handlers.get('settled') ?? []) await handler({ type: 'settled' } as never);
        },
      };
      const agent = new PiAgentSession(session, harness as never, { role: 'user', text: 'start' }, new EventCodec({
        tenantId, runId: 'run-race', attemptId: 'attempt-race', turnNo: 1, correlationId: 'race',
        sequence: () => ++sequence,
      }));
      const running = collectEvents(agent.continue());
      await paused;
      const marker = agent.appendCustomEntry('aiop.inbox_consumed', { inboxMessageId: 'inbox-race' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseAssistant();
      const markerId = await marker;
      await running;
      const leaf = await agent.leafId();
      expect(leaf).toBe(markerId);
      expect((await base.getPathToRootOrCompaction(leaf)).map((entry) => entry.id))
        .toEqual(['root', expect.any(String), markerId]);
      await agent.close();
    } finally {
      await db.deleteFrom('pi_session_entries').where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).execute();
      await db.deleteFrom('pi_sessions').where('tenant_id', '=', tenantId).where('session_id', '=', sessionId).execute();
      await db.destroy();
    }
  });
});

function metadata() {
  return { id: 'session-a', tenantId: 'tenant-a', createdAt: new Date().toISOString() };
}

function messageEntry(id: string, parentId: string | null, content: string): SessionTreeEntry {
  return { type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role: 'user', content, timestamp: Date.now() } };
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionTreeEntry {
  return {
    type: 'message', id, parentId, timestamp: new Date().toISOString(), message: {
      role: 'assistant', content: [{ type: 'text', text }], api: 'test', provider: 'test', model: 'test',
      stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  };
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

type Row = Record<string, any>;

class SessionTestDb {
  readonly isTransaction = true;
  readonly sessions: Row[];
  readonly entries: Row[] = [];

  constructor(tenantId: string, sessionId: string) {
    this.sessions = [{
      tenant_id: tenantId, session_id: sessionId, current_leaf_id: null, committed_leaf_id: null,
      metadata_json: null, created_at: new Date(), updated_at: new Date(),
    }];
  }

  selectFrom(table: string) { return new SelectQuery(this, table); }
  insertInto(table: string) { return new InsertQuery(this, table); }
  updateTable(table: string) { return new UpdateQuery(this, table); }
  rows(table: string): Row[] { return table === 'pi_sessions' ? this.sessions : this.entries; }
}

class QueryBase {
  protected filters: Array<(row: Row) => boolean> = [];
  constructor(protected readonly db: SessionTestDb, protected readonly table: string) {}
  where(column: string, operator: string, value: unknown) {
    this.filters.push((row) => operator === '=' ? row[column] === value : operator === '>' ? row[column] > Number(value) : false);
    return this;
  }
  protected matched(): Row[] { return this.db.rows(this.table).filter((row) => this.filters.every((filter) => filter(row))); }
}

class SelectQuery extends QueryBase {
  private columns?: string[];
  private aggregate = false;
  private limitCount?: number;
  select(selection: string | string[] | ((helpers: any) => unknown)) {
    if (typeof selection === 'function') this.aggregate = true;
    else this.columns = Array.isArray(selection) ? selection : [selection];
    return this;
  }
  selectAll() { return this; }
  orderBy(column: string, direction: 'asc' | 'desc') {
    const sign = direction === 'asc' ? 1 : -1;
    this.db.rows(this.table).sort((a, b) => (a[column] - b[column]) * sign);
    return this;
  }
  limit(count: number) { this.limitCount = count; return this; }
  forUpdate() { return this; }
  async execute(): Promise<Row[]> {
    let rows = this.matched();
    if (this.aggregate) return [{ entry_seq: Math.max(0, ...rows.map((row) => Number(row.entry_seq ?? 0))) }];
    if (this.limitCount !== undefined) rows = rows.slice(0, this.limitCount);
    if (!this.columns) return rows.map((row) => ({ ...row }));
    return rows.map((row) => Object.fromEntries(this.columns!.map((column) => [column, row[column]])));
  }
  async executeTakeFirst() { return (await this.execute())[0]; }
  async executeTakeFirstOrThrow() { const row = await this.executeTakeFirst(); if (!row) throw new Error('not found'); return row; }
}

class InsertQuery {
  private value!: Row;
  constructor(private readonly db: SessionTestDb, private readonly table: string) {}
  values(value: Row) { this.value = value; return this; }
  ignore() { return this; }
  async execute() { this.db.rows(this.table).push({ ...this.value }); return []; }
}

class UpdateQuery extends QueryBase {
  private patch: Row = {};
  set(patch: Row) { this.patch = patch; return this; }
  async execute() { for (const row of this.matched()) Object.assign(row, this.patch); return []; }
}
