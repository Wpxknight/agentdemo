import { AgentPlatformError, type RunLimits } from '@aiop/control-contracts';

export function assertAttemptAllowed(limits: RunLimits | undefined, attemptCount: number, now: Date): void {
  if (limits?.maxAttempts !== undefined && attemptCount >= limits.maxAttempts) {
    throw new AgentPlatformError({ code: 'RUN_LIMIT_EXCEEDED', message: 'Maximum attempts exceeded', retryable: false });
  }
  if (limits?.deadlineAt && limits.deadlineAt <= now) {
    throw new AgentPlatformError({ code: 'RUN_LIMIT_EXCEEDED', message: 'Run deadline exceeded', retryable: false });
  }
}
