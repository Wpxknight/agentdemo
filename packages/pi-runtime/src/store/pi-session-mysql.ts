import { randomUUID } from 'node:crypto';
import {
  Session, SessionError, type SessionEntryCursorOptions, type SessionForkOptions, type SessionMetadata, type SessionRepo,
  type SessionStats, type SessionStorage, type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';
import type { ColumnType, Kysely, Transaction } from 'kysely';

type JsonColumn = ColumnType<unknown, string, string>;
type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;

export interface PiMysqlSessionMetadata extends SessionMetadata {
  tenantId: string;
  metadata?: Record<string, unknown>;
}

export interface PiMysqlSessionDatabase {
  pi_sessions: {
    tenant_id: string; session_id: string; current_leaf_id: string | null; committed_leaf_id: string | null;
    metadata_json: NullableJsonColumn; created_at: Date; updated_at: Date;
  };
  pi_session_entries: {
    tenant_id: string; session_id: string; entry_id: string; entry_seq: number; parent_id: string | null;
    entry_type: string; entry_json: JsonColumn; created_at: Date;
  };
}

type PiDb = Kysely<PiMysqlSessionDatabase> | Transaction<PiMysqlSessionDatabase>;

export class PiMysqlSessionStorage implements SessionStorage<PiMysqlSessionMetadata> {
  private hasWritten = false;

  constructor(
    private readonly db: PiDb,
    private readonly metadata: PiMysqlSessionMetadata,
    private readonly startFromCommitted = false,
  ) {}

  async getMetadata(): Promise<PiMysqlSessionMetadata> { return structuredClone(this.metadata); }

  async getLeafId(): Promise<string | null> {
    const row = await this.sessionRow();
    return this.startFromCommitted && !this.hasWritten ? row.committed_leaf_id : row.current_leaf_id;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId && !await this.getEntry(leafId)) throw new Error('Leaf must reference an entry in the same tenant and session');
    await this.appendEntry({
      type: 'leaf', id: await this.createEntryId(), parentId: await this.getLeafId(),
      timestamp: new Date().toISOString(), targetId: leafId,
    });
  }

  async createEntryId(): Promise<string> { return randomUUID(); }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    if (entry.parentId && !await this.getEntry(entry.parentId)) {
      throw new Error('Parent must reference an entry in the same tenant and session');
    }
    await this.withTransaction(async (db) => {
      await db.selectFrom('pi_sessions').select('session_id')
        .where('tenant_id', '=', this.metadata.tenantId).where('session_id', '=', this.metadata.id)
        .forUpdate().executeTakeFirstOrThrow();
      const last = await db.selectFrom('pi_session_entries')
        .select(({ fn }) => fn.max<number>('entry_seq').as('entry_seq'))
        .where('tenant_id', '=', this.metadata.tenantId).where('session_id', '=', this.metadata.id).executeTakeFirst();
      await db.insertInto('pi_session_entries').values({
        tenant_id: this.metadata.tenantId, session_id: this.metadata.id, entry_id: entry.id,
        entry_seq: Number(last?.entry_seq ?? 0) + 1, parent_id: entry.parentId, entry_type: entry.type,
        entry_json: JSON.stringify(entry), created_at: new Date(entry.timestamp),
      }).execute();
      await db.updateTable('pi_sessions').set({
        current_leaf_id: entry.type === 'leaf' ? entry.targetId : entry.id,
        updated_at: new Date(entry.timestamp),
      }).where('tenant_id', '=', this.metadata.tenantId).where('session_id', '=', this.metadata.id).execute();
    });
    this.hasWritten = true;
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const row = await this.db.selectFrom('pi_session_entries').select('entry_json')
      .where('tenant_id', '=', this.metadata.tenantId).where('session_id', '=', this.metadata.id)
      .where('entry_id', '=', id).executeTakeFirst();
    return row ? parseEntry(row.entry_json) : undefined;
  }

  async findEntries<TType extends SessionTreeEntry['type']>(type: TType): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    const entries = await this.visibleEntries();
    return entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
  }

  async getLabel(id: string): Promise<string | undefined> {
    const labels = await this.findEntries('label');
    return labels.filter((entry) => entry.targetId === id).at(-1)?.label;
  }

  async getSessionName(): Promise<string | undefined> {
    return (await this.findEntries('session_info')).at(-1)?.name;
  }

  async getSessionStats(): Promise<SessionStats> {
    const messages = (await this.visibleEntries()).filter((entry) => entry.type === 'message');
    let cachedTokens = 0;
    let uncachedTokens = 0;
    let costTotal = 0;
    for (const entry of messages) {
      const usage = entry.message.role === 'assistant' ? entry.message.usage : undefined;
      cachedTokens += usage?.cacheRead ?? 0;
      uncachedTokens += (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
      costTotal += usage?.cost?.total ?? 0;
    }
    return { messageCount: messages.length, cachedTokens, uncachedTokens, totalTokens: cachedTokens + uncachedTokens, costTotal };
  }

  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const entries = await this.getEntries();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const path: SessionTreeEntry[] = [];
    let stopAtEntryId: string | null = null;
    let current = byId.get(leafId);
    if (!current) throw new SessionError('not_found', `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
      if (current.type === 'compaction') {
        if (current.retainedTail) break;
        stopAtEntryId = current.firstKeptEntryId ?? null;
      }
      if (!current.parentId) break;
      const parent = byId.get(current.parentId);
      if (!parent) throw new SessionError('invalid_session', `Entry ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  async getEntries(options: SessionEntryCursorOptions = {}): Promise<SessionTreeEntry[]> {
    let query = this.db.selectFrom('pi_session_entries').select(['entry_seq', 'entry_json'])
      .where('tenant_id', '=', this.metadata.tenantId).where('session_id', '=', this.metadata.id)
      .orderBy('entry_seq', 'asc');
    if (options.afterEntrySeq !== undefined) query = query.where('entry_seq', '>', options.afterEntrySeq);
    if (options.limit !== undefined) query = query.limit(options.limit);
    const rows = await query.execute();
    return rows.map((row) => parseEntry(row.entry_json));
  }

  private async visibleEntries(): Promise<SessionTreeEntry[]> { return this.getEntries(); }

  private async sessionRow() {
    return this.db.selectFrom('pi_sessions').selectAll()
      .where('tenant_id', '=', this.metadata.tenantId).where('session_id', '=', this.metadata.id)
      .executeTakeFirstOrThrow();
  }

  private async withTransaction<T>(work: (db: Transaction<PiMysqlSessionDatabase>) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return work(this.db as Transaction<PiMysqlSessionDatabase>);
    return (this.db as Kysely<PiMysqlSessionDatabase>).transaction().execute(work);
  }
}

export class PiMysqlSessionRepo implements SessionRepo<PiMysqlSessionMetadata, { id?: string; tenantId: string; metadata?: Record<string, unknown> }, { tenantId: string }> {
  constructor(private readonly db: PiDb, private readonly openFromCommitted = true) {}

  async create(options: { id?: string; tenantId: string; metadata?: Record<string, unknown> }): Promise<Session<PiMysqlSessionMetadata>> {
    const id = options.id ?? randomUUID();
    const now = new Date();
    await this.db.insertInto('pi_sessions').values({
      tenant_id: options.tenantId, session_id: id, current_leaf_id: null, committed_leaf_id: null,
      metadata_json: options.metadata ? JSON.stringify(options.metadata) : null, created_at: now, updated_at: now,
    }).ignore().execute();
    return new Session(new PiMysqlSessionStorage(
      this.db, { id, tenantId: options.tenantId, createdAt: now.toISOString(), metadata: options.metadata }, false,
    ));
  }

  async open(metadata: PiMysqlSessionMetadata): Promise<Session<PiMysqlSessionMetadata>> {
    return new Session(new PiMysqlSessionStorage(this.db, metadata, this.openFromCommitted));
  }

  async list(options: { tenantId: string }): Promise<PiMysqlSessionMetadata[]> {
    const rows = await this.db.selectFrom('pi_sessions').selectAll().where('tenant_id', '=', options.tenantId)
      .orderBy('created_at', 'asc').execute();
    return rows.map((row) => ({
      id: row.session_id, tenantId: row.tenant_id, createdAt: row.created_at.toISOString(),
      metadata: row.metadata_json === null ? undefined : parseJson(row.metadata_json) as Record<string, unknown>,
    }));
  }

  async delete(metadata: PiMysqlSessionMetadata): Promise<void> {
    await this.db.deleteFrom('pi_session_entries').where('tenant_id', '=', metadata.tenantId)
      .where('session_id', '=', metadata.id).execute();
    await this.db.deleteFrom('pi_sessions').where('tenant_id', '=', metadata.tenantId)
      .where('session_id', '=', metadata.id).execute();
  }

  async fork(source: PiMysqlSessionMetadata, options: SessionForkOptions & { id?: string; tenantId: string; metadata?: Record<string, unknown> }): Promise<Session<PiMysqlSessionMetadata>> {
    if (source.tenantId !== options.tenantId) throw new Error('Cannot fork a Pi session across tenants');
    const sourceStorage = new PiMysqlSessionStorage(this.db, source, this.openFromCommitted);
    const entries = await sourceStorage.getEntries();
    const target = await this.create(options);
    const storage = target.getStorage();
    const selected = selectForkEntries(entries, options.entryId, options.position);
    for (const entry of selected) await storage.appendEntry(structuredClone(entry));
    await storage.setLeafId(selected.at(-1)?.id ?? null);
    return target;
  }
}

function selectForkEntries(entries: SessionTreeEntry[], entryId?: string, position: 'before' | 'at' = 'at'): SessionTreeEntry[] {
  if (!entryId) return entries;
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) throw new Error('Fork entry not found');
  return entries.slice(0, position === 'before' ? index : index + 1);
}

function parseJson(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) : value; }
function parseEntry(value: unknown): SessionTreeEntry { return parseJson(value) as SessionTreeEntry; }
