import type { Kysely } from 'kysely';
import type { Msg, Role } from '../model/types.js';
import type { AuditEvent } from '../audit/sink.js';
import type { Database } from './schema.js';
import type {
  AuditFilter,
  ScheduledTask,
  ScheduledTaskInput,
  Store,
  TaskRun,
} from './store.js';
import { nextRunAt } from '../scheduler/cron.js';

interface TaskRow {
  id: number;
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

/** 基于 Kysely + mysql2 的持久化实现。 */
export class MysqlStore implements Store {
  constructor(private readonly db: Kysely<Database>) {}

  async appendMessage(sessionId: string, msg: Msg): Promise<void> {
    const content = JSON.stringify({
      text: msg.text,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
    });
    await this.db
      .insertInto('messages')
      .values({ session_id: sessionId, role: msg.role, content })
      .execute();
  }

  async listMessages(sessionId: string): Promise<Msg[]> {
    const rows = await this.db
      .selectFrom('messages')
      .select(['role', 'content'])
      .where('session_id', '=', sessionId)
      .orderBy('id', 'asc')
      .execute();

    return rows.map((r): Msg => {
      const c = (parseJson(r.content) ?? {}) as Partial<Msg>;
      return {
        role: r.role as Role,
        text: c.text,
        toolCalls: c.toolCalls,
        toolResults: c.toolResults,
      };
    });
  }

  async record(event: AuditEvent): Promise<void> {
    await this.db
      .insertInto('audit_events')
      .values({
        kind: event.kind,
        action: event.action,
        session_id: event.sessionId ?? null,
        cluster: event.cluster ?? null,
        tool: event.tool ?? null,
        detail: event.detail ? JSON.stringify(event.detail) : null,
      })
      .execute();
  }

  async listAudit(filter: AuditFilter = {}): Promise<AuditEvent[]> {
    let q = this.db
      .selectFrom('audit_events')
      .select(['kind', 'action', 'session_id', 'cluster', 'tool', 'detail', 'created_at'])
      .orderBy('id', 'asc');
    if (filter.sessionId) q = q.where('session_id', '=', filter.sessionId);
    if (filter.kind) q = q.where('kind', '=', filter.kind);
    if (filter.limit) q = q.limit(filter.limit);

    const rows = await q.execute();
    return rows.map((r): AuditEvent => ({
      kind: r.kind as AuditEvent['kind'],
      action: r.action,
      sessionId: r.session_id ?? undefined,
      cluster: r.cluster ?? undefined,
      tool: r.tool ?? undefined,
      detail: (parseJson(r.detail) as Record<string, unknown> | undefined) ?? undefined,
      at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  async createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const next = nextRunAt(input.cron, new Date());
    const res = await this.db
      .insertInto('scheduled_tasks')
      .values({
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
      sessionId: input.sessionId,
      cron: input.cron,
      task: input.task,
      preApproved: input.preApproved ?? false,
      enabled: input.enabled ?? true,
      nextRunAt: next,
    };
  }

  async listScheduledTasks(sessionId?: string): Promise<ScheduledTask[]> {
    let q = this.db.selectFrom('scheduled_tasks').selectAll().orderBy('id', 'asc');
    if (sessionId) q = q.where('session_id', '=', sessionId);
    return (await q.execute()).map(toTask);
  }

  async setTaskEnabled(id: number, enabled: boolean): Promise<void> {
    await this.db
      .updateTable('scheduled_tasks')
      .set({ enabled: enabled ? 1 : 0 })
      .where('id', '=', id)
      .execute();
  }

  /** 事务内 FOR UPDATE SKIP LOCKED 领取并推进，保证多副本不重复执行。 */
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

  async listTaskRuns(taskId: number): Promise<TaskRun[]> {
    const rows = await this.db
      .selectFrom('task_runs')
      .select(['task_id', 'status', 'detail', 'steps'])
      .where('task_id', '=', taskId)
      .orderBy('id', 'asc')
      .execute();
    return rows.map((r): TaskRun => ({
      taskId: r.task_id,
      status: r.status as TaskRun['status'],
      detail: r.detail ?? undefined,
      steps: r.steps ?? undefined,
    }));
  }

  async close(): Promise<void> {
    await this.db.destroy(); // 关闭底层连接池
  }
}
