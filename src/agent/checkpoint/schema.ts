export interface StoredCheckpoint {
  tenantId: string;
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpointType: string;
  checkpointData: Uint8Array;
  metadataType: string;
  metadataData: Uint8Array;
  runId: string;
  graphName: string;
  graphVersion: string;
  expiresAt?: Date;
  createdAt: Date;
}

export interface StoredCheckpointWrite {
  tenantId: string;
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  taskId: string;
  index: number;
  channel: string;
  valueType: string;
  valueData: Uint8Array;
}

export interface CheckpointQuery {
  threadId?: string;
  checkpointNs?: string;
  checkpointId?: string;
  beforeCheckpointId?: string;
  limit?: number;
}

export interface CheckpointPersistence {
  putCheckpoint(record: StoredCheckpoint): Promise<void>;
  getCheckpoint(query: Required<Pick<CheckpointQuery, 'threadId' | 'checkpointNs'>> & { checkpointId?: string }): Promise<StoredCheckpoint | undefined>;
  listCheckpoints(query: CheckpointQuery): Promise<StoredCheckpoint[]>;
  putWrite(record: StoredCheckpointWrite): Promise<void>;
  listWrites(threadId: string, checkpointNs: string, checkpointId: string): Promise<StoredCheckpointWrite[]>;
  deleteThread(threadId: string): Promise<void>;
}
