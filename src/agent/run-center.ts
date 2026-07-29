export interface RequestContext {
  tenantId: string;
  userId: string;
  role: 'platform_admin' | 'tenant_admin' | 'user';
}

export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required';

export interface AgentRunFilter {
  status?: AgentRunStatus;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface AgentRunRecord {
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
  kernel: 'pi';
  kernelVersion?: string;
  runtimeVersion?: string;
  graphName: string;
  graphVersion: string;
  createdAt: Date;
  status: AgentRunStatus;
  waitingReason?: 'approval' | 'question' | 'plan' | 'external';
  currentNode?: string;
  stepCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd?: number;
  };
  errorMessage?: string;
  startedAt?: Date;
  updatedAt: Date;
  completedAt?: Date;
  cancelRequestedAt?: Date;
  leaseOwner?: string;
  leaseToken: number;
  leaseExpiresAt?: Date;
}

export interface AgentRunEvent {
  sequence?: number;
  type: string;
  status?: string;
  id?: number;
  tenantId: string;
  runId: string;
  attemptId?: string;
  turnNo?: number;
  kernel?: 'pi';
  kernelVersion?: string;
  correlationId?: string;
  node?: string;
  detail?: unknown;
  createdAt: Date;
}

export interface InteractionRecord {
  id: string;
  kind: string;
  status: string;
  toolCallId?: string;
  createdAt: Date;
  resolvedAt?: Date;
  expiresAt?: Date;
}

export interface ToolExecutionRecord {
  toolCallId: string;
  toolName: string;
  status: string;
  startedAt: Date;
  completedAt?: Date;
  updatedAt: Date;
}

export interface AgentRunAttemptSummary {
  attemptId: string;
  kernel: string;
  kernelVersion: string;
  status: string;
  errorCode?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface AgentRunTurnSummary {
  attemptId: string;
  turnNo: number;
  commitId: string;
  transcriptVersion: number;
  stopReason?: string;
  usage: AgentRunRecord['usage'];
  eventSequenceEnd: number;
  committedAt: Date;
}

export interface RunCenterStore {
  listAgentRuns(ctx: RequestContext, filter: AgentRunFilter): Promise<AgentRunRecord[]>;
  countAgentRuns(ctx: RequestContext, filter: AgentRunFilter): Promise<number>;
  getAgentRun(ctx: RequestContext, runId: string): Promise<AgentRunRecord | undefined>;
  listAgentRunEvents(ctx: RequestContext, runId: string): Promise<AgentRunEvent[]>;
  listAgentRunInteractions(ctx: RequestContext, runId: string): Promise<InteractionRecord[]>;
  listAgentRunToolExecutions(ctx: RequestContext, runId: string): Promise<ToolExecutionRecord[]>;
  listAgentRunAttempts(ctx: RequestContext, runId: string): Promise<AgentRunAttemptSummary[]>;
  listAgentRunTurns(ctx: RequestContext, runId: string): Promise<AgentRunTurnSummary[]>;
  requestAgentRunCancellation(ctx: RequestContext, runId: string): Promise<boolean>;
  updateAgentRun(tenantId: string, runId: string, patch: {
    status?: AgentRunStatus;
    currentNode?: string | null;
    errorMessage?: string | null;
    completedAt?: Date | null;
    cancelRequestedAt?: Date | null;
    updatedAt?: Date;
  }): Promise<boolean>;
  appendAgentRunEvent(event: AgentRunEvent): Promise<unknown>;
}

const CANCELLABLE = new Set<AgentRunStatus>(['queued', 'running', 'waiting']);
const RESUMABLE = new Set<AgentRunStatus>(['failed', 'recovery_required']);

export class RunCenterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunCenterConflictError';
  }
}

export class RunCenterNotFoundError extends Error {
  constructor(message = '运行不存在') {
    super(message);
    this.name = 'RunCenterNotFoundError';
  }
}

export interface RunCenterOptions {
  abortLocal?: (ctx: RequestContext, runId: string) => number;
  recover?: (ctx: RequestContext, run: AgentRunRecord) => void;
}

export class RunCenterService {
  constructor(private readonly store: RunCenterStore, private readonly options: RunCenterOptions = {}) {}

  async list(ctx: RequestContext, filter: AgentRunFilter = {}) {
    const [runs, total] = await Promise.all([
      this.store.listAgentRuns(ctx, filter),
      this.store.countAgentRuns(ctx, filter),
    ]);
    const summarized = await Promise.all(runs.map(async (run) => {
      const [attempts, turns] = await Promise.all([
        this.store.listAgentRunAttempts(ctx, run.runId),
        this.store.listAgentRunTurns(ctx, run.runId),
      ]);
      return {
        ...publicRun(run),
        attemptSummary: { count: attempts.length, latest: attempts.at(-1) },
        turnSummary: { count: turns.length, latest: turns.at(-1) },
      };
    }));
    return {
      runs: summarized, total,
      limit: filter.limit ?? 50, offset: filter.offset ?? 0,
      hasMore: (filter.offset ?? 0) + runs.length < total,
    };
  }

