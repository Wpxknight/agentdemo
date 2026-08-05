import { AgentPlatformError, type AgentRunUsage, type RunLimits } from '@aiop/control-contracts';

export function assertAttemptAllowed(limits: RunLimits | undefined, attemptCount: number, now: Date): void {
  if (limits?.maxAttempts !== undefined && attemptCount >= limits.maxAttempts) {
    throw new AgentPlatformError({ code: 'RUN_LIMIT_EXCEEDED', message: 'Maximum attempts exceeded', retryable: false });
  }
  if (limits?.deadlineAt && limits.deadlineAt <= now) {
    throw new AgentPlatformError({ code: 'RUN_LIMIT_EXCEEDED', message: 'Run deadline exceeded', retryable: false });
  }
}

export function assertTurnAllowed(limits: RunLimits | undefined, turnNo: number): void {
  if (limits?.maxTurns !== undefined && turnNo > limits.maxTurns) exceeded('Maximum turns exceeded');
}

export function assertUsageAllowed(limits: RunLimits | undefined, usage: AgentRunUsage): void {
  if (limits?.maxInputTokens !== undefined && usage.inputTokens > limits.maxInputTokens) exceeded('Maximum input tokens exceeded');
  if (limits?.maxOutputTokens !== undefined && usage.outputTokens > limits.maxOutputTokens) exceeded('Maximum output tokens exceeded');
  if (limits?.maxCostUsd !== undefined) {
    if (usage.costUsd === undefined) exceeded('Run cost is unavailable for the configured cost limit');
    if (usage.costUsd > limits.maxCostUsd) exceeded('Maximum cost exceeded');
  }
}

export function assertToolCallsAllowed(limits: RunLimits | undefined, toolCalls: number): void {
  if (limits?.maxToolCalls !== undefined && toolCalls > limits.maxToolCalls) exceeded('Maximum tool calls exceeded');
}

function exceeded(message: string): never {
  throw new AgentPlatformError({ code: 'RUN_LIMIT_EXCEEDED', message, retryable: false });
}
