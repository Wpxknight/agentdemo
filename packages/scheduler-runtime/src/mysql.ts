import { randomUUID } from 'node:crypto';
import type { Generated, Kysely } from 'kysely';
import { nextFireAt } from './cron.js';
import type { ClaimedScheduledFire } from './domain.js';
import { scheduledFireId, type ClaimDueInput, type CompleteFireInput, type ReleaseFireInput, type SchedulerStore } from './store.js';

export interface SchedulerMysqlDatabase {
  scheduled_tasks: {
    id: Generated<number>;
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
    created_at: Generated<Date>;
  };
  scheduler_fires: {
    fire_id: string;
    task_id: number;
    tenant_id: string;
    actor_id: string;
    session_id: string;
    fire_time: Date;
    input_json: string;
    state: string;
    attempts: number;
    run_id: string | null;
    claim_token: string | null;
    claim_owner: string | null;
    lease_expires_at: Date | null;
    retry_at: Date | null;
    last_error: string | null;
    created_at: Date;
    updated_at: Date;
  };
  task_agent_runs: {
    tenant_id: string;
    task_id: number;
    run_id: string;
    created_at: Date;
  };
  task_runs: {
    id: Generated<number>;
    task_id: number;
    fire_id: Generated<string | null>;
    run_id: Generated<string | null>;
    status: string;
    detail: string | null;
    steps: number | null;
    created_at: Generated<Date>;
  };
}

export class MysqlSchedulerStore implements SchedulerStore {
  constructor(private readonly db: Kysely<SchedulerMysqlDatabase>) {}

  claimDue(input: ClaimDueInput): Promise<ClaimedScheduledFire[]> {
    return this.db.transaction().execute(async (tx) => {
      const tasks = await tx.selectFrom('scheduled_tasks').selectAll()
        .where('enabled', '=', 1).where('next_run_at', '<=', input.now)
        .orderBy('next_run_at', 'asc').limit(input.limit).forUpdate().skipLocked().execute();

      for (const task of tasks) {
        const fireTime = task.next_run_at;
        await tx.insertInto('scheduler_fires').values({
          fire_id: scheduledFireId(String(task.id), fireTime), task_id: task.id,
          tenant_id: task.tenant_id, actor_id: task.user_id, session_id: task.session_id,
          fire_time: fireTime, input_json: JSON.stringify({
            input: [{ role: 'user', text: task.task }],
            execution: { unattended: true, preApproved: Boolean(task.pre_approved) },
          }),
          state: 'pending', attempts: 0, run_id: null, claim_token: null, claim_owner: null,
          lease_expires_at: null, retry_at: null, last_error: null, created_at: input.now, updated_at: input.now,
        }).onDuplicateKeyUpdate({ fire_id: scheduledFireId(String(task.id), fireTime) }).execute();
        await tx.updateTable('scheduled_tasks')
          .set({ last_run_at: fireTime, next_run_at: nextFireAt(task.cron, fireTime) })
          .where('id', '=', task.id).execute();
      }

      const rows = await tx.selectFrom('scheduler_fires').selectAll()
        .where('state', '=', 'pending')
        .where((eb) => eb.or([eb('retry_at', 'is', null), eb('retry_at', '<=', input.now)]))
        .orderBy('fire_time', 'asc').limit(input.limit).forUpdate().skipLocked().execute();

      const claimed: ClaimedScheduledFire[] = [];
      for (const row of rows) {
        const claimToken = randomUUID();
        const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
        await tx.updateTable('scheduler_fires').set({
          state: 'claimed', attempts: row.attempts + 1, claim_token: claimToken,
          claim_owner: input.workerId, lease_expires_at: leaseExpiresAt, retry_at: null, updated_at: input.now,
        }).where('fire_id', '=', row.fire_id).where('state', '=', 'pending').execute();
        claimed.push({
          taskId: String(row.task_id), fireId: row.fire_id, fireTime: row.fire_time,
          identity: { tenantId: row.tenant_id, actorId: row.actor_id, roles: ['user'] },
          sessionId: row.session_id, ...parsePayload(row.input_json), state: 'claimed',
          attempts: row.attempts + 1, claimToken, claimedBy: input.workerId, leaseExpiresAt,
        });
      }
      return claimed;
    });
  }

  async completeFire(input: CompleteFireInput): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('scheduler_fires').select(['task_id', 'tenant_id'])
        .where('fire_id', '=', input.fireId).where('state', '=', 'claimed')
        .where('claim_token', '=', input.claimToken).forUpdate().executeTakeFirst();
      if (!row) throw new Error(`stale scheduler claim: ${input.fireId}`);
      await tx.updateTable('scheduler_fires').set({
        state: 'started', run_id: input.runId, claim_token: null, claim_owner: null,
        lease_expires_at: null, retry_at: null, last_error: null, updated_at: input.completedAt,
      }).where('fire_id', '=', input.fireId).execute();
      await tx.insertInto('task_runs').values({
        task_id: row.task_id, fire_id: input.fireId, run_id: input.runId,
        status: 'success', detail: input.runId, steps: null,
      }).onDuplicateKeyUpdate({ run_id: input.runId, detail: input.runId }).execute();
      await tx.insertInto('task_agent_runs').values({
        tenant_id: row.tenant_id, task_id: row.task_id, run_id: input.runId, created_at: input.completedAt,
      }).onDuplicateKeyUpdate({ run_id: input.runId }).execute();
    });
  }

  async releaseFire(input: ReleaseFireInput): Promise<void> {
    const result = await this.db.updateTable('scheduler_fires').set({
      state: 'pending', claim_token: null, claim_owner: null, lease_expires_at: null,
      retry_at: input.retryAt, last_error: input.error, updated_at: input.retryAt,
    }).where('fire_id', '=', input.fireId).where('state', '=', 'claimed')
      .where('claim_token', '=', input.claimToken).executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error(`stale scheduler claim: ${input.fireId}`);
  }

  async recoverExpired(now: Date): Promise<number> {
    const result = await this.db.updateTable('scheduler_fires').set({
      state: 'pending', claim_token: null, claim_owner: null, lease_expires_at: null,
      retry_at: now, last_error: 'scheduler worker lease expired', updated_at: now,
    }).where('state', '=', 'claimed').where('lease_expires_at', '<=', now).executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}

function parsePayload(value: string): Pick<ClaimedScheduledFire, 'input' | 'execution'> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (Array.isArray(parsed)) return { input: parsed as ClaimedScheduledFire['input'] };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { input?: unknown }).input)) {
    throw new Error('invalid scheduler fire input');
  }
  const payload = parsed as { input: ClaimedScheduledFire['input']; execution?: ClaimedScheduledFire['execution'] };
  return { input: payload.input, execution: payload.execution };
}
