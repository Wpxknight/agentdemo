import type { Msg } from '../llm/types.js';
import { estimateTokens } from '../llm/context.js';
import type { AuditEvent } from '../audit/sink.js';
import type { RequestContext, Tenant, User } from '../auth/types.js';
import type { McpServerConfig } from '@aiop/mcp-runtime';
import type {
  AuditFilter,
  NewUser,
  LlmSettings,
  SandboxSettings,
  SandboxSettingsRecord,
  SandboxSettingsSecretUpdate,
  SchedulerSettings,
  SessionContextUsage,
  SessionTokenUsage,
  SessionInput,
  SessionSummary,
  SessionTouchInput,
  InteractionRecord,
  AgentRunBinding,
  AgentRunEvent,
  AgentRunFilter,
  AgentRunLease,
  AgentRunPatch,
  AgentRunRecord,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskPatch,
  Store,
  TaskRun,
  ToolExecutionRecord,
  UserCredentialRecord,
  UserPatch,
  UserWithSecret,
} from './store.js';
import { DEFAULT_SESSION_TITLE } from './store.js';
import { nextRunAt } from '../scheduler/cron.js';
import { MemoryRunStore } from '@aiop/pi-runtime';
import type { StoredRun } from '@aiop/pi-runtime';
import type {
  DurableInteractionUpdate as RuntimeInteractionRecord, DurableToolLedgerUpdate, JsonValue,
} from '@aiop/control-contracts';

interface MsgRow {
  tenantId: string;
  userId: string;
  sessionId: string;
  msg: Msg;
  createdAt: Date;
}

