import { CronExpressionParser } from 'cron-parser';
import type { Generated, Kysely } from 'kysely';
import type { ClaimedTask, SchedulerStore, TaskAgentRunLink } from '@aiop/scheduler-core';

export interface SchedulerMysqlDatabase {
  scheduled_tasks: {
    id: Generated<number>; tenant_id: string; user_id: string; session_id: string; title: string;
    cron: string; task: string; pre_approved: number; enabled: number; next_run_at: Date;
    last_run_at: Date | null; created_at: Generated<Date>;
  };
  task_agent_runs: {
    tenant_id: string; task_id: number; run_id: string; created_at: Date;
  };
}

export class MysqlSchedulerStore implements SchedulerStore {
  constructor(private readonly db: Kysely<SchedulerMysqlDatabase>) {}

  claimDue(now: Date, limit: number): Promise<ClaimedTask[]> {
    return this.db.transaction().execute(async (tx) => {
      const rows = await tx.selectFrom('scheduled_tasks').selectAll()
        .where('enabled', '=', 1).where('next_run_at', '<=', now)
        .orderBy('next_run_at', 'asc').limit(limit).forUpdate().skipLocked().execute();
      for (const row of rows) {
        const next = CronExpressionParser.parse(row.cron, { currentDate: now, tz: 'UTC' }).next().toDate();
        await tx.updateTable('scheduled_tasks').set({ last_run_at: now, next_run_at: next })
          .where('id', '=', row.id).execute();
      }
      return rows.map((row) => ({
        taskId: String(row.id), tenantId: row.tenant_id, actorId: row.user_id,
        sessionId: row.session_id, input: row.task, roles: ['user'],
      }));
    });
  }

  async recordRunLink(input: TaskAgentRunLink): Promise<void> {
    await this.db.insertInto('task_agent_runs').values({
      tenant_id: input.tenantId, task_id: Number(input.taskId), run_id: input.runId, created_at: new Date(),
    }).execute();
  }
}
