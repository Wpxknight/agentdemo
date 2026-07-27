import type {
  AgentKernelName,
  AgentRunEvent,
  AgentRunStatus,
  AgentRunUsage,
  AttemptStatus,
  IdentityContext,
  JsonValue,
  KernelMessage,
  ModelBinding,
  ToolCapability,
  ToolResult,
  WaitingReason,
} from '@aiop/agent-contracts';

export interface RunIdentity {
  tenantId: string;
  runId: string;
}

export interface RunRecord extends RunIdentity {
  actorId: string;
  sessionId: string;
  kernel: AgentKernelName;
  kernelVersion: string;
  runtimeVersion: string;
  status: AgentRunStatus;
  waitingReason?: WaitingReason;
  leaseOwner?: string;
  leaseToken: bigint;
  leaseExpiresAt?: Date;
  cancelRequestedAt?: Date;
  usage: AgentRunUsage;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttemptRecord extends RunIdentity {
  attemptId: string;
  workerId: string;
  leaseToken: bigint;
  kernel: AgentKernelName;
  kernelVersion: string;
  status: AttemptStatus;
  errorCode?: string;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface TurnSnapshot extends RunIdentity {
  attemptId: string;
  turnNo: number;
  sessionVersion: bigint;
  parentCommitId?: string;
  identity: IdentityContext;
  modelBinding: ModelBinding;
  promptVersion: string;
  skillSetVersion?: string;
  toolSetVersion: string;
  policyVersion: string;
  deadlineAt?: Date;
  messages: readonly KernelMessage[];
  createdAt: Date;
}

export interface TurnCommit extends RunIdentity {
  attemptId: string;
  turnNo: number;
  commitId: string;
  transcriptVersion: bigint;
  stopReason?: string;
  usage: AgentRunUsage;
  eventSequenceEnd: bigint;
  messages: readonly KernelMessage[];
  committedAt: Date;
}

export interface CommitTurnInput {
  leaseOwner: string;
  leaseToken: bigint;
  snapshot: TurnSnapshot;
  commit: Omit<TurnCommit, 'eventSequenceEnd'>;
  events: readonly Omit<AgentRunEvent, 'sequence'>[];
  runStatus: AgentRunStatus;
  waitingReason?: WaitingReason;
  ledgerUpdates?: readonly ToolLedgerRecord[];
  interactionUpdates?: readonly InteractionRecord[];
}

export interface InteractionRecord extends RunIdentity {
  id: string;
  attemptId: string;
  turnNo: number;
  kind: 'approval' | 'question' | 'plan';
  status: 'pending' | 'resolved' | 'cancelled' | 'expired';
  payload: JsonValue;
  resolution?: JsonValue;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface ToolLedgerRecord extends RunIdentity {
  attemptId: string;
  turnNo: number;
  logicalCallId: string;
  toolCallId: string;
  toolName: string;
  argsDigest: string;
  capability: ToolCapability;
  idempotencyKey: string;
  status: 'pending_approval' | 'started' | 'completed' | 'unknown' | 'recovery_required';
  externalCorrelationId?: string;
  resultDigest?: string;
  approvedInteractionId?: string;
  result?: ToolResult;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeaseRecord {
  ownerId: string;
  token: bigint;
  expiresAt: Date;
}

export interface RunRepository {
  create(record: RunRecord): Promise<void>;
  get(identity: RunIdentity): Promise<RunRecord | undefined>;
  update(identity: RunIdentity, patch: Partial<RunRecord>): Promise<void>;
  acquireLease(identity: RunIdentity, ownerId: string, now: Date, ttlMs: number): Promise<LeaseRecord | undefined>;
  assertLease(identity: RunIdentity, ownerId: string, token: bigint, now: Date): Promise<void>;
}

export interface AttemptRepository {
  create(record: AttemptRecord): Promise<void>;
  update(identity: RunIdentity & { attemptId: string }, patch: Partial<AttemptRecord>): Promise<void>;
  list(identity: RunIdentity): Promise<AttemptRecord[]>;
}

export interface TurnRepository {
  createSnapshot(snapshot: TurnSnapshot): Promise<void>;
  getSnapshot(identity: RunIdentity & { attemptId: string; turnNo: number }): Promise<TurnSnapshot | undefined>;
  getLastCommitted(identity: RunIdentity): Promise<TurnCommit | undefined>;
  listCommitted(identity: RunIdentity): Promise<TurnCommit[]>;
  commit(input: CommitTurnInput): Promise<TurnCommit>;
}

export interface InteractionRepository {
  put(record: InteractionRecord): Promise<void>;
  get(identity: RunIdentity & { interactionId: string }): Promise<InteractionRecord | undefined>;
}

export interface ToolLedgerRepository {
  putIfAbsent(record: ToolLedgerRecord): Promise<boolean>;
  get(identity: RunIdentity & { logicalCallId: string }): Promise<ToolLedgerRecord | undefined>;
  update(record: ToolLedgerRecord): Promise<void>;
}

export interface RunEventRepository {
  append(event: Omit<AgentRunEvent, 'sequence'>): Promise<AgentRunEvent>;
  list(identity: RunIdentity, after?: bigint): Promise<AgentRunEvent[]>;
}

export interface RuntimeTransaction {
  runs: RunRepository;
  attempts: AttemptRepository;
  turns: TurnRepository;
  interactions: InteractionRepository;
  toolLedger: ToolLedgerRepository;
  events: RunEventRepository;
}

export interface RuntimeStore extends RuntimeTransaction {
  transaction<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T>;
}