interface SessionRow {
  tenantId: string;
  userId: string;
  sessionId: string;
  title: string;
  explicitTitle: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function summarize(text: string | undefined, max = 48): string {
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

/** 内存 Store：未配置 MySQL 时的回落实现，亦用于测试。租户隔离同样强制生效。 */
export class MemoryStore implements Store {
  private durableStore = new MemoryRunStore();

  durableRunStore() {
    return this.durableStore;
  }
  private messages: MsgRow[] = [];
  private sessions = new Map<string, SessionRow>();
  private audit: AuditEvent[] = [];
  private tasks = new Map<number, ScheduledTask>();
  private runs: TaskRun[] = [];
  private tenants = new Map<string, Tenant>();
  private users = new Map<string, UserWithSecret>(); // key: tenantId/username
  private credentials = new Map<string, UserCredentialRecord>(); // key: tenantId/userId/provider
  private llmSettings = new Map<string, LlmSettings>();
  private schedulerSettings = new Map<string, SchedulerSettings>();
  private sandboxSettings = new Map<string, SandboxSettingsRecord>();
  private mcpServers = new Map<string, Record<string, McpServerConfig>>();
  private toolExecutions = new Map<string, ToolExecutionRecord>();
  private agentRunBindings = new Map<string, AgentRunRecord>();
  private agentRunEvents: AgentRunEvent[] = [];
  private taskSeq = 0;
  private runSeq = 0;
  private agentRunEventSeq = 0;
  private userSeq = 0;

  // 会话/消息按 (tenant, user) 双重隔离：不同用户的同名 sessionId 互不可见、互不冲突。
  private sessionKey(ctx: Pick<RequestContext, 'tenantId' | 'userId'>, sessionId: string): string {
    return `${ctx.tenantId}/${ctx.userId}/${sessionId}`;
  }

  private sessionMessages(ctx: RequestContext, sessionId: string): MsgRow[] {
    return this.messages.filter(
      (r) => r.tenantId === ctx.tenantId && r.userId === ctx.userId && r.sessionId === sessionId,
    );
  }

  private sessionSummary(ctx: RequestContext, session: SessionRow): SessionSummary {
    const rows = this.sessionMessages(ctx, session.sessionId);
    const last = rows.at(-1);
    return {
      sessionId: session.sessionId,
      title: session.title,
      lastMessage: summarize(last?.msg.text),
      messageCount: rows.length,
      updatedAt: (last?.createdAt ?? session.updatedAt).toISOString(),
    };
  }

  async createSession(ctx: RequestContext, input: SessionInput): Promise<SessionSummary> {
    const now = new Date();
    const key = this.sessionKey(ctx, input.sessionId);
    // 占位标题（如前端默认的“新会话”）不算显式命名，之后首条用户消息可覆盖。
    const explicitTitle = Boolean(input.title) && input.title !== DEFAULT_SESSION_TITLE;
    const existing = this.sessions.get(key);
    if (existing) {
      if (input.title) {
        existing.title = summarize(input.title);
        existing.explicitTitle = explicitTitle || existing.explicitTitle;
      }
      existing.updatedAt = now;
      return this.sessionSummary(ctx, existing);
    }

    const session: SessionRow = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: input.sessionId,
      title: summarize(input.title ?? input.sessionId),
      explicitTitle,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    return this.sessionSummary(ctx, session);
  }

  async touchSession(ctx: RequestContext, sessionId: string, input: SessionTouchInput = {}): Promise<void> {
    const key = this.sessionKey(ctx, sessionId);
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : new Date();
    const existing = this.sessions.get(key);
    if (existing) {
      // 占位标题被首条用户消息覆盖一次后即锁定，后续消息不再改名。
      if (input.title && !existing.explicitTitle) {
        existing.title = summarize(input.title);
        existing.explicitTitle = true;
      }
      existing.updatedAt = updatedAt;
      return;
    }

    this.sessions.set(key, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId,
      title: summarize(input.title ?? sessionId),
      explicitTitle: Boolean(input.title) && input.title !== DEFAULT_SESSION_TITLE,
      createdAt: updatedAt,
      updatedAt,
    });
  }

  async appendMessage(ctx: RequestContext, sessionId: string, msg: Msg): Promise<void> {
    const createdAt = new Date();
    this.messages.push({ tenantId: ctx.tenantId, userId: ctx.userId, sessionId, msg, createdAt });
    await this.touchSession(ctx, sessionId, {
      title: msg.role === 'user' ? msg.text : undefined,
      updatedAt: createdAt,
    });
  }

  async appendMessages(ctx: RequestContext, sessionId: string, msgs: Msg[]): Promise<void> {
    if (!msgs.length) return;
    const createdAt = new Date();
    for (const msg of msgs) this.messages.push({ tenantId: ctx.tenantId, userId: ctx.userId, sessionId, msg, createdAt });
    await this.touchSession(ctx, sessionId, {
      title: msgs.find((m) => m.role === 'user' && m.text)?.text,
      updatedAt: createdAt,
    });
  }

  async listMessages(ctx: RequestContext, sessionId: string): Promise<Msg[]> {
    return this.sessionMessages(ctx, sessionId).map((r) => r.msg);
  }

  async replaceMessages(ctx: RequestContext, sessionId: string, messages: Msg[]): Promise<void> {
    const createdAt = new Date();
    this.messages = this.messages.filter(
      (r) => !(r.tenantId === ctx.tenantId && r.userId === ctx.userId && r.sessionId === sessionId),
    );
    for (const msg of messages) this.messages.push({ tenantId: ctx.tenantId, userId: ctx.userId, sessionId, msg, createdAt });
  }

  async listSessions(ctx: RequestContext, limit = 50, offset = 0): Promise<SessionSummary[]> {
    const safeLimit = Math.max(0, limit);
    const safeOffset = Math.max(0, offset);
    if (safeLimit <= 0) return [];

    return [...this.sessions.values()]
      .filter((r) => r.tenantId === ctx.tenantId && r.userId === ctx.userId)
      .map((session) => this.sessionSummary(ctx, session))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(safeOffset, safeOffset + safeLimit);
  }

  async countSessions(ctx: RequestContext): Promise<number> {
    return [...this.sessions.values()].filter((r) => r.tenantId === ctx.tenantId && r.userId === ctx.userId).length;
  }

  async deleteSession(ctx: RequestContext, sessionId: string): Promise<boolean> {
    const before = this.messages.length;
    this.messages = this.messages.filter(
      (r) => !(r.tenantId === ctx.tenantId && r.userId === ctx.userId && r.sessionId === sessionId),
    );
    const deletedSession = this.sessions.delete(this.sessionKey(ctx, sessionId));
    return this.messages.length < before || deletedSession;
  }

  async getSessionContextUsage(
    ctx: RequestContext,
    sessionId: string,
    maxTokens: number,
  ): Promise<SessionContextUsage> {
    return {
      usedTokens: estimateTokens(await this.listMessages(ctx, sessionId)),
      maxTokens,
      estimated: true,
    };
  }

  async getSessionTokenUsage(ctx: RequestContext, sessionId: string): Promise<SessionTokenUsage> {
    const totalTokens = this.audit
      .filter((event) => event.tenantId === ctx.tenantId
        && event.sessionId === sessionId
        && event.kind === 'usage'
        && event.action === 'agent')
      .reduce((total, event) => {
        const inputTokens = typeof event.detail?.inputTokens === 'number' ? event.detail.inputTokens : 0;
        const outputTokens = typeof event.detail?.outputTokens === 'number' ? event.detail.outputTokens : 0;
        return total + Math.max(0, inputTokens) + Math.max(0, outputTokens);
      }, 0);
    return { totalTokens };
  }

  async putInteraction(record: InteractionRecord): Promise<void> {
    await this.durableStore.interactions.put(toRuntimeInteraction(record));
  }

  async getInteraction(tenantId: string, id: string): Promise<InteractionRecord | undefined> {
    const record = await this.durableStore.interactions.getById(tenantId, id);
    return record ? fromRuntimeInteraction(record) : undefined;
  }

  async listPendingInteractions(ctx: RequestContext): Promise<InteractionRecord[]> {
    return (await this.durableStore.interactions.listByTenant(ctx.tenantId))
      .filter((record) => record.tenantId === ctx.tenantId && record.status === 'pending')
      .map(fromRuntimeInteraction);
  }

  async resolveInteraction(record: InteractionRecord): Promise<boolean> {
    return this.durableStore.transaction(async (tx) => {
      const current = await tx.interactions.get({
        tenantId: record.tenantId, runId: record.runId, interactionId: record.id,
      });
      if (!current || current.status !== 'pending') return false;
      await tx.interactions.put(toRuntimeInteraction(record));
      return true;
    });
  }

  async putToolExecutionIfAbsent(record: ToolExecutionRecord): Promise<boolean> {
    const key = toolExecutionKey(record.tenantId, record.runId, record.toolCallId);
    if (this.toolExecutions.has(key)) return false;
    this.toolExecutions.set(key, cloneToolExecution(record));
    return true;
  }

  async getToolExecution(tenantId: string, runId: string, toolCallId: string): Promise<ToolExecutionRecord | undefined> {
    const record = this.toolExecutions.get(toolExecutionKey(tenantId, runId, toolCallId));
    return record ? cloneToolExecution(record) : undefined;
  }

  async updateToolExecution(record: ToolExecutionRecord): Promise<void> {
    this.toolExecutions.set(
      toolExecutionKey(record.tenantId, record.runId, record.toolCallId),
      cloneToolExecution(record),
    );
  }

  async getAgentRunBinding(tenantId: string, runId: string): Promise<AgentRunBinding | undefined> {
    const binding = this.agentRunBindings.get(`${tenantId}/${runId}`);
    return binding ? structuredClone(binding) : undefined;
  }

  async putAgentRunBindingIfAbsent(binding: AgentRunBinding): Promise<boolean> {
    const key = `${binding.tenantId}/${binding.runId}`;
    if (this.agentRunBindings.has(key)) return false;
    this.agentRunBindings.set(key, {
      ...structuredClone(binding),
      status: 'queued',
      stepCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      updatedAt: new Date(binding.createdAt),
      leaseToken: 0,
    });
    return true;
  }

  async getAgentRun(ctx: RequestContext, runId: string): Promise<AgentRunRecord | undefined> {
    const record = this.agentRunBindings.get(`${ctx.tenantId}/${runId}`);
    if (record && canReadAgentRun(ctx, record)) return structuredClone(record);
    const durable = await this.durableStore.get({ tenantId: ctx.tenantId, runId });
    const projected = durable ? fromStoredRun(durable) : undefined;
    return projected && canReadAgentRun(ctx, projected) ? projected : undefined;
  }

  async listAgentRuns(ctx: RequestContext, filter: AgentRunFilter = {}): Promise<AgentRunRecord[]> {
    const limit = Math.max(0, filter.limit ?? 50);
    const offset = Math.max(0, filter.offset ?? 0);
    const records = await this.allAgentRuns(ctx.tenantId);
    return records
      .filter((record) => canReadAgentRun(ctx, record))
      .filter((record) => !filter.status || record.status === filter.status)
      .filter((record) => !filter.sessionId || record.sessionId === filter.sessionId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((record) => structuredClone(record));
  }

  async countAgentRuns(ctx: RequestContext, filter: AgentRunFilter = {}): Promise<number> {
    return (await this.allAgentRuns(ctx.tenantId))
      .filter((record) => canReadAgentRun(ctx, record))
      .filter((record) => !filter.status || record.status === filter.status)
      .filter((record) => !filter.sessionId || record.sessionId === filter.sessionId)
      .length;
  }

  async updateAgentRun(tenantId: string, runId: string, patch: AgentRunPatch): Promise<boolean> {
    const key = `${tenantId}/${runId}`;
    const current = this.agentRunBindings.get(key);
    if (!current) return this.durableStore.updateProductRun({ tenantId, runId }, productPatch(patch));
    const next: AgentRunRecord = {
      ...current,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.waitingReason !== undefined ? { waitingReason: patch.waitingReason ?? undefined } : {}),
      ...(patch.currentNode !== undefined ? { currentNode: patch.currentNode ?? undefined } : {}),
      ...(patch.stepCount !== undefined ? { stepCount: patch.stepCount } : {}),
      ...(patch.usage ? { usage: structuredClone(patch.usage) } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage ?? undefined } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt ?? undefined } : {}),
      updatedAt: patch.updatedAt ?? new Date(),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt ?? undefined } : {}),
      ...(patch.cancelRequestedAt !== undefined ? { cancelRequestedAt: patch.cancelRequestedAt ?? undefined } : {}),
    };
    if (patch.clearLease) {
      next.leaseOwner = undefined;
      next.leaseExpiresAt = undefined;
    }
    this.agentRunBindings.set(key, next);
    return true;
  }

  async appendAgentRunEvent(event: AgentRunEvent): Promise<void> {
    const durableRun = await this.durableStore.get({ tenantId: event.tenantId, runId: event.runId });
    if (durableRun) {
      const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
        ? structuredClone(event.detail as Record<string, unknown>)
        : event.detail === undefined ? {} : { value: structuredClone(event.detail) };
      await this.durableStore.events.append({
        tenantId: event.tenantId, runId: event.runId, type: event.type,
        attemptId: event.attemptId ?? 'product', turnNo: event.turnNo ?? durableRun.lastTurnNo,
        kernel: 'pi', kernelVersion: event.kernelVersion ?? durableRun.kernelVersion,
        correlationId: event.correlationId ?? `product:${event.type}`,
        detail: {
          ...detail,
          ...(event.status ? { productStatus: event.status } : {}),
          ...(event.type === 'recovery' && event.status ? { recoveryStatus: event.status } : {}),
          ...(event.node ? { productNode: event.node } : {}),
        },
        createdAt: event.createdAt,
      });
      return;
    }
    const sequence = event.sequence ?? this.agentRunEvents
      .filter((item) => item.tenantId === event.tenantId && item.runId === event.runId)
      .reduce((max, item) => Math.max(max, item.sequence ?? 0), 0) + 1;
    this.agentRunEvents.push(structuredClone({ ...event, id: ++this.agentRunEventSeq, sequence }));
  }

  async listAgentRunEvents(ctx: RequestContext, runId: string): Promise<AgentRunEvent[]> {
    if (!await this.getAgentRun(ctx, runId)) return [];
    const durable = await this.durableStore.events.list({ tenantId: ctx.tenantId, runId });
    if (durable.length) return durable.map((event) => ({
      ...(() => {
        const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
          ? event.detail as Record<string, unknown> : {};
        return {
          status: typeof detail.productStatus === 'string' ? detail.productStatus : undefined,
          node: typeof detail.productNode === 'string' ? detail.productNode : undefined,
        };
      })(),
      tenantId: event.tenantId,
      runId: event.runId,
      sequence: Number(event.sequence),
      type: event.type,
      attemptId: event.attemptId,
      turnNo: event.turnNo,
      kernel: event.kernel === 'pi' ? 'pi' : undefined,
      kernelVersion: event.kernelVersion,
      correlationId: event.correlationId,
      detail: event.detail,
      createdAt: event.createdAt,
    }));
    return this.agentRunEvents
      .filter((event) => event.tenantId === ctx.tenantId && event.runId === runId)
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
      .map((event) => structuredClone(event));
  }

  async listAgentRunAttempts(ctx: RequestContext, runId: string) {
    if (!await this.getAgentRun(ctx, runId)) return [];
    return (await this.durableStore.attempts.list({ tenantId: ctx.tenantId, runId })).map((attempt) => ({
      attemptId: attempt.attemptId,
      kernel: attempt.kernel,
      kernelVersion: attempt.kernelVersion,
      status: attempt.status,
      errorCode: attempt.errorCode,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    }));
  }

  async listAgentRunTurns(ctx: RequestContext, runId: string) {
    if (!await this.getAgentRun(ctx, runId)) return [];
    return (await this.durableStore.turns.listCommitted({ tenantId: ctx.tenantId, runId })).map((turn) => ({
      attemptId: turn.attemptId,
      turnNo: turn.turnNo,
      commitId: turn.commitId,
      transcriptVersion: Number(turn.transcriptVersion),
      stopReason: turn.stopReason,
      usage: turn.usage,
      eventSequenceEnd: Number(turn.eventSequenceEnd),
      committedAt: turn.committedAt,
    }));
  }

  async listAgentRunInteractions(ctx: RequestContext, runId: string): Promise<InteractionRecord[]> {
    if (!await this.getAgentRun(ctx, runId)) return [];
    return (await this.durableStore.interactions.list({ tenantId: ctx.tenantId, runId }))
      .map(fromRuntimeInteraction);
  }

  async listAgentRunToolExecutions(ctx: RequestContext, runId: string): Promise<ToolExecutionRecord[]> {
    if (!await this.getAgentRun(ctx, runId)) return [];
    const direct = [...this.toolExecutions.values()]
      .filter((record) => record.tenantId === ctx.tenantId && record.runId === runId)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map(cloneToolExecution);
    const durable = (await this.durableStore.toolLedger.list({ tenantId: ctx.tenantId, runId }))
      .map(fromDurableToolLedger);
    const durableCalls = new Set(durable.map((record) => record.toolCallId));
    return [...direct.filter((record) => !durableCalls.has(record.toolCallId)), ...durable]
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  }

  async acquireAgentRunLease(
    tenantId: string, runId: string, ownerId: string, now: Date, ttlMs: number,
  ): Promise<AgentRunLease | undefined> {
    const key = `${tenantId}/${runId}`;
    const current = this.agentRunBindings.get(key);
    if (!current) return undefined;
    if (current.leaseOwner && current.leaseExpiresAt && current.leaseExpiresAt.getTime() > now.getTime()) {
      if (current.leaseOwner !== ownerId) return undefined;
      current.leaseExpiresAt = new Date(now.getTime() + ttlMs);
      current.updatedAt = new Date(now);
      return { ownerId, token: current.leaseToken, expiresAt: new Date(current.leaseExpiresAt) };
    }
    current.leaseOwner = ownerId;
    current.leaseToken += 1;
    current.leaseExpiresAt = new Date(now.getTime() + ttlMs);
    current.updatedAt = new Date(now);
    return { ownerId, token: current.leaseToken, expiresAt: new Date(current.leaseExpiresAt) };
  }

  async renewAgentRunLease(
    tenantId: string, runId: string, ownerId: string, token: number, now: Date, ttlMs: number,
  ): Promise<boolean> {
    const current = this.agentRunBindings.get(`${tenantId}/${runId}`);
    if (!current || current.leaseOwner !== ownerId || current.leaseToken !== token) return false;
    current.leaseExpiresAt = new Date(now.getTime() + ttlMs);
    current.updatedAt = new Date(now);
    return true;
  }

  async assertAgentRunLease(
    tenantId: string, runId: string, ownerId: string, token: number, now = new Date(),
  ): Promise<void> {
    const current = this.agentRunBindings.get(`${tenantId}/${runId}`);
    if (!current || current.leaseOwner !== ownerId || current.leaseToken !== token
      || !current.leaseExpiresAt || current.leaseExpiresAt.getTime() <= now.getTime()) {
      throw new Error('Agent run lease lost');
    }
  }

  async releaseAgentRunLease(tenantId: string, runId: string, ownerId: string, token: number): Promise<boolean> {
    const current = this.agentRunBindings.get(`${tenantId}/${runId}`);
    if (!current || current.leaseOwner !== ownerId || current.leaseToken !== token) return false;
    current.leaseOwner = undefined;
    current.leaseExpiresAt = undefined;
    current.updatedAt = new Date();
    return true;
  }

  async requestAgentRunCancellation(ctx: RequestContext, runId: string, now = new Date()): Promise<boolean> {
    const current = await this.getAgentRun(ctx, runId);
    if (!current) return false;
    return this.updateAgentRun(ctx.tenantId, runId, { cancelRequestedAt: now, updatedAt: now });
  }

  async isAgentRunCancellationRequested(tenantId: string, runId: string): Promise<boolean> {
    return Boolean(this.agentRunBindings.get(`${tenantId}/${runId}`)?.cancelRequestedAt)
      || this.durableStore.isCancellationRequested({ tenantId, runId });
  }

  private async allAgentRuns(tenantId: string): Promise<AgentRunRecord[]> {
    const durable = (await this.durableStore.listRuns(tenantId)).map(fromStoredRun);
    const bindingIds = new Set(this.agentRunBindings.keys());
    return [...this.agentRunBindings.values(), ...durable.filter((record) =>
      !bindingIds.has(`${record.tenantId}/${record.runId}`))];
  }

  async record(event: AuditEvent): Promise<void> {
    this.audit.push({ ...event });
  }

  async listAudit(ctx: RequestContext, filter: AuditFilter = {}): Promise<AuditEvent[]> {
    let rows = this.audit.filter((e) => e.tenantId === ctx.tenantId);
    if (filter.sessionId) rows = rows.filter((e) => e.sessionId === filter.sessionId);
    if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
    const out = [...rows];
    return filter.limit ? out.slice(-filter.limit) : out;
  }

  async createScheduledTask(ctx: RequestContext, input: ScheduledTaskInput): Promise<ScheduledTask> {
    const id = ++this.taskSeq;
    const task: ScheduledTask = {
      id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: input.sessionId,
      cron: input.cron,
      title: input.title ?? '',
      task: input.task,
      preApproved: input.preApproved ?? false,
      enabled: input.enabled ?? true,
      nextRunAt: nextRunAt(input.cron, new Date()),
    };
    this.tasks.set(id, task);
    return { ...task };
  }

  /** 任务可见性：普通用户仅见自己创建的；租户/平台管理员见全租户。 */
  private canSeeTask(ctx: RequestContext, t: ScheduledTask): boolean {
    if (t.tenantId !== ctx.tenantId) return false;
    return ctx.role !== 'user' || t.userId === ctx.userId;
  }

  async listScheduledTasks(ctx: RequestContext): Promise<ScheduledTask[]> {
    return [...this.tasks.values()]
      .filter((t) => this.canSeeTask(ctx, t))
      .map((t) => ({ ...t }));
  }

  async getScheduledTask(ctx: RequestContext, id: number): Promise<ScheduledTask | undefined> {
    const t = this.tasks.get(id);
    return t && this.canSeeTask(ctx, t) ? { ...t } : undefined;
  }

  async updateScheduledTask(ctx: RequestContext, id: number, patch: ScheduledTaskPatch): Promise<ScheduledTask | undefined> {
    const t = this.tasks.get(id);
    if (!t || !this.canSeeTask(ctx, t)) return undefined;
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.task !== undefined) t.task = patch.task;
    if (patch.preApproved !== undefined) t.preApproved = patch.preApproved;
    if (patch.enabled !== undefined) t.enabled = patch.enabled;
    if (patch.cron !== undefined && patch.cron !== t.cron) {
      t.cron = patch.cron;
      t.nextRunAt = nextRunAt(patch.cron, new Date());
    }
    return { ...t };
  }

  async deleteScheduledTask(ctx: RequestContext, id: number): Promise<boolean> {
    const t = this.tasks.get(id);
    if (!t || !this.canSeeTask(ctx, t)) return false;
    this.tasks.delete(id);
    this.runs = this.runs.filter((r) => r.taskId !== id);
    return true;
  }

  async setTaskEnabled(ctx: RequestContext, id: number, enabled: boolean): Promise<void> {
    const t = this.tasks.get(id);
    if (t && this.canSeeTask(ctx, t)) t.enabled = enabled;
  }

  // 单进程内 JS 单线程：select→推进之间无 await，天然原子，并发 tick 不会重复领取。
  async claimDueTasks(now: Date, limit: number): Promise<ScheduledTask[]> {
    const due = [...this.tasks.values()]
      .filter((t) => t.enabled && t.nextRunAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
      .slice(0, limit);
    const claimed = due.map((t) => ({ ...t }));
    for (const t of due) {
      t.lastRunAt = now;
      t.nextRunAt = nextRunAt(t.cron, now);
    }
    return claimed;
  }

  async recordTaskRun(run: TaskRun): Promise<void> {
    this.runs.push({
      ...run,
      id: run.id ?? ++this.runSeq,
      createdAt: run.createdAt ?? new Date(),
    });
  }

  async listTaskRuns(ctx: RequestContext, taskId: number): Promise<TaskRun[]> {
    const t = this.tasks.get(taskId);
    if (!t || !this.canSeeTask(ctx, t)) return [];
    return this.runs
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
      .map((r) => ({ ...r }));
  }

  async createTenant(tenant: Tenant): Promise<void> {
    this.tenants.set(tenant.id, { ...tenant });
  }

  async listTenants(): Promise<Tenant[]> {
    return [...this.tenants.values()];
  }

  async createUser(user: NewUser): Promise<User> {
    // 确定性 id（便于测试与排查）；墓碑改名后重建同名用户时追加序号保证唯一。
    const base = `u_${user.tenantId}_${user.username}`;
    const taken = new Set([...this.users.values()].map((u) => u.id));
    let id = base;
    while (taken.has(id)) id = `${base}_${++this.userSeq}`;
    const rec: UserWithSecret = {
      id,
      tenantId: user.tenantId,
      username: user.username,
      role: user.role,
      status: 'active',
      authProvider: user.authProvider ?? 'local',
      displayName: user.displayName,
      createdAt: new Date().toISOString(),
      passwordHash: user.passwordHash,
    };
    this.users.set(`${user.tenantId}/${user.username}`, rec);
    const { passwordHash: _omit, ...pub } = rec;
    return pub;
  }

  async getUserByUsername(tenantId: string, username: string): Promise<UserWithSecret | undefined> {
    const u = this.users.get(`${tenantId}/${username}`);
    return u ? { ...u } : undefined;
  }

  async getUser(tenantId: string, userId: string): Promise<User | undefined> {
    for (const u of this.users.values()) {
      if (u.tenantId === tenantId && u.id === userId) {
        const { passwordHash: _omit, ...pub } = u;
        return pub;
      }
    }
    return undefined;
  }

  async listUsers(tenantId: string): Promise<User[]> {
    return [...this.users.values()]
      .filter((u) => u.tenantId === tenantId)
      .map(({ passwordHash: _omit, ...pub }) => ({ ...pub }));
  }

  async updateUser(tenantId: string, userId: string, patch: UserPatch): Promise<User | undefined> {
    for (const [key, u] of this.users.entries()) {
      if (u.tenantId !== tenantId || u.id !== userId) continue;
      if (patch.status !== undefined) u.status = patch.status;
      if (patch.role !== undefined) u.role = patch.role;
      if (patch.displayName !== undefined) u.displayName = patch.displayName;
      if (patch.homeDir !== undefined) u.homeDir = patch.homeDir ?? undefined;
      if (patch.username !== undefined && patch.username !== u.username) {
        // username 是 Map 键的一部分（墓碑改名需重挂）。
        this.users.delete(key);
        u.username = patch.username;
        this.users.set(`${u.tenantId}/${u.username}`, u);
      }
      const { passwordHash: _omit, ...pub } = u;
      return { ...pub };
    }
    return undefined;
  }

  async disableTasksByUser(tenantId: string, userId: string): Promise<number> {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.tenantId === tenantId && t.userId === userId && t.enabled) {
        t.enabled = false;
        n++;
      }
    }
    return n;
  }

  async setUserCredential(tenantId: string, userId: string, provider: string, record: UserCredentialRecord): Promise<void> {
    this.credentials.set(`${tenantId}/${userId}/${provider}`, { ...record });
  }

  async getUserCredential(tenantId: string, userId: string, provider: string): Promise<UserCredentialRecord | undefined> {
    const rec = this.credentials.get(`${tenantId}/${userId}/${provider}`);
    return rec ? { ...rec } : undefined;
  }

  async deleteUserCredentials(tenantId: string, userId: string): Promise<void> {
    const prefix = `${tenantId}/${userId}/`;
    for (const key of this.credentials.keys()) {
      if (key.startsWith(prefix)) this.credentials.delete(key);
    }
  }

  async getLlmSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<LlmSettings | undefined> {
    const settings = this.llmSettings.get(ctx.tenantId);
    return settings ? { ...settings } : undefined;
  }

  async setLlmSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: LlmSettings): Promise<void> {
    this.llmSettings.set(ctx.tenantId, { ...settings });
  }

  async getSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<SchedulerSettings | undefined> {
    const settings = this.schedulerSettings.get(ctx.tenantId);
    return settings ? { ...settings } : undefined;
  }

  async getSandboxSettingsRecord(ctx: Pick<RequestContext, 'tenantId'>): Promise<SandboxSettingsRecord | undefined> {
    const record = this.sandboxSettings.get(ctx.tenantId);
    return record ? structuredClone(record) : undefined;
  }

  async setSandboxSettingsRecord(
    ctx: Pick<RequestContext, 'tenantId'>,
    settings: SandboxSettings,
    secret: SandboxSettingsSecretUpdate,
  ): Promise<void> {
    const current = this.sandboxSettings.get(ctx.tenantId);
    const next: SandboxSettingsRecord = { settings: structuredClone(settings) };
    if (secret.action === 'replace') next.encryptedApiKey = secret.encryptedApiKey;
    if (secret.action === 'retain') {
      if (current?.encryptedApiKey) next.encryptedApiKey = current.encryptedApiKey;
    }
    this.sandboxSettings.set(ctx.tenantId, next);
  }

  async setSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: SchedulerSettings): Promise<void> {
    this.schedulerSettings.set(ctx.tenantId, { ...settings });
  }

  async getMcpServers(ctx: Pick<RequestContext, 'tenantId'>): Promise<Record<string, McpServerConfig> | undefined> {
    const servers = this.mcpServers.get(ctx.tenantId);
    return servers ? structuredClone(servers) : undefined;
  }

  async setMcpServers(ctx: Pick<RequestContext, 'tenantId'>, servers: Record<string, McpServerConfig>): Promise<void> {
    this.mcpServers.set(ctx.tenantId, structuredClone(servers));
  }

  async close(): Promise<void> {
    this.messages = [];
    this.sessions.clear();
    this.audit = [];
    this.tasks.clear();
    this.runs = [];
    this.runSeq = 0;
    this.tenants.clear();
    this.users.clear();
    this.credentials.clear();
    this.llmSettings.clear();
    this.schedulerSettings.clear();
    this.sandboxSettings.clear();
    this.mcpServers.clear();
    this.durableStore = new MemoryRunStore();
    this.toolExecutions.clear();
    this.agentRunBindings.clear();
    this.agentRunEvents = [];
    this.agentRunEventSeq = 0;
  }
}

