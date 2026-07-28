import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Msg, Role as MsgRole } from '../model/types.js';
import type { AuditEvent } from '../audit/sink.js';
import type { RequestContext, Role, Tenant, User } from '../auth/types.js';
import type { Database } from './schema.js';
import type {
  AuditFilter,
  LlmSettings,
  NewUser,
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
  AgentRunUsage,
  InteractionKind,
  InteractionStatus,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskPatch,
  Store,
  TaskRun,
  ToolExecutionRecord,
  ToolExecutionStatus,
  UserCredentialRecord,
  UserPatch,
  UserWithSecret,
} from './store.js';
import { DEFAULT_SESSION_TITLE } from './store.js';
import { McpServerSchema } from '../config/schema.js';
import type { McpServerConfig } from '../mcp/types.js';
import { nextRunAt } from '../scheduler/cron.js';
import { estimateTokens } from '../agent/context.js';
import { parseStoredSandboxSettings } from '../sandbox/settings.js';
import { MysqlRuntimeStore, type RuntimeMysqlDatabase } from '@aiop/agent-runtime-mysql';

interface TaskRow {
  id: number;
  tenant_id: string;
  user_id: string;
  session_id: string;
  title: string;
  cron: string;
  task: string;
  pre_approved: number;
  enabled: number;
  next_run_at: Date;
  last_run_at: Date | null;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: unknown;
  created_at: Date | string;
}

interface StoredSessionRow {
  session_id: string;
  title: string;
  updated_at: Date | string;
}

function toTask(r: TaskRow): ScheduledTask {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    sessionId: r.session_id,
    cron: r.cron,
    title: r.title ?? '',
    task: r.task,
    preApproved: Boolean(r.pre_approved),
    enabled: Boolean(r.enabled),
    nextRunAt: new Date(r.next_run_at),
    lastRunAt: r.last_run_at ? new Date(r.last_run_at) : undefined,
  };
}

/** mysql2 对 JSON 列读出已是对象；写入是字符串。统一归一化。 */
function parseJson(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return v;
}

function summarize(text: string | undefined, max = 48): string {
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toOptionalDate(value: Date | string | null): Date | undefined {
  return value === null ? undefined : toDate(value);
}

function piKernel(value: string): 'pi' {
  if (value !== 'pi') throw new Error(`Unexpected retired Agent Kernel in database: ${value}`);
  return 'pi';
}

function toAgentRun(row: Selectable<Database['agent_runs']>): AgentRunRecord {
  return {
    tenantId: row.tenant_id,
    runId: row.run_id,
    userId: row.user_id,
    sessionId: row.session_id,
    kernel: piKernel(row.kernel),
    kernelVersion: row.kernel_version,
    runtimeVersion: row.runtime_version,
    graphName: row.graph_name,
    graphVersion: row.graph_version,
    status: row.status as AgentRunRecord['status'],
    waitingReason: row.waiting_reason as AgentRunRecord['waitingReason'] ?? undefined,
    currentNode: row.current_node ?? undefined,
    stepCount: row.step_count,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
    },
    errorMessage: row.error_message ?? undefined,
    startedAt: toOptionalDate(row.started_at),
    updatedAt: toDate(row.updated_at),
    completedAt: toOptionalDate(row.completed_at),
    cancelRequestedAt: toOptionalDate(row.cancel_requested_at),
    leaseOwner: row.lease_owner ?? undefined,
    leaseToken: Number(row.lease_token),
    leaseExpiresAt: toOptionalDate(row.lease_expires_at),
    createdAt: toDate(row.created_at),
  };
}

/** Msg -> messages.content JSON（含多模态内容块，回读时原样还原）。 */
function serializeMsgContent(msg: Msg): string {
  return JSON.stringify({
    text: msg.text,
    thinking: msg.thinking,
    durationMs: msg.durationMs,
    toolCalls: msg.toolCalls,
    toolResults: msg.toolResults,
    contentBlocks: msg.contentBlocks,
  });
}

function parseLlmSettings(value: unknown): LlmSettings | undefined {
  const v = parseJson(value);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== 'string'
    || (o.protocol !== 'anthropic' && o.protocol !== 'openai')
    || typeof o.baseURL !== 'string'
    || typeof o.apiKey !== 'string'
    || typeof o.model !== 'string'
  ) {
    return undefined;
  }
  const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  return {
    id: o.id,
    protocol: o.protocol,
    baseURL: o.baseURL,
    apiKey: o.apiKey,
    model: o.model,
    ...(typeof o.contextWindowTokens === 'number' && Number.isFinite(o.contextWindowTokens) && o.contextWindowTokens > 0
      ? { contextWindowTokens: Math.floor(o.contextWindowTokens) }
      : {}),
    ...(typeof o.contextKeepImages === 'number' && Number.isFinite(o.contextKeepImages) && o.contextKeepImages >= 0
      ? { contextKeepImages: Math.floor(o.contextKeepImages) }
      : {}),
    ...(typeof o.effort === 'string' && efforts.includes(o.effort)
      ? { effort: o.effort as LlmSettings['effort'] }
      : {}),
  };
}

function parseMcpServers(value: unknown): Record<string, McpServerConfig> | undefined {
  const v = parseJson(value);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
    const parsed = McpServerSchema.safeParse(raw);
    if (parsed.success) out[name] = parsed.data;
  }
  return out;
}

function parseSchedulerSettings(value: unknown): SchedulerSettings | undefined {
  const v = parseJson(value);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.maxRunMs !== 'number' || !Number.isFinite(o.maxRunMs) || o.maxRunMs <= 0) return undefined;
  return { maxRunMs: Math.floor(o.maxRunMs) };
}

/** 基于 Kysely + mysql2 的持久化实现（租户由 ctx 强制过滤）。 */
export class MysqlStore implements Store {
  constructor(private readonly db: Kysely<Database>) {}

  database(): Kysely<Database> {
    return this.db;
  }

  agentRuntimeStore() {
    return new MysqlRuntimeStore(this.db as unknown as Kysely<RuntimeMysqlDatabase>);
  }

