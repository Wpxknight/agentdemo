export type AgentPlatformErrorCode =
  | 'RUN_NOT_FOUND' | 'RUN_STATE_CONFLICT' | 'RUN_LIMIT_EXCEEDED'
  | 'LEASE_LOST' | 'TURN_COMMIT_FAILED' | 'TOOL_RESULT_UNKNOWN'
  | 'KERNEL_VERSION_UNAVAILABLE' | 'MODEL_PROVIDER_ERROR' | 'POLICY_DENIED';

export interface AgentPlatformErrorData {
  code: AgentPlatformErrorCode;
  message: string;
  retryable: boolean;
}

export class AgentPlatformError extends Error {
  readonly code: AgentPlatformErrorCode;
  readonly retryable: boolean;

  constructor(data: AgentPlatformErrorData) {
    super(data.message);
    this.name = 'AgentPlatformError';
    this.code = data.code;
    this.retryable = data.retryable;
  }
}

export class RunNotFoundError extends AgentPlatformError {
  constructor(message = 'Run not found') {
    super({ code: 'RUN_NOT_FOUND', message, retryable: false });
    this.name = 'RunNotFoundError';
  }
}

export class LeaseLostError extends AgentPlatformError {
  constructor(message = 'Run lease was lost') {
    super({ code: 'LEASE_LOST', message, retryable: false });
    this.name = 'LeaseLostError';
  }
}

export class PolicyDeniedError extends AgentPlatformError {
  constructor(message = 'Policy denied the operation') {
    super({ code: 'POLICY_DENIED', message, retryable: false });
    this.name = 'PolicyDeniedError';
  }
}

export class RecoveryRequiredError extends AgentPlatformError {
  constructor(message = 'Manual recovery is required') {
    super({ code: 'TOOL_RESULT_UNKNOWN', message, retryable: false });
    this.name = 'RecoveryRequiredError';
  }
}
