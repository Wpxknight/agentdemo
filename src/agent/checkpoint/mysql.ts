import {
  BaseCheckpointSaver,
  maxChannelVersion,
  TASKS,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type ChannelVersions,
} from '@langchain/langgraph-checkpoint';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Kysely, Selectable } from 'kysely';
import type { Database, LangGraphCheckpointsTable } from '../../db/schema.js';
import type {
  CheckpointPersistence,
  CheckpointQuery,
  StoredCheckpoint,
  StoredCheckpointWrite,
} from './schema.js';

interface CheckpointIdentity {
  threadId: string;
  checkpointNs: string;
  checkpointId?: string;
  tenantId: string;
  runId: string;
  graphName: string;
  graphVersion: string;
}

export class MysqlCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly persistence: CheckpointPersistence) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const identity = checkpointIdentity(config, false);
    if (!identity) return undefined;
    const record = await this.persistence.getCheckpoint({
      threadId: identity.threadId,
      checkpointNs: identity.checkpointNs,
      checkpointId: identity.checkpointId,
    });
    if (!record) return undefined;
    return this.toTuple(record);
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const configurable = config.configurable ?? {};
    const records = await this.persistence.listCheckpoints({
      threadId: typeof configurable.thread_id === 'string' ? configurable.thread_id : undefined,
      checkpointNs: typeof configurable.checkpoint_ns === 'string' ? configurable.checkpoint_ns : undefined,
      checkpointId: typeof configurable.checkpoint_id === 'string' ? configurable.checkpoint_id : undefined,
      beforeCheckpointId: typeof options.before?.configurable?.checkpoint_id === 'string'
        ? options.before.configurable.checkpoint_id
        : undefined,
      limit: options.filter ? undefined : options.limit,
    });
    let yielded = 0;
    for (const record of records) {
      const tuple = await this.toTuple(record);
      const metadata = tuple.metadata as Record<string, unknown> | undefined;
      if (options.filter && !Object.entries(options.filter).every(([key, value]) => metadata?.[key] === value)) {
        continue;
      }
      if (options.limit !== undefined && yielded >= Math.max(0, options.limit)) break;
      yield tuple;
      yielded += 1;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const identity = checkpointIdentity(config, true)!;
    const preparedCheckpoint: Checkpoint = {
      ...checkpoint,
      channel_values: Object.fromEntries(
        Object.keys(_newVersions)
          .filter((channel) => Object.prototype.hasOwnProperty.call(checkpoint.channel_values, channel))
          .map((channel) => [channel, checkpoint.channel_values[channel]]),
      ),
    };
    const [[checkpointType, checkpointData], [metadataType, metadataData]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    await this.persistence.putCheckpoint({
      tenantId: identity.tenantId,
      threadId: identity.threadId,
      checkpointNs: identity.checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: identity.checkpointId,
      checkpointType,
      checkpointData,
      metadataType,
      metadataData,
      runId: identity.runId,
      graphName: identity.graphName,
      graphVersion: identity.graphVersion,
      expiresAt: configurableDate(config.configurable?.checkpoint_expires_at),
      createdAt: new Date(),
    });
    return {
      configurable: {
        thread_id: identity.threadId,
        checkpoint_ns: identity.checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const identity = checkpointIdentity(config, true)!;
    if (!identity.checkpointId) throw new Error('checkpoint_id is required for checkpoint writes');
    await Promise.all(writes.map(async ([channel, value], index) => {
      const [valueType, valueData] = await this.serde.dumpsTyped(value);
      await this.persistence.putWrite({
        tenantId: identity.tenantId,
        threadId: identity.threadId,
        checkpointNs: identity.checkpointNs,
        checkpointId: identity.checkpointId!,
        taskId,
        index: WRITES_IDX_MAP[channel] ?? index,
        channel,
        valueType,
        valueData,
      });
    }));
  }

  deleteThread(threadId: string): Promise<void> {
    if (!threadId) throw new Error('thread_id is required');
    return this.persistence.deleteThread(threadId);
  }

  private async toTuple(record: StoredCheckpoint): Promise<CheckpointTuple> {
    const checkpoint = await this.serde.loadsTyped(record.checkpointType, record.checkpointData) as Checkpoint;
    const metadata = await this.serde.loadsTyped(record.metadataType, record.metadataData) as CheckpointMetadata;
    const writes = await this.persistence.listWrites(record.threadId, record.checkpointNs, record.checkpointId);
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(writes.map(async (write) => [
      write.taskId,
      write.channel,
      await this.serde.loadsTyped(write.valueType, write.valueData),
    ]));
    if (checkpoint.v < 4 && record.parentCheckpointId) {
      const parentWrites = await this.persistence.listWrites(
        record.threadId,
        record.checkpointNs,
        record.parentCheckpointId,
      );
      const pendingSends = await Promise.all(parentWrites
        .filter((write) => write.channel === TASKS)
        .map((write) => this.serde.loadsTyped(write.valueType, write.valueData)));
      checkpoint.channel_values ??= {};
      checkpoint.channel_values[TASKS] = pendingSends;
      checkpoint.channel_versions ??= {};
      const versions = Object.values(checkpoint.channel_versions);
      const currentVersion = versions.length > 0 ? maxChannelVersion(...versions) : undefined;
      checkpoint.channel_versions[TASKS] = typeof currentVersion === 'number'
        ? this.getNextVersion(currentVersion)
        : currentVersion ?? this.getNextVersion(undefined);
    }
    const configurable = {
      thread_id: record.threadId,
      checkpoint_ns: record.checkpointNs,
      checkpoint_id: record.checkpointId,
    };
    return {
      config: { configurable },
      checkpoint,
      metadata,
      pendingWrites,
      ...(record.parentCheckpointId
        ? { parentConfig: { configurable: { ...configurable, checkpoint_id: record.parentCheckpointId } } }
        : {}),
    };
  }
}

export class MemoryCheckpointStore implements CheckpointPersistence {
  private readonly checkpoints = new Map<string, StoredCheckpoint>();
  private readonly writes = new Map<string, StoredCheckpointWrite>();

  async putCheckpoint(record: StoredCheckpoint): Promise<void> {
    this.checkpoints.set(checkpointKey(record), cloneCheckpoint(record));
  }

  async getCheckpoint(query: { threadId: string; checkpointNs: string; checkpointId?: string }): Promise<StoredCheckpoint | undefined> {
    if (query.checkpointId) {
      const record = this.checkpoints.get(checkpointKey({ ...query, checkpointId: query.checkpointId }));
      return record ? cloneCheckpoint(record) : undefined;
    }
    return (await this.listCheckpoints({ threadId: query.threadId, checkpointNs: query.checkpointNs, limit: 1 }))[0];
  }

  async listCheckpoints(query: CheckpointQuery): Promise<StoredCheckpoint[]> {
    let records = [...this.checkpoints.values()].filter((record) =>
      (!query.threadId || record.threadId === query.threadId)
      && (query.checkpointNs === undefined || record.checkpointNs === query.checkpointNs)
      && (!query.checkpointId || record.checkpointId === query.checkpointId)
      && (!query.beforeCheckpointId || record.checkpointId < query.beforeCheckpointId));
    records.sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));
    if (query.limit !== undefined) records = records.slice(0, Math.max(0, query.limit));
    return records.map(cloneCheckpoint);
  }

  async putWrite(record: StoredCheckpointWrite): Promise<void> {
    const key = writeKey(record);
    if (record.index >= 0 && this.writes.has(key)) return;
    this.writes.set(key, cloneWrite(record));
  }

  async listWrites(threadId: string, checkpointNs: string, checkpointId: string): Promise<StoredCheckpointWrite[]> {
    return [...this.writes.values()]
      .filter((write) => write.threadId === threadId && write.checkpointNs === checkpointNs && write.checkpointId === checkpointId)
      .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.index - right.index)
      .map(cloneWrite);
  }

  async deleteThread(threadId: string): Promise<void> {
    for (const [key, record] of this.checkpoints) if (record.threadId === threadId) this.checkpoints.delete(key);
    for (const [key, record] of this.writes) if (record.threadId === threadId) this.writes.delete(key);
  }
}