function canReadAgentRun(ctx: RequestContext, record: AgentRunRecord): boolean {
  if (record.tenantId !== ctx.tenantId) return false;
  return ctx.role === 'platform_admin' || ctx.role === 'tenant_admin' || record.userId === ctx.userId;
}

function toRuntimeInteraction(record: InteractionRecord): RuntimeInteractionRecord {
  return {
    ...structuredClone(record),
    attemptId: record.attemptId ?? '',
    turnNo: record.turnNo ?? 0,
    payload: structuredClone(record.payload) as JsonValue,
    resolution: record.resolution === undefined ? undefined : structuredClone(record.resolution) as JsonValue,
  };
}

function fromRuntimeInteraction(record: RuntimeInteractionRecord): InteractionRecord {
  return {
    ...structuredClone(record),
    userId: record.userId ?? '',
    sessionId: record.sessionId ?? '',
    attemptId: record.attemptId || undefined,
    turnNo: record.turnNo || undefined,
    expiresAt: record.expiresAt ?? new Date('9999-12-31T23:59:59.999Z'),
  };
}

function toolExecutionKey(tenantId: string, runId: string, toolCallId: string): string {
  return `${tenantId}/${runId}/${toolCallId}`;
}

function cloneToolExecution(record: ToolExecutionRecord): ToolExecutionRecord {
  return structuredClone(record);
}

