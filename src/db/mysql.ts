import type { Kysely } from 'kysely';
import type { Msg, Role as MsgRole } from '../model/types.js';
import type { AuditEvent } from '../audit/sink.js';
import type { RequestContext, Role, Tenant, User } from '../auth/types.js';
import type { Database } from './schema.js';
import type {
  AuditFilter,
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

/** 基于 Kysely + mysql2 的持久化实现（租户由 ctx 强制过滤）。 */
export class MysqlStore implements Store {
  constructor(private readonly db: Kysely<Database>) {}

  async appendMessage(ctx: RequestContext, sessionId: string, msg: Msg): Promise<void> {
    const content = JSON.stringify({
      text: msg.text,
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
        toolCalls: c.toolCalls,
        toolResults: c.toolResults,
      };
    });
  }

  async listSessions(ctx: RequestContext, limit = 50): Promise<SessionSummary[]> {
    const rows = await this.db
      .selectFrom('messages')
      .select(['session_id', 'role', 'content', 'created_at'])
      .where('tenant_id', '=', ctx.tenantId)
      .orderBy('id', 'desc')
      .limit(Math.max(limit * 20, limit))
      .execute();

    const grouped = new Map<string, Array<{ role: string; text?: string; createdAt: Date }>>();
    for (const row of rows.reverse()) {
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
      .slice(0, limit);
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
      .select(['task_runs.task_id as task_id', 'task_runs.status as status', 'task_runs.detail as detail', 'task_runs.steps as steps'])
      .where('scheduled_tasks.tenant_id', '=', ctx.tenantId)
      .where('task_runs.task_id', '=', taskId)
      .orderBy('task_runs.id', 'asc')
      .execute();
    return rows.map((r): TaskRun => ({
      taskId: r.task_id,
      status: r.status as TaskRun['status'],
      detail: r.detail ?? undefined,
      steps: r.steps ?? undefined,
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

  async close(): Promise<void> {
    await this.db.destroy(); // 关闭底层连接池
  }
}