export class KyselyCheckpointStore implements CheckpointPersistence {
  constructor(private readonly db: Kysely<Database>) {}

  async putCheckpoint(record: StoredCheckpoint): Promise<void> {
    await this.db.insertInto('langgraph_checkpoints').values({
      tenant_id: record.tenantId,
      thread_id: record.threadId,
      checkpoint_ns: record.checkpointNs,
      checkpoint_id: record.checkpointId,
      parent_checkpoint_id: record.parentCheckpointId ?? null,
      checkpoint_type: record.checkpointType,
      checkpoint_data: Buffer.from(record.checkpointData),
      metadata_type: record.metadataType,
      metadata_data: Buffer.from(record.metadataData),
      run_id: record.runId,
      graph_name: record.graphName,
      graph_version: record.graphVersion,
      expires_at: record.expiresAt ?? null,
      created_at: record.createdAt,
    }).onDuplicateKeyUpdate({
      parent_checkpoint_id: record.parentCheckpointId ?? null,
      checkpoint_type: record.checkpointType,
      checkpoint_data: Buffer.from(record.checkpointData),
      metadata_type: record.metadataType,
      metadata_data: Buffer.from(record.metadataData),
      expires_at: record.expiresAt ?? null,
    }).execute();
  }

  async getCheckpoint(query: { threadId: string; checkpointNs: string; checkpointId?: string }): Promise<StoredCheckpoint | undefined> {
    let builder = this.db.selectFrom('langgraph_checkpoints').selectAll()
      .where('thread_id', '=', query.threadId).where('checkpoint_ns', '=', query.checkpointNs);
    if (query.checkpointId) builder = builder.where('checkpoint_id', '=', query.checkpointId);
    const row = await builder.orderBy('checkpoint_id', 'desc').limit(1).executeTakeFirst();
    return row ? checkpointFromRow(row) : undefined;
  }