  async createSession(ctx: RequestContext, input: SessionInput): Promise<SessionSummary> {
    const title = summarize(input.title ?? input.sessionId);
    const now = new Date();
    // upsert：并发下先查后写会撞唯一键；主键含 user_id，不同用户同名会话互不冲突
    await this.db
      .insertInto('sessions')
      .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: input.sessionId, title, updated_at: now })
      .onDuplicateKeyUpdate({ title, updated_at: now })
      .execute();

    // 只取条数 + 最后一条，避免为拼摘要加载整段历史（大会话含截图时很重）
    const { rows } = await sql<{ total: number | string | bigint }>`
      SELECT COUNT(*) AS total FROM messages
      WHERE tenant_id = ${ctx.tenantId} AND user_id = ${ctx.userId} AND session_id = ${input.sessionId}
    `.execute(this.db);
    const last = await this.db
      .selectFrom('messages')
      .select(['content'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .where('session_id', '=', input.sessionId)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const lastText = last ? ((parseJson(last.content) ?? {}) as { text?: string }).text : undefined;
    return {
      sessionId: input.sessionId,
      title,
      lastMessage: summarize(lastText),
      messageCount: Number(rows[0]?.total ?? 0),
      updatedAt: now.toISOString(),
    };
  }

  async touchSession(ctx: RequestContext, sessionId: string, input: SessionTouchInput = {}): Promise<void> {
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : new Date();
    const nextTitle = input.title ? summarize(input.title) : undefined;
    await this.db
      .insertInto('sessions')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        session_id: sessionId,
        title: nextTitle ?? summarize(sessionId),
        updated_at: updatedAt,
      })
      .onDuplicateKeyUpdate({
        updated_at: updatedAt,
        // 仅当现有标题是占位（空 / sessionId / 默认“新会话”）时才覆盖：
        // 首条用户消息可为新会话命名，之后不再改名。
        ...(nextTitle
          ? {
              title: sql<string>`IF(title = '' OR title = ${sessionId} OR title = ${DEFAULT_SESSION_TITLE}, ${nextTitle}, title)`,
            }
          : {}),
      })
      .execute();
  }

  async appendMessage(ctx: RequestContext, sessionId: string, msg: Msg): Promise<void> {
    const content = serializeMsgContent(msg);
    await this.db
      .insertInto('messages')
      .values({ tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: sessionId, role: msg.role, content })
      .execute();
    await this.touchSession(ctx, sessionId, {
      title: msg.role === 'user' ? msg.text : undefined,
      updatedAt: new Date(),
    });
  }

  async appendMessages(ctx: RequestContext, sessionId: string, msgs: Msg[]): Promise<void> {
    if (!msgs.length) return;
    await this.db
      .insertInto('messages')
      .values(
        msgs.map((msg) => ({
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          session_id: sessionId,
          role: msg.role,
          content: serializeMsgContent(msg),
        })),
      )
      .execute();
    await this.touchSession(ctx, sessionId, {
      title: msgs.find((m) => m.role === 'user' && m.text)?.text,
      updatedAt: new Date(),
    });
  }

  async replaceMessages(ctx: RequestContext, sessionId: string, messages: Msg[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('messages')
        .where('tenant_id', '=', ctx.tenantId)
        .where('user_id', '=', ctx.userId)
        .where('session_id', '=', sessionId)
        .execute();
      if (!messages.length) return;
      await trx
        .insertInto('messages')
        .values(
          messages.map((msg) => ({
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            session_id: sessionId,
            role: msg.role,
            content: serializeMsgContent(msg),
          })),
        )
        .execute();
    });
  }

  async listMessages(ctx: RequestContext, sessionId: string): Promise<Msg[]> {
    const rows = await this.db
      .selectFrom('messages')
      .select(['role', 'content'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .where('session_id', '=', sessionId)
      .orderBy('id', 'asc')
      .execute();

    return rows.map((r): Msg => {
      const c = (parseJson(r.content) ?? {}) as Partial<Msg>;
      return {
        role: r.role as MsgRole,
        text: c.text,
        thinking: c.thinking,
        durationMs: typeof c.durationMs === 'number' && Number.isFinite(c.durationMs) && c.durationMs >= 0
          ? c.durationMs
          : undefined,
        toolCalls: c.toolCalls,
        toolResults: c.toolResults,
        contentBlocks: c.contentBlocks,
      };
    });
  }

  async listSessions(ctx: RequestContext, limit = 50, offset = 0): Promise<SessionSummary[]> {
    const safeLimit = Math.max(0, limit);
    const safeOffset = Math.max(0, offset);
    if (safeLimit <= 0) return [];

    const sessionRows = await this.db
      .selectFrom('sessions')
      .select(['session_id', 'title', 'updated_at'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .orderBy('updated_at', 'desc')
      .limit(safeLimit)
      .offset(safeOffset)
      .execute() as StoredSessionRow[];
    const sessionIds = sessionRows.map((row) => row.session_id);
    if (!sessionIds.length) return [];

    const rows = await this.db
      .selectFrom('messages')
      .select(['id', 'session_id', 'role', 'content', 'created_at'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .where('session_id', 'in', sessionIds)
      .execute() as MessageRow[];
    rows.sort((a, b) => a.id - b.id);

    const grouped = new Map<string, Array<{ role: string; text?: string; createdAt: Date }>>();
    for (const row of rows) {
      const content = (parseJson(row.content) ?? {}) as Partial<Msg>;
      const items = grouped.get(row.session_id) ?? [];
      items.push({
        role: row.role,
        text: content.text,
        createdAt: toDate(row.created_at),
      });
      grouped.set(row.session_id, items);
    }

    return sessionRows.map((session) => {
        const items = grouped.get(session.session_id) ?? [];
        const firstUser = items.find((m) => m.role === 'user' && m.text)?.text;
        const last = items.at(-1);
        return {
          sessionId: session.session_id,
          title: session.title || summarize(firstUser ?? items[0]?.text ?? session.session_id),
          lastMessage: summarize(last?.text),
          messageCount: items.length,
          updatedAt: toDate(session.updated_at).toISOString(),
        };
      });
  }

  async countSessions(ctx: RequestContext): Promise<number> {
    const { rows } = await sql<{ total: number | string | bigint }>`
      SELECT COUNT(*) AS total
      FROM sessions
      WHERE tenant_id = ${ctx.tenantId} AND user_id = ${ctx.userId}
    `.execute(this.db);
    return Number(rows[0]?.total ?? 0);
  }

  async deleteSession(ctx: RequestContext, sessionId: string): Promise<boolean> {
    const messageResult = await this.db
      .deleteFrom('messages')
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    const sessionResult = await this.db
      .deleteFrom('sessions')
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return Number(messageResult.numDeletedRows ?? 0) > 0 || Number(sessionResult.numDeletedRows ?? 0) > 0;
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
    const rows = await this.db
      .selectFrom('audit_events')
      .select('detail')
      .where('tenant_id', '=', ctx.tenantId)
      .where('session_id', '=', sessionId)
      .where('kind', '=', 'usage')
      .where('action', '=', 'agent')
      .execute();
    const totalTokens = rows.reduce((total, row) => {
      const detail = parseJson(row.detail);
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return total;
      const record = detail as Record<string, unknown>;
      const inputTokens = typeof record.inputTokens === 'number' ? record.inputTokens : 0;
      const outputTokens = typeof record.outputTokens === 'number' ? record.outputTokens : 0;
      return total + Math.max(0, inputTokens) + Math.max(0, outputTokens);
    }, 0);
    return { totalTokens };
  }

  async putInteraction(record: InteractionRecord): Promise<void> {
    await this.db.insertInto('agent_interactions').values({
      id: record.id,
      tenant_id: record.tenantId,
      user_id: record.userId,
      session_id: record.sessionId,
      run_id: record.runId,
      attempt_id: record.attemptId ?? null,
      turn_no: record.turnNo ?? null,
      kind: record.kind,
      tool_call_id: record.toolCallId ?? null,
      payload: JSON.stringify(record.payload),
      status: record.status,
      resolution: record.resolution === undefined ? null : JSON.stringify(record.resolution),
      resolved_by: record.resolvedBy ?? null,
      expires_at: record.expiresAt,
      created_at: record.createdAt,
      resolved_at: record.resolvedAt ?? null,
    }).execute();
  }

  async getInteraction(tenantId: string, id: string): Promise<InteractionRecord | undefined> {
    const row = await this.db.selectFrom('agent_interactions').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst();
    return row ? {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      sessionId: row.session_id,
      runId: row.run_id,
      kind: row.kind as InteractionKind,
      toolCallId: row.tool_call_id ?? undefined,
      payload: parseJson(row.payload),
      status: row.status as InteractionStatus,
      resolution: row.resolution === null ? undefined : parseJson(row.resolution),
      resolvedBy: row.resolved_by ?? undefined,
      expiresAt: toDate(row.expires_at),
      createdAt: toDate(row.created_at),
      resolvedAt: row.resolved_at ? toDate(row.resolved_at) : undefined,
    } : undefined;
  }

  async listPendingInteractions(ctx: RequestContext): Promise<InteractionRecord[]> {
    const rows = await this.db.selectFrom('agent_interactions').select('id')
      .where('tenant_id', '=', ctx.tenantId).where('status', '=', 'pending')
      .orderBy('created_at', 'asc').execute();
    const records = await Promise.all(rows.map((row) => this.getInteraction(ctx.tenantId, row.id)));
    return records.filter((record): record is InteractionRecord => Boolean(record));
  }

  async resolveInteraction(record: InteractionRecord): Promise<boolean> {
    const result = await this.db.updateTable('agent_interactions').set({
      status: record.status,
      resolution: record.resolution === undefined ? null : JSON.stringify(record.resolution),
      resolved_by: record.resolvedBy ?? null,
      resolved_at: record.resolvedAt ?? new Date(),
    }).where('tenant_id', '=', record.tenantId).where('id', '=', record.id)
      .where('status', '=', 'pending').executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  async putToolExecutionIfAbsent(record: ToolExecutionRecord): Promise<boolean> {
    const result = await this.db.insertInto('agent_tool_executions').values({
      tenant_id: record.tenantId,
      run_id: record.runId,
      attempt_id: record.attemptId ?? null,
      turn_no: record.turnNo ?? null,
      session_id: record.sessionId,
      tool_call_id: record.toolCallId,
      logical_call_id: record.logicalCallId ?? record.toolCallId,
      idempotency_key: record.idempotencyKey ?? `${record.tenantId}:${record.runId}:${record.toolCallId}`,
      capability: record.capability ?? 'non_idempotent_write',
      external_correlation_id: record.externalCorrelationId ?? null,
      result_digest: record.resultDigest ?? null,
      approved_interaction_id: record.approvedInteractionId ?? null,
      tool_name: record.toolName,
      args_digest: record.argsDigest,
      status: record.status,
      result: record.result === undefined ? null : JSON.stringify(record.result),
      started_at: record.startedAt,
      completed_at: record.completedAt ?? null,
      updated_at: record.updatedAt,
    }).ignore().executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async getToolExecution(tenantId: string, runId: string, toolCallId: string): Promise<ToolExecutionRecord | undefined> {
    const row = await this.db.selectFrom('agent_tool_executions').selectAll()
      .where('tenant_id', '=', tenantId).where('run_id', '=', runId)
      .where('tool_call_id', '=', toolCallId).executeTakeFirst();
    return row ? {
      tenantId: row.tenant_id,
      runId: row.run_id,
      attemptId: row.attempt_id ?? undefined,
      turnNo: row.turn_no ?? undefined,
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      logicalCallId: row.logical_call_id,
      idempotencyKey: row.idempotency_key,
      capability: row.capability as ToolExecutionRecord['capability'],
      externalCorrelationId: row.external_correlation_id ?? undefined,
      resultDigest: row.result_digest ?? undefined,
      approvedInteractionId: row.approved_interaction_id ?? undefined,
      toolName: row.tool_name,
      argsDigest: row.args_digest,
      status: row.status as ToolExecutionStatus,
      result: row.result === null ? undefined : parseJson(row.result) as ToolExecutionRecord['result'],
      startedAt: toDate(row.started_at),
      completedAt: row.completed_at ? toDate(row.completed_at) : undefined,
      updatedAt: toDate(row.updated_at),
    } : undefined;
  }

  async updateToolExecution(record: ToolExecutionRecord): Promise<void> {
    await this.db.updateTable('agent_tool_executions').set({
      status: record.status,
      result: record.result === undefined ? null : JSON.stringify(record.result),
      completed_at: record.completedAt ?? null,
      updated_at: record.updatedAt,
    }).where('tenant_id', '=', record.tenantId).where('run_id', '=', record.runId)
      .where('tool_call_id', '=', record.toolCallId).execute();
  }

  async getAgentRunBinding(tenantId: string, runId: string): Promise<AgentRunBinding | undefined> {
    const row = await this.db.selectFrom('agent_runs').selectAll()
      .where('tenant_id', '=', tenantId).where('run_id', '=', runId).executeTakeFirst();
    return row ? {
      tenantId: row.tenant_id,
      runId: row.run_id,
      userId: row.user_id,
      sessionId: row.session_id,
      kernel: piKernel(row.kernel),
      kernelVersion: row.kernel_version,
      runtimeVersion: row.runtime_version,
      graphName: row.graph_name,
      graphVersion: row.graph_version,
      createdAt: toDate(row.created_at),
    } : undefined;
  }

  async putAgentRunBindingIfAbsent(binding: AgentRunBinding): Promise<boolean> {
    const result = await this.db.insertInto('agent_runs').values({
      tenant_id: binding.tenantId,
      run_id: binding.runId,
      user_id: binding.userId,
      session_id: binding.sessionId,
      kernel: binding.kernel,
      kernel_version: binding.kernelVersion ?? `${binding.kernel}-v1`,
      graph_name: binding.graphName,
      graph_version: binding.graphVersion,
      runtime_version: binding.runtimeVersion ?? 'compat-v1',
      status: 'queued',
      waiting_reason: null,
      current_node: null,
      step_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      error_message: null,
      started_at: null,
      updated_at: binding.createdAt,
      completed_at: null,
      cancel_requested_at: null,
      lease_owner: null,
      lease_token: 0,
      lease_expires_at: null,
      created_at: binding.createdAt,
    }).ignore().executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async getAgentRun(ctx: RequestContext, runId: string): Promise<AgentRunRecord | undefined> {
    let query = this.db.selectFrom('agent_runs').selectAll()
      .where('tenant_id', '=', ctx.tenantId).where('run_id', '=', runId);
    if (ctx.role === 'user') query = query.where('user_id', '=', ctx.userId);
    const row = await query.executeTakeFirst();
    return row ? toAgentRun(row) : undefined;
  }

  async listAgentRuns(ctx: RequestContext, filter: AgentRunFilter = {}): Promise<AgentRunRecord[]> {
    let query = this.db.selectFrom('agent_runs').selectAll().where('tenant_id', '=', ctx.tenantId);
    if (ctx.role === 'user') query = query.where('user_id', '=', ctx.userId);
    if (filter.status) query = query.where('status', '=', filter.status);
    if (filter.sessionId) query = query.where('session_id', '=', filter.sessionId);
    query = query.orderBy('updated_at', 'desc').orderBy('created_at', 'desc')
      .limit(Math.max(0, filter.limit ?? 50)).offset(Math.max(0, filter.offset ?? 0));
    return (await query.execute()).map(toAgentRun);
  }

  async countAgentRuns(ctx: RequestContext, filter: AgentRunFilter = {}): Promise<number> {
    let query = this.db.selectFrom('agent_runs').select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', ctx.tenantId);
    if (ctx.role === 'user') query = query.where('user_id', '=', ctx.userId);
    if (filter.status) query = query.where('status', '=', filter.status);
    if (filter.sessionId) query = query.where('session_id', '=', filter.sessionId);
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async updateAgentRun(tenantId: string, runId: string, patch: AgentRunPatch): Promise<boolean> {
    const result = await this.db.updateTable('agent_runs').set({
      status: patch.status,
      waiting_reason: patch.waitingReason,
      current_node: patch.currentNode,
      step_count: patch.stepCount,
      input_tokens: patch.usage?.inputTokens,
      output_tokens: patch.usage?.outputTokens,
      cache_read_tokens: patch.usage?.cacheReadTokens,
      cache_creation_tokens: patch.usage?.cacheCreationTokens,
      error_message: patch.errorMessage,
      started_at: patch.startedAt,
      updated_at: patch.updatedAt ?? new Date(),
      completed_at: patch.completedAt,
      cancel_requested_at: patch.cancelRequestedAt,
      ...(patch.clearLease ? { lease_owner: null, lease_expires_at: null } : {}),
    }).where('tenant_id', '=', tenantId).where('run_id', '=', runId).executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  async appendAgentRunEvent(event: AgentRunEvent): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction.selectFrom('agent_runs').select('lease_token')
        .where('tenant_id', '=', event.tenantId).where('run_id', '=', event.runId)
        .forUpdate().executeTakeFirstOrThrow();
      const last = await transaction.selectFrom('agent_run_events')
        .select(({ fn }) => fn.max<number>('sequence').as('sequence'))
        .where('tenant_id', '=', event.tenantId).where('run_id', '=', event.runId).executeTakeFirst();
      await transaction.insertInto('agent_run_events').values({
        tenant_id: event.tenantId,
        run_id: event.runId,
        sequence: event.sequence ?? Number(last?.sequence ?? 0) + 1,
        attempt_id: event.attemptId ?? null,
        turn_no: event.turnNo ?? null,
        kernel: event.kernel ?? null,
        kernel_version: event.kernelVersion ?? null,
        correlation_id: event.correlationId ?? null,
        event_type: event.type,
        node_name: event.node ?? null,
        status: event.status ?? null,
        detail: event.detail === undefined ? null : JSON.stringify(event.detail),
        created_at: event.createdAt,
      }).execute();
    });
  }

  async listAgentRunEvents(ctx: RequestContext, runId: string): Promise<AgentRunEvent[]> {
    if (!await this.getAgentRun(ctx, runId)) return [];
    const rows = await this.db.selectFrom('agent_run_events').selectAll()
      .where('tenant_id', '=', ctx.tenantId).where('run_id', '=', runId).orderBy('id', 'asc').execute();
    return rows.map((row) => ({
      id: Number(row.id), tenantId: row.tenant_id, runId: row.run_id, sequence: Number(row.sequence), type: row.event_type,
      attemptId: row.attempt_id ?? undefined, turnNo: row.turn_no ?? undefined,
      kernel: row.kernel === 'pi' ? 'pi' : undefined,
      kernelVersion: row.kernel_version ?? undefined, correlationId: row.correlation_id ?? undefined,
      node: row.node_name ?? undefined, status: row.status ?? undefined,
      detail: parseJson(row.detail), createdAt: toDate(row.created_at),
    }));
  }

  async listAgentRunAttempts(ctx: RequestContext, runId: string) {
    if (!await this.getAgentRun(ctx, runId)) return [];
    const rows = await this.db.selectFrom('agent_run_attempts').selectAll()
      .where('tenant_id', '=', ctx.tenantId).where('run_id', '=', runId).orderBy('started_at', 'asc').execute();
    return rows.map((row) => ({
      attemptId: row.attempt_id,
      kernel: row.kernel,
      kernelVersion: row.kernel_version,
      status: row.status,
      errorCode: row.error_code ?? undefined,
      startedAt: toDate(row.started_at),
      completedAt: row.completed_at ? toDate(row.completed_at) : undefined,
    }));
  }

  async listAgentRunTurns(ctx: RequestContext, runId: string) {
    if (!await this.getAgentRun(ctx, runId)) return [];
    const rows = await this.db.selectFrom('agent_turn_commits').selectAll()
      .where('tenant_id', '=', ctx.tenantId).where('run_id', '=', runId).orderBy('transcript_version', 'asc').execute();
    return rows.map((row) => ({
      attemptId: row.attempt_id,
      turnNo: row.turn_no,
      commitId: row.commit_id,
      transcriptVersion: row.transcript_version,
      stopReason: row.stop_reason ?? undefined,
      usage: parseJson(row.usage_json) as AgentRunUsage,
      eventSequenceEnd: row.event_sequence_end,
      committedAt: toDate(row.committed_at),
    }));
  }

  async listAgentRunInteractions(ctx: RequestContext, runId: string): Promise<InteractionRecord[]> {
    if (!await this.getAgentRun(ctx, runId)) return [];
    const rows = await this.db.selectFrom('agent_interactions').selectAll()
      .where('tenant_id', '=', ctx.tenantId).where('run_id', '=', runId).orderBy('created_at', 'asc').execute();
    return rows.map((row) => ({
      id: row.id, tenantId: row.tenant_id, userId: row.user_id, sessionId: row.session_id, runId: row.run_id,
      kind: row.kind as InteractionKind, toolCallId: row.tool_call_id ?? undefined, payload: parseJson(row.payload),
      status: row.status as InteractionStatus, resolution: row.resolution === null ? undefined : parseJson(row.resolution),
      resolvedBy: row.resolved_by ?? undefined, expiresAt: toDate(row.expires_at), createdAt: toDate(row.created_at),
      resolvedAt: row.resolved_at ? toDate(row.resolved_at) : undefined,
    }));
  }

  async listAgentRunToolExecutions(ctx: RequestContext, runId: string): Promise<ToolExecutionRecord[]> {
    if (!await this.getAgentRun(ctx, runId)) return [];
    const rows = await this.db.selectFrom('agent_tool_executions').selectAll()
      .where('tenant_id', '=', ctx.tenantId).where('run_id', '=', runId).orderBy('started_at', 'asc').execute();
    return rows.map((row) => ({
      tenantId: row.tenant_id, runId: row.run_id, sessionId: row.session_id,
      attemptId: row.attempt_id ?? undefined, turnNo: row.turn_no ?? undefined,
      toolCallId: row.tool_call_id, logicalCallId: row.logical_call_id, idempotencyKey: row.idempotency_key,
      capability: row.capability as ToolExecutionRecord['capability'],
      externalCorrelationId: row.external_correlation_id ?? undefined, resultDigest: row.result_digest ?? undefined,
      approvedInteractionId: row.approved_interaction_id ?? undefined,
      toolName: row.tool_name, argsDigest: row.args_digest,
      status: row.status as ToolExecutionStatus,
      result: row.result === null ? undefined : parseJson(row.result) as ToolExecutionRecord['result'],
      startedAt: toDate(row.started_at), completedAt: row.completed_at ? toDate(row.completed_at) : undefined,
      updatedAt: toDate(row.updated_at),
    }));
  }

  async acquireAgentRunLease(
    tenantId: string, runId: string, ownerId: string, now: Date, ttlMs: number,
  ): Promise<AgentRunLease | undefined> {
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction.selectFrom('agent_runs').selectAll()
        .where('tenant_id', '=', tenantId).where('run_id', '=', runId).forUpdate().executeTakeFirst();
      if (!row) return undefined;
      const expiresAt = row.lease_expires_at ? toDate(row.lease_expires_at) : undefined;
      if (row.lease_owner && expiresAt && expiresAt.getTime() > now.getTime() && row.lease_owner !== ownerId) {
        return undefined;
      }
      const token = row.lease_owner === ownerId && expiresAt && expiresAt.getTime() > now.getTime()
        ? Number(row.lease_token)
        : Number(row.lease_token) + 1;
      const nextExpiry = new Date(now.getTime() + ttlMs);
      await transaction.updateTable('agent_runs').set({
        lease_owner: ownerId, lease_token: token, lease_expires_at: nextExpiry, updated_at: now,
      }).where('tenant_id', '=', tenantId).where('run_id', '=', runId).execute();
      return { ownerId, token, expiresAt: nextExpiry };
    });
  }

  async renewAgentRunLease(
    tenantId: string, runId: string, ownerId: string, token: number, now: Date, ttlMs: number,
  ): Promise<boolean> {
    const result = await this.db.updateTable('agent_runs').set({
      lease_expires_at: new Date(now.getTime() + ttlMs), updated_at: now,
    }).where('tenant_id', '=', tenantId).where('run_id', '=', runId)
      .where('lease_owner', '=', ownerId).where('lease_token', '=', token).executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  async assertAgentRunLease(
    tenantId: string, runId: string, ownerId: string, token: number, now = new Date(),
  ): Promise<void> {
    const row = await this.db.selectFrom('agent_runs').select(['lease_owner', 'lease_token', 'lease_expires_at'])
      .where('tenant_id', '=', tenantId).where('run_id', '=', runId).executeTakeFirst();
    if (!row || row.lease_owner !== ownerId || Number(row.lease_token) !== token
      || !row.lease_expires_at || toDate(row.lease_expires_at).getTime() <= now.getTime()) {
      throw new Error('Agent run lease lost');
    }
  }

  async releaseAgentRunLease(tenantId: string, runId: string, ownerId: string, token: number): Promise<boolean> {
    const result = await this.db.updateTable('agent_runs').set({
      lease_owner: null, lease_expires_at: null, updated_at: new Date(),
    }).where('tenant_id', '=', tenantId).where('run_id', '=', runId)
      .where('lease_owner', '=', ownerId).where('lease_token', '=', token).executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  async requestAgentRunCancellation(ctx: RequestContext, runId: string, now = new Date()): Promise<boolean> {
    let query = this.db.updateTable('agent_runs').set({ cancel_requested_at: now, updated_at: now })
      .where('tenant_id', '=', ctx.tenantId).where('run_id', '=', runId);
    if (ctx.role === 'user') query = query.where('user_id', '=', ctx.userId);
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  async isAgentRunCancellationRequested(tenantId: string, runId: string): Promise<boolean> {
    const row = await this.db.selectFrom('agent_runs').select('cancel_requested_at')
      .where('tenant_id', '=', tenantId).where('run_id', '=', runId).executeTakeFirst();
    return Boolean(row?.cancel_requested_at);
  }

  async record(event: AuditEvent): Promise<void> {
    await this.db
      .insertInto('audit_events')
      .values({
        tenant_id: event.tenantId ?? null,
        kind: event.kind,
        action: event.action,
        session_id: event.sessionId ?? null,
        cluster: event.cluster ?? null,
        tool: event.tool ?? null,
        detail: event.detail ? JSON.stringify(event.detail) : null,
      })
      .execute();
  }

  async listAudit(ctx: RequestContext, filter: AuditFilter = {}): Promise<AuditEvent[]> {
    let q = this.db
      .selectFrom('audit_events')
      .select(['tenant_id', 'kind', 'action', 'session_id', 'cluster', 'tool', 'detail', 'created_at'])
      .where('tenant_id', '=', ctx.tenantId)
      .orderBy('id', 'asc');
    if (filter.sessionId) q = q.where('session_id', '=', filter.sessionId);
    if (filter.kind) q = q.where('kind', '=', filter.kind);
    if (filter.limit) q = q.limit(filter.limit);

    const rows = await q.execute();
    return rows.map((r): AuditEvent => ({
      tenantId: r.tenant_id ?? undefined,
      kind: r.kind as AuditEvent['kind'],
      action: r.action,
      sessionId: r.session_id ?? undefined,
      cluster: r.cluster ?? undefined,
      tool: r.tool ?? undefined,
      detail: (parseJson(r.detail) as Record<string, unknown> | undefined) ?? undefined,
      at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  async createScheduledTask(ctx: RequestContext, input: ScheduledTaskInput): Promise<ScheduledTask> {
    const next = nextRunAt(input.cron, new Date());
    const res = await this.db
      .insertInto('scheduled_tasks')
      .values({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        session_id: input.sessionId,
        cron: input.cron,
        title: input.title ?? '',
        task: input.task,
        pre_approved: input.preApproved ? 1 : 0,
        enabled: input.enabled === false ? 0 : 1,
        next_run_at: next,
      })
      .executeTakeFirstOrThrow();
    return {
      id: Number(res.insertId),
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: input.sessionId,
      cron: input.cron,
      title: input.title ?? '',
      task: input.task,
      preApproved: input.preApproved ?? false,
      enabled: input.enabled ?? true,
      nextRunAt: next,
    };
  }

  // 任务可见范围：普通用户仅见自己创建的；租户/平台管理员见全租户。
  async listScheduledTasks(ctx: RequestContext): Promise<ScheduledTask[]> {
    let q = this.db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId);
    if (ctx.role === 'user') q = q.where('user_id', '=', ctx.userId);
    const rows = await q.orderBy('id', 'asc').execute();
    return rows.map(toTask);
  }

  async setTaskEnabled(ctx: RequestContext, id: number, enabled: boolean): Promise<void> {
    let q = this.db
      .updateTable('scheduled_tasks')
      .set({ enabled: enabled ? 1 : 0 })
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId);
    if (ctx.role === 'user') q = q.where('user_id', '=', ctx.userId);
    await q.execute();
  }

  async getScheduledTask(ctx: RequestContext, id: number): Promise<ScheduledTask | undefined> {
    let q = this.db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId);
    if (ctx.role === 'user') q = q.where('user_id', '=', ctx.userId);
    const row = await q.executeTakeFirst();
    return row ? toTask(row) : undefined;
  }

  async updateScheduledTask(ctx: RequestContext, id: number, patch: ScheduledTaskPatch): Promise<ScheduledTask | undefined> {
    const current = await this.getScheduledTask(ctx, id);
    if (!current) return undefined;
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.task !== undefined) set.task = patch.task;
    if (patch.preApproved !== undefined) set.pre_approved = patch.preApproved ? 1 : 0;
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    if (patch.cron !== undefined && patch.cron !== current.cron) {
      set.cron = patch.cron;
      set.next_run_at = nextRunAt(patch.cron, new Date());
    }
    if (Object.keys(set).length) {
      await this.db
        .updateTable('scheduled_tasks')
        .set(set)
        .where('id', '=', id)
        .where('tenant_id', '=', ctx.tenantId)
        .execute();
    }
    return this.getScheduledTask(ctx, id);
  }

  async deleteScheduledTask(ctx: RequestContext, id: number): Promise<boolean> {
    let q = this.db
      .deleteFrom('scheduled_tasks')
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId);
    if (ctx.role === 'user') q = q.where('user_id', '=', ctx.userId);
    const res = await q.executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return false;
    await this.db.deleteFrom('task_runs').where('task_id', '=', id).execute();
    return true;
  }

  /** 系统级：事务内 FOR UPDATE SKIP LOCKED 领取并推进，保证多副本不重复执行。 */
  async claimDueTasks(now: Date, limit: number): Promise<ScheduledTask[]> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('scheduled_tasks')
        .selectAll()
        .where('enabled', '=', 1)
        .where('next_run_at', '<=', now)
        .orderBy('next_run_at', 'asc')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();

      const tasks = rows.map(toTask);
      for (const t of tasks) {
        await trx
          .updateTable('scheduled_tasks')
          .set({ last_run_at: now, next_run_at: nextRunAt(t.cron, now) })
          .where('id', '=', t.id)
          .execute();
      }
      return tasks;
    });
  }

  async recordTaskRun(run: TaskRun): Promise<void> {
    await this.db
      .insertInto('task_runs')
      .values({
        task_id: run.taskId,
        status: run.status,
        detail: run.detail ?? null,
        steps: run.steps ?? null,
      })
      .execute();
  }

  async listTaskRuns(ctx: RequestContext, taskId: number): Promise<TaskRun[]> {
    let q = this.db
      .selectFrom('task_runs')
      .innerJoin('scheduled_tasks', 'scheduled_tasks.id', 'task_runs.task_id')
      .select([
        'task_runs.id as id',
        'task_runs.task_id as task_id',
        'task_runs.status as status',
        'task_runs.detail as detail',
        'task_runs.steps as steps',
        'task_runs.created_at as created_at',
      ])
      .where('scheduled_tasks.tenant_id', '=', ctx.tenantId)
      .where('task_runs.task_id', '=', taskId);
    if (ctx.role === 'user') q = q.where('scheduled_tasks.user_id', '=', ctx.userId);
    const rows = await q.orderBy('task_runs.id', 'desc').execute();
    return rows.map((r): TaskRun => ({
      id: r.id,
      taskId: r.task_id,
      status: r.status as TaskRun['status'],
      detail: r.detail ?? undefined,
      steps: r.steps ?? undefined,
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
    }));
  }

  async createTenant(tenant: Tenant): Promise<void> {
    await this.db
      .insertInto('tenants')
      .values({ id: tenant.id, name: tenant.name })
      .execute();
  }

  async listTenants(): Promise<Tenant[]> {
    const rows = await this.db.selectFrom('tenants').select(['id', 'name']).execute();
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  async createUser(user: NewUser): Promise<User> {
    // id 带随机后缀去关联 username：墓碑改名释放用户名后，新建同名用户不会撞旧行主键。
    const id = `u_${user.tenantId}_${user.username}_${randomUUID().slice(0, 8)}`;
    await this.db
      .insertInto('users')
      .values({
        id,
        tenant_id: user.tenantId,
        username: user.username,
        role: user.role,
        password_hash: user.passwordHash,
        status: 'active',
        auth_provider: user.authProvider ?? 'local',
        display_name: user.displayName ?? null,
        home_dir: null,
      })
      .execute();
    return {
      id,
      tenantId: user.tenantId,
      username: user.username,
      role: user.role,
      status: 'active',
      authProvider: user.authProvider ?? 'local',
      displayName: user.displayName,
    };
  }

  private toUser(r: {
    id: string;
    tenant_id: string;
    username: string;
    role: string;
    status: string;
    auth_provider: string;
    display_name: string | null;
    home_dir: string | null;
    created_at?: Date | string;
  }): User {
    return {
      id: r.id,
      tenantId: r.tenant_id,
      username: r.username,
      role: r.role as Role,
      status: (r.status === 'disabled' ? 'disabled' : 'active'),
      authProvider: (r.auth_provider === 'oidc' || r.auth_provider === 'aios' ? r.auth_provider : 'local'),
      displayName: r.display_name ?? undefined,
      homeDir: r.home_dir ?? undefined,
      ...(r.created_at ? { createdAt: toDate(r.created_at).toISOString() } : {}),
    };
  }

  async getUserByUsername(tenantId: string, username: string): Promise<UserWithSecret | undefined> {
    const r = await this.db
      .selectFrom('users')
      .select(['id', 'tenant_id', 'username', 'role', 'password_hash', 'status', 'auth_provider', 'display_name', 'home_dir', 'created_at'])
      .where('tenant_id', '=', tenantId)
      .where('username', '=', username)
      .executeTakeFirst();
    if (!r) return undefined;
    return { ...this.toUser(r), passwordHash: r.password_hash };
  }

  async getUser(tenantId: string, userId: string): Promise<User | undefined> {
    const r = await this.db
      .selectFrom('users')
      .select(['id', 'tenant_id', 'username', 'role', 'status', 'auth_provider', 'display_name', 'home_dir', 'created_at'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', userId)
      .executeTakeFirst();
    return r ? this.toUser(r) : undefined;
  }

  async listUsers(tenantId: string): Promise<User[]> {
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'tenant_id', 'username', 'role', 'status', 'auth_provider', 'display_name', 'home_dir', 'created_at'])
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((r) => this.toUser(r));
  }

  async updateUser(tenantId: string, userId: string, patch: UserPatch): Promise<User | undefined> {
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.username !== undefined) set.username = patch.username;
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.displayName !== undefined) set.display_name = patch.displayName;
    if (patch.homeDir !== undefined) set.home_dir = patch.homeDir;
    if (Object.keys(set).length) {
      await this.db
        .updateTable('users')
        .set(set)
        .where('tenant_id', '=', tenantId)
        .where('id', '=', userId)
        .execute();
    }
    return this.getUser(tenantId, userId);
  }

  async disableTasksByUser(tenantId: string, userId: string): Promise<number> {
    const res = await this.db
      .updateTable('scheduled_tasks')
      .set({ enabled: 0 })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .where('enabled', '=', 1)
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  }

  async setUserCredential(tenantId: string, userId: string, provider: string, record: UserCredentialRecord): Promise<void> {
    const values = {
      tenant_id: tenantId,
      user_id: userId,
      provider,
      payload: record.payload,
      expires_at: record.expiresAt ?? null,
    };
    await this.db
      .insertInto('user_credentials')
      .values(values)
      .onDuplicateKeyUpdate({ payload: record.payload, expires_at: record.expiresAt ?? null })
      .execute();
  }

  async getUserCredential(tenantId: string, userId: string, provider: string): Promise<UserCredentialRecord | undefined> {
    const r = await this.db
      .selectFrom('user_credentials')
      .select(['payload', 'expires_at'])
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .executeTakeFirst();
    if (!r) return undefined;
    return { payload: r.payload, expiresAt: r.expires_at ? new Date(r.expires_at) : undefined };
  }

  async deleteUserCredentials(tenantId: string, userId: string): Promise<void> {
    await this.db
      .deleteFrom('user_credentials')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .execute();
  }

  async getLlmSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<LlmSettings | undefined> {
    const row = await this.db
      .selectFrom('tenant_settings')
      .select(['config'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('setting_key', '=', 'llm.default')
      .executeTakeFirst();
    return row ? parseLlmSettings(row.config) : undefined;
  }

  async getSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<SchedulerSettings | undefined> {
    const row = await this.db
      .selectFrom('tenant_settings')
      .select(['config'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('setting_key', '=', 'scheduler.default')
      .executeTakeFirst();
    return row ? parseSchedulerSettings(row.config) : undefined;
  }

  async setSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: SchedulerSettings): Promise<void> {
    const config = JSON.stringify(settings);
    const updated = await this.db
      .updateTable('tenant_settings')
      .set({ config })
      .where('tenant_id', '=', ctx.tenantId)
      .where('setting_key', '=', 'scheduler.default')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return;
    await this.db
      .insertInto('tenant_settings')
      .values({ tenant_id: ctx.tenantId, setting_key: 'scheduler.default', config })
      .execute();
  }

  async getSandboxSettingsRecord(ctx: Pick<RequestContext, 'tenantId'>): Promise<SandboxSettingsRecord | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const configRow = await trx
        .selectFrom('tenant_settings')
        .select(['config'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('setting_key', '=', 'sandbox.default')
        .executeTakeFirst();
      if (!configRow) return undefined;
      const secretRow = await trx
        .selectFrom('setting_secrets')
        .select(['payload'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('setting_key', '=', 'sandbox.default.api_key')
        .executeTakeFirst();
      const parsed = parseStoredSandboxSettings(parseJson(configRow.config));
      return {
        settings: parsed.settings,
        ...(secretRow?.payload ? { encryptedApiKey: secretRow.payload } : {}),
        ...(!secretRow?.payload && parsed.legacyApiKey ? { legacyApiKey: parsed.legacyApiKey } : {}),
      };
    });
  }

  async setSandboxSettingsRecord(
    ctx: Pick<RequestContext, 'tenantId'>,
    settings: SandboxSettings,
    secret: SandboxSettingsSecretUpdate,
  ): Promise<void> {
    const config = JSON.stringify(settings);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('tenant_settings')
        .values({ tenant_id: ctx.tenantId, setting_key: 'sandbox.default', config })
        .onDuplicateKeyUpdate({ config })
        .execute();
      if (secret.action === 'replace') {
        await trx
          .insertInto('setting_secrets')
          .values({
            tenant_id: ctx.tenantId,
            setting_key: 'sandbox.default.api_key',
            payload: secret.encryptedApiKey,
          })
          .onDuplicateKeyUpdate({ payload: secret.encryptedApiKey })
          .execute();
      } else if (secret.action === 'clear') {
        await trx
          .deleteFrom('setting_secrets')
          .where('tenant_id', '=', ctx.tenantId)
          .where('setting_key', '=', 'sandbox.default.api_key')
          .execute();
      }
    });
  }

  async getSandboxSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<SandboxSettings | undefined> {
    return (await this.getSandboxSettingsRecord(ctx))?.settings;
  }

  async setSandboxSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: SandboxSettings): Promise<void> {
    await this.setSandboxSettingsRecord(ctx, settings, { action: 'retain' });
  }

  async setLlmSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: LlmSettings): Promise<void> {
    const config = JSON.stringify(settings);
    const updated = await this.db
      .updateTable('tenant_settings')
      .set({ config })
      .where('tenant_id', '=', ctx.tenantId)
      .where('setting_key', '=', 'llm.default')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return;
    await this.db
      .insertInto('tenant_settings')
      .values({ tenant_id: ctx.tenantId, setting_key: 'llm.default', config })
      .execute();
  }

  async getMcpServers(ctx: Pick<RequestContext, 'tenantId'>): Promise<Record<string, McpServerConfig> | undefined> {
    const row = await this.db
      .selectFrom('tenant_settings')
      .select(['config'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('setting_key', '=', 'mcp.servers')
      .executeTakeFirst();
    return row ? parseMcpServers(row.config) : undefined;
  }

  async setMcpServers(ctx: Pick<RequestContext, 'tenantId'>, servers: Record<string, McpServerConfig>): Promise<void> {
    const config = JSON.stringify(servers);
    const updated = await this.db
      .updateTable('tenant_settings')
      .set({ config })
      .where('tenant_id', '=', ctx.tenantId)
      .where('setting_key', '=', 'mcp.servers')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return;
    await this.db
      .insertInto('tenant_settings')
      .values({ tenant_id: ctx.tenantId, setting_key: 'mcp.servers', config })
      .execute();
  }

  async close(): Promise<void> {
    await this.db.destroy(); // 关闭底层连接池
  }
}
