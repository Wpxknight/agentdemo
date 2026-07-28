import type { JsonValue, ToolCall, ToolCapability, ToolExecutionContext, ToolExecutionOutcome, ToolResult, ToolRuntime } from '@aiop/control-contracts';
import type { ToolLedgerRepository } from '@aiop/agent-runtime-core';
export interface RegisteredTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    capability: ToolCapability;
    interactionKind?: 'question' | 'plan';
    execute(call: ToolCall, context: ToolExecutionContext & {
        idempotencyKey: string;
    }): Promise<Omit<ToolResult, 'callId'>>;
}
export interface PolicyDecision {
    allowed: boolean;
    reason?: string;
    needsApproval?: boolean;
    resourceKey?: string;
}
export interface ToolPolicy {
    check(call: ToolCall, context: ToolExecutionContext, tool: RegisteredTool): Promise<PolicyDecision>;
}
export interface ApprovalDecision {
    approved: boolean;
    pending?: boolean;
    interactionId?: string;
    payload?: JsonValue;
}
export interface ToolApproval {
    request(call: ToolCall, context: ToolExecutionContext, decision: PolicyDecision): Promise<ApprovalDecision>;
}
export interface ToolHooks {
    before(call: ToolCall, context: ToolExecutionContext): Promise<{
        allowed: boolean;
        reason?: string;
    }>;
}
export interface ToolAudit {
    record(input: {
        call: ToolCall;
        context: ToolExecutionContext;
        capability: ToolCapability;
        outcome: ToolExecutionOutcome;
    }): Promise<void>;
}
export interface ToolOutputLimiter {
    limit(result: ToolResult, tool: RegisteredTool): Promise<ToolResult>;
}
export interface ToolRuntimeEngineOptions {
    ledger: ToolLedgerRepository;
    definitions: readonly RegisteredTool[];
    policy?: ToolPolicy;
    approval?: ToolApproval;
    hooks?: ToolHooks;
    audit?: ToolAudit;
    outputLimiter?: ToolOutputLimiter;
    concurrency?: ConcurrencyLimits;
    concurrencyController?: ToolConcurrencyController;
    onLedger?: () => void;
    onLock?: () => void;
    now?: () => Date;
}
export interface ConcurrencyLimits {
    maxConcurrentPerTenant?: number;
    maxConcurrentPerTool?: number;
    maxConcurrentPerResource?: number;
}
export declare class ToolRuntimeEngine implements ToolRuntime {
    private readonly options;
    private readonly definitions;
    private readonly concurrency;
    private readonly now;
    constructor(options: ToolRuntimeEngineOptions);
    execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome>;
    private executeInteractionTool;
    private trustedApproval;
    private completeWithoutExecution;
    private completedOutcome;
    private ledgerMismatch;
    private pendingApproval;
}
export interface PiToolOutputLimiterOptions {
    direction: 'head' | 'tail' | 'line';
    maxLines?: number;
    maxBytes?: number;
    maxChars?: number;
    saveOriginal?: (content: string) => Promise<string>;
}
export declare class PiToolOutputLimiter implements ToolOutputLimiter {
    private readonly options;
    constructor(options: PiToolOutputLimiterOptions);
    limit(result: ToolResult, _tool?: RegisteredTool): Promise<ToolResult>;
}
export declare class ToolConcurrencyController {
    private readonly limits;
    private readonly tenant;
    private readonly tool;
    private readonly resource;
    constructor(limits?: ConcurrencyLimits);
    run<T>(input: {
        tenantId: string;
        toolName: string;
        resourceKey?: string;
        signal?: AbortSignal;
    }, work: () => Promise<T>): Promise<T>;
}