  async listCheckpoints(query: CheckpointQuery): Promise<StoredCheckpoint[]> {
    let builder = this.db.selectFrom('langgraph_checkpoints').selectAll();
    if (query.threadId) builder = builder.where('thread_id', '=', query.threadId);
    if (query.checkpointNs !== undefined) builder = builder.where('checkpoint_ns', '=', query.checkpointNs);
    if (query.checkpointId) builder = builder.where('checkpoint_id', '=', query.checkpointId);
    if (query.beforeCheckpointId) builder = builder.where('checkpoint_id', '<', query.beforeCheckpointId);
    let ordered = builder.orderBy('checkpoint_id', 'desc');
    if (query.limit !== undefined) ordered = ordered.limit(Math.max(0, query.limit));
    return (await ordered.execute()).map(checkpointFromRow);
  }

  async putWrite(record: StoredCheckpointWrite): Promise<void> {
    const insert = this.db.insertInto('langgraph_checkpoint_writes').values({
      tenant_id: record.tenantId,
      thread_id: record.threadId,
      checkpoint_ns: record.checkpointNs,
      checkpoint_id: record.checkpointId,
      task_id: record.taskId,
      write_index: record.index,
      channel: record.channel,
      value_type: record.valueType,
      value_data: Buffer.from(record.valueData),
    });
    if (record.index >= 0) {
      await insert.ignore().execute();
      return;
    }
    await insert.onDuplicateKeyUpdate({
        channel: record.channel,
        value_type: record.valueType,
        value_data: Buffer.from(record.valueData),
      }).execute();
  }

  async listWrites(threadId: string, checkpointNs: string, checkpointId: string): Promise<StoredCheckpointWrite[]> {
    const rows = await this.db.selectFrom('langgraph_checkpoint_writes').selectAll()
      .where('thread_id', '=', threadId).where('checkpoint_ns', '=', checkpointNs)
      .where('checkpoint_id', '=', checkpointId).orderBy('task_id').orderBy('write_index').execute();
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      threadId: row.thread_id,
      checkpointNs: row.checkpoint_ns,
      checkpointId: row.checkpoint_id,
      taskId: row.task_id,
      index: row.write_index,
      channel: row.channel,
      valueType: row.value_type,
      valueData: bytes(row.value_data),
    }));
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction.deleteFrom('langgraph_checkpoint_writes').where('thread_id', '=', threadId).execute();
      await transaction.deleteFrom('langgraph_checkpoints').where('thread_id', '=', threadId).execute();
    });
  }
}

function checkpointIdentity(config: RunnableConfig, requireThread: true): CheckpointIdentity;
function checkpointIdentity(config: RunnableConfig, requireThread: false): CheckpointIdentity | undefined;
function checkpointIdentity(config: RunnableConfig, requireThread: boolean): CheckpointIdentity | undefined {
  const configurable = config.configurable ?? {};
  const threadId = typeof configurable.thread_id === 'string' ? configurable.thread_id : '';
  if (requireThread && !threadId) throw new Error('thread_id is required for checkpoint persistence');
  if (!threadId) return undefined;
  return {
    threadId,
    checkpointNs: typeof configurable.checkpoint_ns === 'string' ? configurable.checkpoint_ns : '',
    checkpointId: typeof configurable.checkpoint_id === 'string' ? configurable.checkpoint_id : undefined,
    tenantId: typeof configurable.tenant_id === 'string' ? configurable.tenant_id : 'default',
    runId: typeof configurable.run_id === 'string' ? configurable.run_id : threadId,
    graphName: typeof configurable.graph_name === 'string' ? configurable.graph_name : 'aiop-agent',
    graphVersion: typeof configurable.graph_version === 'string' ? configurable.graph_version : 'v1',
  };
}

function configurableDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function checkpointKey(record: Pick<StoredCheckpoint, 'threadId' | 'checkpointNs' | 'checkpointId'>): string {
  return JSON.stringify([record.threadId, record.checkpointNs, record.checkpointId]);
}

function writeKey(record: StoredCheckpointWrite): string {
  return JSON.stringify([record.threadId, record.checkpointNs, record.checkpointId, record.taskId, record.index]);
}

function cloneCheckpoint(record: StoredCheckpoint): StoredCheckpoint {
  return { ...record, checkpointData: record.checkpointData.slice(), metadataData: record.metadataData.slice() };
}

function cloneWrite(record: StoredCheckpointWrite): StoredCheckpointWrite {
  return { ...record, valueData: record.valueData.slice() };
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'));
  return new Uint8Array();
}

function checkpointFromRow(row: Selectable<LangGraphCheckpointsTable>): StoredCheckpoint {
  return {
    tenantId: row.tenant_id,
    threadId: row.thread_id,
    checkpointNs: row.checkpoint_ns,
    checkpointId: row.checkpoint_id,
    parentCheckpointId: row.parent_checkpoint_id ?? undefined,
    checkpointType: row.checkpoint_type,
    checkpointData: bytes(row.checkpoint_data),
    metadataType: row.metadata_type,
    metadataData: bytes(row.metadata_data),
    runId: row.run_id,
    graphName: row.graph_name,
    graphVersion: row.graph_version,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
  };
}
