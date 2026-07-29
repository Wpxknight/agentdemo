import type { AgentInputMessage, IdentityContext } from '@aiop/control-contracts';

export interface ScheduledTask {
  taskId: string;
  tenantId: string;
  actorId: string;
  roles?: readonly string[];
  sessionId: string;
  cron: string;
  input: readonly AgentInputMessage[];
  nextFireAt: Date;
  enabled?: boolean;
}

export interface ScheduledRunInput {
  taskId: string;
  fireId: string;
  fireTime: Date;
  identity: IdentityContext;
  sessionId: string;
  input: readonly AgentInputMessage[];
}

export interface RunDispatcher {
  startScheduledRun(input: ScheduledRunInput): Promise<{ runId: string }>;
}

export type ScheduledFireState = 'pending' | 'claimed' | 'started';

export interface ScheduledFire extends ScheduledRunInput {
  state: ScheduledFireState;
  attempts: number;
  runId?: string;
  claimToken?: string;
  claimedBy?: string;
  leaseExpiresAt?: Date;
  retryAt?: Date;
  lastError?: string;
}

export interface ClaimedScheduledFire extends ScheduledFire {
  state: 'claimed';
  claimToken: string;
  claimedBy: string;
  leaseExpiresAt: Date;
}
