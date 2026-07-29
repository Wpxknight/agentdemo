import { nextFireAt } from './cron.js';
import type { ClaimedScheduledFire, ScheduledFire, ScheduledTask } from './domain.js';

export interface ClaimDueInput {
  now: Date;
  limit: number;
  workerId: string;
  leaseMs: number;
}

export interface CompleteFireInput {
  fireId: string;
  claimToken: string;
  runId: string;
  completedAt: Date;
}

export interface ReleaseFireInput {
  fireId: string;
  claimToken: string;
  retryAt: Date;
  error: string;
}

export interface SchedulerStore {
  claimDue(input: ClaimDueInput): Promise<ClaimedScheduledFire[]>;
  completeFire(input: CompleteFireInput): Promise<void>;
  releaseFire(input: ReleaseFireInput): Promise<void>;
  recoverExpired(now: Date): Promise<number>;
}

export class MemorySchedulerStore implements SchedulerStore {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly fires = new Map<string, ScheduledFire>();
  private claimSequence = 0;

  constructor(tasks: readonly ScheduledTask[] = []) {
    for (const task of tasks) this.tasks.set(task.taskId, cloneTask(task));
  }

  upsertTask(task: ScheduledTask): void {
    this.tasks.set(task.taskId, cloneTask(task));
  }

  async claimDue(input: ClaimDueInput): Promise<ClaimedScheduledFire[]> {
    this.materializeDueFires(input.now);
    const due = [...this.fires.values()]
      .filter((fire) => fire.state === 'pending' && (!fire.retryAt || fire.retryAt.getTime() <= input.now.getTime()))
      .sort((left, right) => left.fireTime.getTime() - right.fireTime.getTime())
      .slice(0, input.limit);

    return due.map((fire) => {
      const claimToken = `${input.workerId}:${++this.claimSequence}`;
      Object.assign(fire, {
        state: 'claimed' as const,
        attempts: fire.attempts + 1,
        claimToken,
        claimedBy: input.workerId,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
        retryAt: undefined,
      });
      return cloneFire(fire) as ClaimedScheduledFire;
    });
  }

  async completeFire(input: CompleteFireInput): Promise<void> {
    const fire = this.requireClaim(input.fireId, input.claimToken);
    Object.assign(fire, {
      state: 'started' as const,
      runId: input.runId,
      claimToken: undefined,
      claimedBy: undefined,
      leaseExpiresAt: undefined,
      retryAt: undefined,
      lastError: undefined,
    });
  }

  async releaseFire(input: ReleaseFireInput): Promise<void> {
    const fire = this.requireClaim(input.fireId, input.claimToken);
    Object.assign(fire, {
      state: 'pending' as const,
      claimToken: undefined,
      claimedBy: undefined,
      leaseExpiresAt: undefined,
      retryAt: new Date(input.retryAt),
      lastError: input.error,
    });
  }

  async recoverExpired(now: Date): Promise<number> {
    let recovered = 0;
    for (const fire of this.fires.values()) {
      if (fire.state !== 'claimed' || !fire.leaseExpiresAt || fire.leaseExpiresAt.getTime() > now.getTime()) continue;
      Object.assign(fire, {
        state: 'pending' as const,
        claimToken: undefined,
        claimedBy: undefined,
        leaseExpiresAt: undefined,
        retryAt: new Date(now),
        lastError: 'scheduler worker lease expired',
      });
      recovered++;
    }
    return recovered;
  }

  async listFires(): Promise<ScheduledFire[]> {
    return [...this.fires.values()].map(cloneFire);
  }

  private materializeDueFires(now: Date): void {
    for (const task of this.tasks.values()) {
      if (task.enabled === false || task.nextFireAt.getTime() > now.getTime()) continue;
      const fireTime = new Date(task.nextFireAt);
      const fireId = scheduledFireId(task.taskId, fireTime);
      if (!this.fires.has(fireId)) {
        this.fires.set(fireId, {
          taskId: task.taskId,
          fireId,
          fireTime,
          identity: { tenantId: task.tenantId, actorId: task.actorId, roles: task.roles ?? ['user'] },
          sessionId: task.sessionId,
          input: task.input.map((message) => ({ ...message })),
          execution: { unattended: true, preApproved: task.preApproved === true },
          state: 'pending',
          attempts: 0,
        });
      }
      task.nextFireAt = nextFireAt(task.cron, fireTime);
    }
  }

  private requireClaim(fireId: string, claimToken: string): ScheduledFire {
    const fire = this.fires.get(fireId);
    if (!fire || fire.state !== 'claimed' || fire.claimToken !== claimToken) {
      throw new Error(`stale scheduler claim: ${fireId}`);
    }
    return fire;
  }
}

export function scheduledFireId(taskId: string, fireTime: Date): string {
  return `${taskId}:${fireTime.toISOString()}`;
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return { ...task, roles: task.roles ? [...task.roles] : undefined, input: task.input.map((message) => ({ ...message })), nextFireAt: new Date(task.nextFireAt) };
}

function cloneFire(fire: ScheduledFire): ScheduledFire {
  return {
    ...fire,
    identity: { ...fire.identity, roles: [...fire.identity.roles] },
    input: fire.input.map((message) => ({ ...message })),
    execution: fire.execution ? { ...fire.execution } : undefined,
    limits: fire.limits ? {
      ...fire.limits,
      deadlineAt: fire.limits.deadlineAt ? new Date(fire.limits.deadlineAt) : undefined,
    } : undefined,
    fireTime: new Date(fire.fireTime),
    leaseExpiresAt: fire.leaseExpiresAt ? new Date(fire.leaseExpiresAt) : undefined,
    retryAt: fire.retryAt ? new Date(fire.retryAt) : undefined,
  };
}
