import type {
  AgentInputMessage,
  IdentityContext,
  RunExecutionProfile,
  RunLimits,
} from '@aiop/control-contracts';

export interface ScheduledTask {
  taskId: string;
  tenantId: string;
  actorId: string;
  roles?: readonly string[];
  sessionId: string;
  cron: string;
  input: readonly AgentInputMessage[];
  nextFireAt: Date;
  preApproved?: boolean;
  enabled?: boolean;
}

export interface ScheduledRunInput {
  taskId: string;
  fireId: string;
  fireTime: Date;
  identity: IdentityContext;
  sessionId: string;
  input: readonly AgentInputMessage[];
  execution?: RunExecutionProfile;
  limits?: RunLimits;
  signal?: AbortSignal;
}

export interface RunDispatcher {
  startScheduledRun(input: ScheduledRunInput): Promise<{ runId: string }>;
}

export interface ScheduledRunLookup {
  findScheduledRun(input: ScheduledRunInput): Promise<{ runId: string } | undefined>;
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
