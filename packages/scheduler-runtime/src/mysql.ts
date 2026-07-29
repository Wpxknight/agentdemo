import { randomUUID } from 'node:crypto';
import type { Generated, Kysely } from 'kysely';
import { nextFireAt } from './cron.js';
import type { BoundScheduledFire, ClaimedScheduledFire, RecoveringScheduledFire } from './domain.js';
import {
  scheduledFireId, type BindRunInput, type ClaimBoundInput, type ClaimDueInput, type CompleteFireInput,
  type DeferBoundInput, type ListBoundInput, type ReleaseBoundInput, type ReleaseFireInput, type SchedulerStore,
} from './store.js';

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

  async bindRun(input: BindRunInput): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('scheduler_fires').select(['task_id', 'tenant_id', 'run_id'])
        .where('fire_id', '=', input.fireId).where('state', '=', 'claimed')
        .where('claim_token', '=', input.claimToken).forUpdate().executeTakeFirst();
      if (!row) throw new Error(`stale scheduler claim: ${input.fireId}`);
      if (row.run_id && row.run_id !== input.runId) throw new Error(`scheduled fire Run mismatch: ${input.fireId}`);
      await tx.updateTable('scheduler_fires').set({
        state: 'bound', run_id: input.runId, claim_owner: null, updated_at: input.boundAt,
      })
        .where('fire_id', '=', input.fireId).execute();
      await tx.insertInto('task_agent_runs').values({
        tenant_id: row.tenant_id, task_id: row.task_id, run_id: input.runId, created_at: input.boundAt,
      }).onDuplicateKeyUpdate({ run_id: input.runId }).execute();
    });
  }

  async completeFire(input: CompleteFireInput): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('scheduler_fires').select(['task_id', 'state', 'run_id', 'claim_token'])
        .where('fire_id', '=', input.fireId).forUpdate().executeTakeFirst();
      if (!row) throw new Error(`stale scheduler claim: ${input.fireId}`);
      if (row.state === 'started') {
        if (row.run_id === input.runId && input.result.runId === input.runId) return;
        throw new Error(`scheduled fire Run mismatch: ${input.fireId}`);
      }
      if ((row.state !== 'bound' && row.state !== 'recovering') || row.claim_token !== input.claimToken) {
        throw new Error(`stale scheduler claim: ${input.fireId}`);
      }
      if (row.run_id !== input.runId || input.result.runId !== input.runId) {
        throw new Error(`scheduled fire Run mismatch: ${input.fireId}`);
      }
      await tx.updateTable('scheduler_fires').set({
        state: 'started', claim_token: null, claim_owner: null,
        lease_expires_at: null, retry_at: null, last_error: null, updated_at: input.completedAt,
      }).where('fire_id', '=', input.fireId).execute();
      await tx.insertInto('task_runs').values({
        task_id: row.task_id, fire_id: input.fireId, run_id: input.runId,
        status: compatibilityStatus(input.result), detail: compatibilityDetail(input.result), steps: null,
      }).onDuplicateKeyUpdate({
        run_id: input.runId, status: compatibilityStatus(input.result), detail: compatibilityDetail(input.result),
      }).execute();
    });
  }

  async listBound(input: ListBoundInput): Promise<BoundScheduledFire[]> {
    const rows = await this.db.selectFrom('scheduler_fires').selectAll()
      .where('state', '=', 'bound').where('run_id', 'is not', null)
      .where('lease_expires_at', '<=', input.now)
      .where((eb) => eb.or([eb('retry_at', 'is', null), eb('retry_at', '<=', input.now)]))
      .orderBy('fire_time', 'asc').orderBy('fire_id', 'asc').limit(input.limit).execute();
    return rows.map((row) => toBoundFire(row));
  }

  async claimBound(input: ClaimBoundInput): Promise<RecoveringScheduledFire | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('scheduler_fires').selectAll()
        .where('fire_id', '=', input.fireId).where('state', '=', 'bound')
        .where('claim_token', '=', input.expectedClaimToken).where('run_id', 'is not', null)
        .where('lease_expires_at', '<=', input.now)
        .where((eb) => eb.or([eb('retry_at', 'is', null), eb('retry_at', '<=', input.now)]))
        .forUpdate().skipLocked().executeTakeFirst();
      if (!row || !row.run_id || !row.claim_token || !row.lease_expires_at) return undefined;
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      const result = await tx.updateTable('scheduler_fires').set({
        state: 'recovering', claim_token: claimToken, claim_owner: input.workerId,
        lease_expires_at: leaseExpiresAt, updated_at: input.now,
      }).where('fire_id', '=', input.fireId).where('state', '=', 'bound')
        .where('claim_token', '=', input.expectedClaimToken).executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return undefined;
      return {
        taskId: String(row.task_id), fireId: row.fire_id, fireTime: row.fire_time,
        identity: { tenantId: row.tenant_id, actorId: row.actor_id, roles: ['user'] },
        sessionId: row.session_id, ...parsePayload(row.input_json), state: 'recovering', attempts: row.attempts,
        runId: row.run_id, claimToken, claimedBy: input.workerId, leaseExpiresAt,
        retryAt: row.retry_at ?? undefined, lastError: row.last_error ?? undefined,
      };
    });
  }

  async releaseBound(input: ReleaseBoundInput): Promise<void> {
    const result = await this.db.updateTable('scheduler_fires').set({
      state: 'bound', claim_owner: null, lease_expires_at: input.retryAt,
      retry_at: input.retryAt, last_error: input.error, updated_at: input.retryAt,
    }).where('fire_id', '=', input.fireId).where('state', '=', 'recovering')
      .where('claim_token', '=', input.claimToken).executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error(`stale scheduler claim: ${input.fireId}`);
  }

  async deferBound(input: DeferBoundInput): Promise<void> {
    const result = await this.db.updateTable('scheduler_fires').set({
      lease_expires_at: input.retryAt, retry_at: input.retryAt,
      last_error: input.error, updated_at: input.retryAt,
    }).where('fire_id', '=', input.fireId).where('state', '=', 'bound')
      .where('claim_token', '=', input.claimToken).executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error(`stale scheduler claim: ${input.fireId}`);
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
    return this.db.transaction().execute(async (tx) => {
      const claimed = await tx.updateTable('scheduler_fires').set({
        state: 'pending', claim_token: null, claim_owner: null, lease_expires_at: null,
        retry_at: now, last_error: 'scheduler worker lease expired', updated_at: now,
      }).where('state', '=', 'claimed').where('lease_expires_at', '<=', now).executeTakeFirst();
      const recovering = await tx.updateTable('scheduler_fires').set({
        state: 'bound', claim_owner: null, retry_at: now,
        last_error: 'scheduler bound Run recovery lease expired', updated_at: now,
      }).where('state', '=', 'recovering').where('lease_expires_at', '<=', now).executeTakeFirst();
      return Number(claimed.numUpdatedRows) + Number(recovering.numUpdatedRows);
    });
  }
}

function toBoundFire(row: SchedulerMysqlDatabase['scheduler_fires']): BoundScheduledFire {
  if (!row.run_id || !row.claim_token || !row.lease_expires_at) throw new Error(`invalid bound scheduler fire: ${row.fire_id}`);
  return {
    taskId: String(row.task_id), fireId: row.fire_id, fireTime: row.fire_time,
    identity: { tenantId: row.tenant_id, actorId: row.actor_id, roles: ['user'] },
    sessionId: row.session_id, ...parsePayload(row.input_json), state: 'bound', attempts: row.attempts,
    runId: row.run_id, claimToken: row.claim_token, leaseExpiresAt: row.lease_expires_at,
    retryAt: row.retry_at ?? undefined, lastError: row.last_error ?? undefined,
  };
}

function compatibilityStatus(result: import('@aiop/control-contracts').AgentRunResult): 'success' | 'error' {
  return result.status === 'succeeded' ? 'success' : 'error';
}

function compatibilityDetail(result: import('@aiop/control-contracts').AgentRunResult): string {
  return JSON.stringify({
    runId: result.runId, status: result.status, durableStatus: result.status,
    text: result.text, error: result.error, usage: result.usage,
  });
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
