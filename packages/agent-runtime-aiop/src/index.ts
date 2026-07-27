import type { RequestContext } from '../../../src/auth/types.js';
import type {
  AgentRunEvent,
  AgentRunFilter,
  AgentRunRecord,
  AgentRunStatus,
  InteractionRecord,
  Store,
  ToolExecutionRecord,
} from '../../../src/db/store.js';

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
  constructor(private readonly store: Store, private readonly options: RunCenterOptions = {}) {}

  async list(ctx: RequestContext, filter: AgentRunFilter = {}) {
    const [runs, total] = await Promise.all([
      this.store.listAgentRuns(ctx, filter),
      this.store.countAgentRuns(ctx, filter),
    ]);
    return {
      runs: runs.map(publicRun), total,
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
    const blockedReason = recoveryBlockedReason(run, tools);
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
    const tools = await this.store.listAgentRunToolExecutions(ctx, runId);
    const blockedReason = recoveryBlockedReason(run, tools);
    if (blockedReason) throw new RunCenterConflictError(blockedReason);
    const now = new Date();
    await this.store.updateAgentRun(ctx.tenantId, runId, {
      status: 'queued', currentNode: null, errorMessage: null, completedAt: null,
      cancelRequestedAt: null, updatedAt: now,
    });
    await this.store.appendAgentRunEvent({
      tenantId: ctx.tenantId, runId, type: 'recovery', status: 'queued',
      detail: { requestedBy: ctx.userId }, createdAt: now,
    });
    this.options.recover?.(ctx, run);
  }
}

function recoveryBlockedReason(
  run: AgentRunRecord,
  tools: Awaited<ReturnType<Store['listAgentRunToolExecutions']>>,
): string | undefined {
  if (run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt.getTime() > Date.now()) {
    return '运行仍被执行实例持有，请等待租约释放或过期后再恢复';
  }
  const unsafe = tools.find((tool) => tool.status === 'started' || tool.status === 'unknown' || tool.status === 'recovery_required');
  if (unsafe) return `工具 ${unsafe.toolName} 的执行结果不确定，需要人工确认后恢复`;
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
