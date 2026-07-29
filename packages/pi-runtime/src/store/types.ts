import type {
  AgentInputMessage, AgentKernelName, AgentRunEvent, AgentRunResult, AgentRunStatus, AgentRunUsage,
  AttemptStatus, ClaimRunInput, ClaimedRun, CommitTurnInput,
  CompleteRunInput, CreateRunRecord, DurableInteractionUpdate, RenewLeaseInput, RequestCancellationInput, RunRecord, RunStore,
} from '@aiop/control-contracts';
import type { SessionStats, SessionTreeEntry } from '@earendil-works/pi-agent-core';

export interface StoredRun extends RunRecord {
  cancelRequestedAt?: Date;
  cancelReason?: string;
  result?: AgentRunResult;
  lastTurnNo: number;
  checkpoint?: unknown;
  appendClosedAt?: Date;
  runtimeVersion?: string;
  graphName?: string;
  graphVersion?: string;
  currentNode?: string;
  stepCount?: number;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ProductAttemptRecord {
  tenantId: string;
  runId: string;
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

export interface ProductTurnCommit {
  tenantId: string;
  runId: string;
  attemptId: string;
  turnNo: number;
  commitId: string;
  transcriptVersion: bigint;
  stopReason?: string;
  usage: AgentRunUsage;
  eventSequenceEnd: bigint;
  committedAt: Date;
}

export interface ToolLedgerApprovalClaim {
  tenantId: string;
  runId: string;
  logicalCallId: string;
  attemptId: string;
  turnNo: number;
  toolCallId: string;
  toolName: string;
  argsDigest: string;
  approvedInteractionId: string;
  started: import('@aiop/control-contracts').DurableToolLedgerUpdate;
}

export interface InteractionRepository {
  put(record: DurableInteractionUpdate): Promise<void>;
  get(identity: { tenantId: string; runId: string; interactionId: string }): Promise<DurableInteractionUpdate | undefined>;
  getById(tenantId: string, interactionId: string): Promise<DurableInteractionUpdate | undefined>;
  list(identity: { tenantId: string; runId: string }): Promise<DurableInteractionUpdate[]>;
  listByTenant(tenantId: string): Promise<DurableInteractionUpdate[]>;
}

export interface ToolLedgerRepository {
  putIfAbsent(record: import('@aiop/control-contracts').DurableToolLedgerUpdate): Promise<boolean>;
  get(identity: { tenantId: string; runId: string; logicalCallId: string }): Promise<import('@aiop/control-contracts').DurableToolLedgerUpdate | undefined>;
  update(record: import('@aiop/control-contracts').DurableToolLedgerUpdate): Promise<void>;
  claimPendingApproval(input: ToolLedgerApprovalClaim): Promise<boolean>;
  list(identity: { tenantId: string; runId: string }): Promise<import('@aiop/control-contracts').DurableToolLedgerUpdate[]>;
}

export interface DurableProductRunStore extends DurableRunStore {
  listRuns(tenantId: string): Promise<StoredRun[]>;
  updateProductRun(identity: { tenantId: string; runId: string }, patch: Partial<StoredRun>): Promise<boolean>;
  runs: {
    assertLease(identity: { tenantId: string; runId: string }, ownerId: string, token: bigint, now: Date): Promise<void>;
  };
  attempts: { list(identity: { tenantId: string; runId: string }): Promise<ProductAttemptRecord[]> };
  turns: { listCommitted(identity: { tenantId: string; runId: string }): Promise<ProductTurnCommit[]> };
  interactions: InteractionRepository;
  toolLedger: ToolLedgerRepository;
  events: {
    append(event: Omit<AgentRunEvent, 'sequence'>): Promise<AgentRunEvent>;
    list(identity: { tenantId: string; runId: string }, after?: bigint): Promise<AgentRunEvent[]>;
  };
  transaction<T>(work: (tx: DurableProductRunStore) => Promise<T>): Promise<T>;
}

export type DurableRunCreateResult = RunRecord & { sessionCreated: boolean };

export interface PiSessionRecord {
  tenantId: string;
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  currentLeafId: string | null;
  committedLeafId: string | null;
  metadata?: Record<string, unknown>;
}

export interface SessionEntryRecord {
  tenantId: string;
  sessionId: string;
  sequence: bigint;
  entry: SessionTreeEntry;
}

export interface RunInboxMessage {
  tenantId: string;
  runId: string;
  id: string;
  sequence: bigint;
  idempotencyKey: string;
  mode: 'steer' | 'follow_up';
  message: AgentInputMessage;
  status: 'pending' | 'claimed' | 'consumed';
  claimOwner?: string;
  claimToken?: string;
  claimExpiresAt?: Date;
  createdAt: Date;
  consumedAt?: Date;
}

export interface EnqueueInboxInput {
  identity: ClaimRunInput['identity'];
  tenantId: string;
  runId: string;
  idempotencyKey: string;
  mode: RunInboxMessage['mode'];
  message: AgentInputMessage;
  createdAt: Date;
}

export interface CloseInboxInput {
  tenantId: string;
  runId: string;
  workerId: string;
  fencingToken: bigint;
  now: Date;
}

export interface AppendRunEventsInput {
  tenantId: string;
  runId: string;
  attemptId: string;
  fencingToken: bigint;
  events: readonly Omit<AgentRunEvent, 'sequence'>[];
  appendedAt: Date;
}

export interface ClaimInboxInput {
  tenantId: string;
  runId: string;
  workerId: string;
  fencingToken: bigint;
  now: Date;
  claimTtlMs: number;
}

export interface ConsumeInboxInput extends ClaimInboxInput {
  id: string;
  claimToken: string;
  consumedAt: Date;
}

export interface PiSessionStore {
  create(input: { tenantId: string; sessionId: string; createdAt: Date; metadata?: Record<string, unknown> }): Promise<PiSessionRecord>;
  get(tenantId: string, sessionId: string): Promise<PiSessionRecord | undefined>;
  appendEntry(tenantId: string, sessionId: string, entry: SessionTreeEntry): Promise<SessionEntryRecord>;
  listEntries(tenantId: string, sessionId: string, options?: { afterSequence?: bigint; committedOnly?: boolean }): Promise<SessionEntryRecord[]>;
  getSessionStats(tenantId: string, sessionId: string): Promise<SessionStats>;
  setCurrentLeaf(tenantId: string, sessionId: string, leafId: string | null): Promise<void>;
}

export interface RunInboxStore {
  enqueue(input: EnqueueInboxInput): Promise<RunInboxMessage>;
  claimNext(input: ClaimInboxInput): Promise<RunInboxMessage | undefined>;
  markConsumed(input: ConsumeInboxInput): Promise<void>;
  list(tenantId: string, runId: string): Promise<RunInboxMessage[]>;
}

export interface DurableRunStore extends RunStore {
  create(input: CreateRunRecord): Promise<DurableRunCreateResult>;
  get(identity: { tenantId: string; runId: string }): Promise<StoredRun | undefined>;
  listEvents(identity: { tenantId: string; runId: string }, after?: bigint): Promise<AgentRunEvent[]>;
  appendEvents(input: AppendRunEventsInput): Promise<void>;
  isCancellationRequested(identity: { tenantId: string; runId: string }): Promise<boolean>;
  countAttempts(identity: { tenantId: string; runId: string }): Promise<number>;
  getInteraction(identity: { tenantId: string; runId: string; interactionId: string }): Promise<DurableInteractionUpdate | undefined>;
  resolveInteraction(record: DurableInteractionUpdate): Promise<boolean>;
  closeInbox(input: CloseInboxInput): Promise<void>;
  sessions: PiSessionStore;
  inbox: RunInboxStore;
}

export type { ClaimRunInput, ClaimedRun, CommitTurnInput, CompleteRunInput, CreateRunRecord, RenewLeaseInput, RequestCancellationInput };