  async detail(ctx: RequestContext, runId: string) {
    const run = await this.store.getAgentRun(ctx, runId);
    if (!run) return undefined;
    const [events, interactions, tools, attempts, turns] = await Promise.all([
      this.store.listAgentRunEvents(ctx, runId),
      this.store.listAgentRunInteractions(ctx, runId),
      this.store.listAgentRunToolExecutions(ctx, runId),
      this.store.listAgentRunAttempts(ctx, runId),
      this.store.listAgentRunTurns(ctx, runId),
    ]);
    const blockedReason = recoveryBlockedReason(run, tools, interactions);
    return {
      run: publicRun(run),
      events: events.map(publicEvent),
      interactions: interactions.map(publicInteraction),
      tools: tools.map(publicToolExecution),
      attempts,
      turns,
      canCancel: CANCELLABLE.has(run.status),
      canResume: RESUMABLE.has(run.status) && !blockedReason,
      recoveryBlockedReason: blockedReason,
    };
  }

  async events(ctx: RequestContext, runId: string, afterSequence = 0): Promise<AgentRunEvent[] | undefined> {
    if (!await this.store.getAgentRun(ctx, runId)) return undefined;
    return (await this.store.listAgentRunEvents(ctx, runId))
      .filter((event) => (event.sequence ?? 0) > afterSequence)
      .map(publicEvent);
  }

  async cancel(ctx: RequestContext, runId: string): Promise<{ abortedLocal: number }> {
    const run = await this.store.getAgentRun(ctx, runId);
    if (!run) throw new RunCenterNotFoundError();
    if (!CANCELLABLE.has(run.status)) throw new RunCenterConflictError(`当前状态不可取消：${run.status}`);
    if (!await this.store.requestAgentRunCancellation(ctx, runId)) throw new RunCenterNotFoundError();
    return { abortedLocal: this.options.abortLocal?.(ctx, runId) ?? 0 };
  }

  async resume(ctx: RequestContext, runId: string): Promise<void> {
    const run = await this.store.getAgentRun(ctx, runId);
    if (!run) throw new RunCenterNotFoundError();
    if (!RESUMABLE.has(run.status)) throw new RunCenterConflictError(`当前状态不可恢复：${run.status}`);
    const [tools, interactions] = await Promise.all([
      this.store.listAgentRunToolExecutions(ctx, runId),
      this.store.listAgentRunInteractions(ctx, runId),
    ]);
    const blockedReason = recoveryBlockedReason(run, tools, interactions);
    if (blockedReason) throw new RunCenterConflictError(blockedReason);
    const now = new Date();
    await this.store.updateAgentRun(ctx.tenantId, runId, {
      currentNode: null, errorMessage: null, completedAt: null,
      cancelRequestedAt: null, updatedAt: now,
    });
    await this.store.appendAgentRunEvent({
      tenantId: ctx.tenantId, runId, type: 'recovery', status: 'requested',
      detail: { requestedBy: ctx.userId }, createdAt: now,
    });
    this.options.recover?.(ctx, run);
  }
}

function recoveryBlockedReason(
  run: AgentRunRecord,
  tools: ToolExecutionRecord[],
  interactions: InteractionRecord[] = [],
): string | undefined {
  if (run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now()) {
    return '运行仍被执行实例持有，请等待租约释放或过期后再恢复';
  }
  const unsafe = tools.find((tool) => tool.status === 'started' || tool.status === 'unknown' || tool.status === 'recovery_required');
  if (unsafe) return `工具 ${unsafe.toolName} 的执行结果不确定，需要人工确认后恢复`;
  const pending = interactions.find((interaction) => interaction.status === 'pending');
  if (pending) return `运行仍有 pending Interaction（${pending.kind}:${pending.id}），必须先提交可信 resolution`;
  return undefined;
}

function publicRun(run: AgentRunRecord): Omit<AgentRunRecord, 'leaseOwner'> & { leaseActive: boolean } {
  const { leaseOwner, ...safe } = run;
  return { ...safe, leaseActive: Boolean(leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now()) };
}

function publicEvent(event: AgentRunEvent): AgentRunEvent {
  if (!event.detail || event.type !== 'run' || event.status !== 'running') return event;
  return { ...event, detail: { leaseToken: (event.detail as { leaseToken?: unknown }).leaseToken } };
}

function publicInteraction(record: InteractionRecord) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    toolCallId: record.toolCallId,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
    expiresAt: record.expiresAt,
  };
}

function publicToolExecution(record: ToolExecutionRecord) {
  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt,
  };
}