function fromStoredRun(run: StoredRun): AgentRunRecord {
  return {
    tenantId: run.tenantId, runId: run.runId, userId: run.actorId, sessionId: run.sessionId,
    kernel: 'pi', kernelVersion: run.kernelVersion, status: run.status,
    waitingReason: run.waitingReason, currentNode: run.currentNode, stepCount: run.stepCount ?? run.lastTurnNo,
    usage: structuredClone(run.usage), errorMessage: run.errorMessage, startedAt: run.startedAt,
    updatedAt: new Date(run.updatedAt), completedAt: run.completedAt,
    cancelRequestedAt: run.cancelRequestedAt, leaseOwner: run.leaseOwner,
    leaseToken: Number(run.leaseToken), leaseExpiresAt: run.leaseExpiresAt, createdAt: new Date(run.createdAt),
  };
}

function productPatch(patch: AgentRunPatch): Partial<StoredRun> {
  return {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.waitingReason !== undefined ? { waitingReason: patch.waitingReason ?? undefined } : {}),
    ...(patch.currentNode !== undefined ? { currentNode: patch.currentNode ?? undefined } : {}),
    ...(patch.stepCount !== undefined ? { stepCount: patch.stepCount } : {}),
    ...(patch.usage ? { usage: structuredClone(patch.usage) } : {}),
    ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage ?? undefined } : {}),
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt ?? undefined } : {}),
    updatedAt: patch.updatedAt ?? new Date(),
    ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt ?? undefined } : {}),
    ...(patch.cancelRequestedAt !== undefined ? { cancelRequestedAt: patch.cancelRequestedAt ?? undefined } : {}),
    ...(patch.clearLease ? { leaseOwner: undefined, leaseExpiresAt: undefined } : {}),
  };
}

function fromDurableToolLedger(record: DurableToolLedgerUpdate): ToolExecutionRecord {
  return {
    tenantId: record.tenantId, runId: record.runId, sessionId: '', attemptId: record.attemptId,
    turnNo: record.turnNo, toolCallId: record.toolCallId, logicalCallId: record.logicalCallId,
    idempotencyKey: record.idempotencyKey, capability: record.capability,
    externalCorrelationId: record.externalCorrelationId, resultDigest: record.resultDigest,
    approvedInteractionId: record.approvedInteractionId, toolName: record.toolName,
    argsDigest: record.argsDigest, status: record.status === 'pending_approval' ? 'started' : record.status,
    result: record.result ? {
      id: record.result.callId, content: record.result.content, isError: record.result.isError,
    } : undefined,
    startedAt: record.createdAt,
    completedAt: record.status === 'completed' ? record.updatedAt : undefined,
    updatedAt: record.updatedAt,
  };
}
