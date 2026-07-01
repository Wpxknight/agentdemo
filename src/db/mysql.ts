import { sql, type Kysely } from 'kysely';
import type { Msg, Role as MsgRole } from '../model/types.js';
import type { AuditEvent } from '../audit/sink.js';
import type { RequestContext, Role, Tenant, User } from '../auth/types.js';
import type { Database } from './schema.js';
import type {
  AuditFilter,
  LlmSettings,
  NewUser,
  SessionSummary,
  ScheduledTask,
  ScheduledTaskInput,
  Store,
  TaskRun,
  UserWithSecret,
} from './store.js';
import { nextRunAt } from '../scheduler/cron.js';

interface TaskRow {
  id: number;
  tenant_id: string;
  user_id: string;
  session_id: string;
  cron: string;
  task: string;
  pre_approved: number;
  enabled: number;
  next_run_at: Date;
  last_run_at: Date | null;
}

interface SessionRow {
  id: number;
  session_id: string;
  role: string;
  content: unknown;
  created_at: Date | string;
}

function toTask(r: TaskRow): ScheduledTask {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    sessionId: r.session_id,
    cron: r.cron,
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
    ...(typeof o.effort === 'string' && efforts.includes(o.effort)
      ? { effort: o.effort as LlmSettings['effort'] }
      : {}),
  };
}

/** 基于 Kysely + mysql2 的持久化实现（租户由 ctx 强制过滤）。 */
export class MysqlStore implements Store {
  constructor(private readonly db: Kysely<Database>) {}

  async appendMessage(ctx: RequestContext, sessionId: string, msg: Msg): Promise<void> {
    const content = JSON.stringify({
      text: msg.text,
      thinking: msg.thinking,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
    });
    await this.db
      .insertInto('messages')
      .values({ tenant_id: ctx.tenantId, session_id: sessionId, role: msg.role, content })
      .execute();
  }

  async listMessages(ctx: RequestContext, sessionId: string): Promise<Msg[]> {
    const rows = await this.db
      .selectFrom('messages')
      .select(['role', 'content'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('session_id', '=', sessionId)
      .orderBy('id', 'asc')
      .execute();

    return rows.map((r): Msg => {
      const c = (parseJson(r.content) ?? {}) as Partial<Msg>;
      return {
        role: r.role as MsgRole,
        text: c.text,
        thinking: c.thinking,
        toolCalls: c.toolCalls,
        toolResults: c.toolResults,
      };
    });
  }

  async listSessions(ctx: RequestContext, limit = 50, offset = 0): Promise<SessionSummary[]> {
    const safeLimit = Math.max(0, limit);
    const safeOffset = Math.max(0, offset);
    if (safeLimit <= 0) return [];

    const { rows: sessionRows } = await sql<{ session_id: string; last_id: number }>`
      SELECT session_id, MAX(id) AS last_id
      FROM messages FORCE INDEX (idx_messages_tenant_id)
      WHERE tenant_id = ${ctx.tenantId}
      GROUP BY session_id
      ORDER BY last_id DESC
      LIMIT ${safeLimit}
      OFFSET ${safeOffset}
    `.execute(this.db);
    const sessionIds = sessionRows.map((row) => row.session_id);
    if (!sessionIds.length) return [];

    const rows = await this.db
      .selectFrom('messages')
      .select(['id', 'session_id', 'role', 'content', 'created_at'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('session_id', 'in', sessionIds)
      .orderBy('id', 'asc')
      .execute() as SessionRow[];

    const grouped = new Map<string, Array<{ role: string; text?: string; createdAt: Date }>>();
    for (const row of rows) {
      const content = (parseJson(row.content) ?? {}) as Partial<Msg>;
      const items = grouped.get(row.session_id) ?? [];
      items.push({
        role: row.role,
        text: content.text,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
      });
      grouped.set(row.session_id, items);
    }

    return [...grouped.entries()]
      .map(([sessionId, items]) => {
        const firstUser = items.find((m) => m.role === 'user' && m.text)?.text;
        const last = items.at(-1);
        return {
          sessionId,
          title: summarize(firstUser ?? items[0]?.text ?? sessionId),
          lastMessage: summarize(last?.text),
          messageCount: items.length,
          updatedAt: last?.createdAt.toISOString(),
        };
      })
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .sort((a, b) => sessionIds.indexOf(a.sessionId) - sessionIds.indexOf(b.sessionId));
  }

  async countSessions(ctx: RequestContext): Promise<number> {
    const { rows } = await sql<{ total: number | string | bigint }>`
      SELECT COUNT(DISTINCT session_id) AS total
      FROM messages
      WHERE tenant_id = ${ctx.tenantId}
    `.execute(this.db);
    return Number(rows[0]?.total ?? 0);
  }

  async deleteSession(ctx: RequestContext, sessionId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('messages')
      .where('tenant_id', '=', ctx.tenantId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
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
      task: input.task,
      preApproved: input.preApproved ?? false,
      enabled: input.enabled ?? true,
      nextRunAt: next,
    };
  }

  async listScheduledTasks(ctx: RequestContext): Promise<ScheduledTask[]> {
    const rows = await this.db
      .selectFrom('scheduled_tasks')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .orderBy('id', 'asc')
      .execute();
    return rows.map(toTask);
  }

  async setTaskEnabled(ctx: RequestContext, id: number, enabled: boolean): Promise<void> {
    await this.db
      .updateTable('scheduled_tasks')
      .set({ enabled: enabled ? 1 : 0 })
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId)
      .execute();
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
    const rows = await this.db
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
      .where('task_runs.task_id', '=', taskId)
      .orderBy('task_runs.id', 'desc')
      .execute();
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
    const id = `u_${user.tenantId}_${user.username}`;
    await this.db
      .insertInto('users')
      .values({
        id,
        tenant_id: user.tenantId,
        username: user.username,
        role: user.role,
        password_hash: user.passwordHash,
      })
      .execute();
    return { id, tenantId: user.tenantId, username: user.username, role: user.role };
  }

  async getUserByUsername(tenantId: string, username: string): Promise<UserWithSecret | undefined> {
    const r = await this.db
      .selectFrom('users')
      .select(['id', 'tenant_id', 'username', 'role', 'password_hash'])
      .where('tenant_id', '=', tenantId)
      .where('username', '=', username)
      .executeTakeFirst();
    if (!r) return undefined;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      username: r.username,
      role: r.role as Role,
      passwordHash: r.password_hash,
    };
  }

  async getUser(tenantId: string, userId: string): Promise<User | undefined> {
    const r = await this.db
      .selectFrom('users')
      .select(['id', 'tenant_id', 'username', 'role'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!r) return undefined;
    return { id: r.id, tenantId: r.tenant_id, username: r.username, role: r.role as Role };
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

  async close(): Promise<void> {
    await this.db.destroy(); // 关闭底层连接池
  }
}
