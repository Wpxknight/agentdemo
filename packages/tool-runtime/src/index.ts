import { createHash } from 'node:crypto';
import type {
  JsonValue,
  ToolCall,
  ToolCapability,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolResult,
  ToolRuntime,
} from '@aiop/agent-contracts';
import type { ToolLedgerRecord, ToolLedgerRepository } from '@aiop/agent-runtime-core';
import { truncateHead, truncateLine, truncateTail } from '@earendil-works/pi-agent-core';

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: ToolCapability;
  execute(call: ToolCall, context: ToolExecutionContext & { idempotencyKey: string }): Promise<Omit<ToolResult, 'callId'>>;
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
  before(call: ToolCall, context: ToolExecutionContext): Promise<{ allowed: boolean; reason?: string }>;
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
  onLedger?: () => void;
  onLock?: () => void;
  now?: () => Date;
}

export class ToolRuntimeEngine implements ToolRuntime {
  private readonly definitions = new Map<string, RegisteredTool>();
  private readonly locks = new ResourceLocks();
  private readonly now: () => Date;

  constructor(private readonly options: ToolRuntimeEngineOptions) {
    for (const definition of options.definitions) {
      if (this.definitions.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
      this.definitions.set(definition.name, definition);
    }
    this.now = options.now ?? (() => new Date());
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const tool = this.definitions.get(call.name);
    if (!tool) return result(call.id, `unknown tool: ${call.name}`, true);
    const validation = validate(call.arguments, tool.inputSchema);
    if (validation) return result(call.id, `invalid arguments: ${validation}`, true);

    const policy = await this.options.policy?.check(call, context, tool) ?? { allowed: true };
    if (!policy.allowed) return result(call.id, `blocked by policy: ${policy.reason ?? 'denied'}`, true);

    const approval = this.options.approval
      ? await this.options.approval.request(call, context, policy)
      : { approved: !policy.needsApproval };
    if (!approval.approved) {
      if (approval.pending && approval.interactionId) {
        const pending = this.pendingApproval(call, context, tool, approval.interactionId);
        const interaction = {
          tenantId: context.identity.tenantId,
          runId: context.runId,
          id: approval.interactionId,
          attemptId: context.attemptId,
          turnNo: context.turnNo,
          kind: 'approval' as const,
          status: 'pending' as const,
          payload: approval.payload ?? { toolName: call.name, reason: policy.reason ?? null },
          createdAt: this.now(),
        };
        return {
          kind: 'waiting', reason: 'approval', interactionId: approval.interactionId,
          ledgerUpdates: [pending], interactionUpdates: [interaction],
        };
      }
      return result(call.id, `needs approval: ${policy.reason ?? 'denied'}`, true);
    }

    const hook = await this.options.hooks?.before(call, context) ?? { allowed: true };
    if (!hook.allowed) return result(call.id, `blocked by hook: ${hook.reason ?? 'denied'}`, true);

    this.options.onLedger?.();
    const argsDigest = digest(call.arguments);
    const idempotencyKey = `${context.identity.tenantId}:${context.runId}:${call.logicalCallId}`;
    const existing = await this.options.ledger.get({
      tenantId: context.identity.tenantId, runId: context.runId, logicalCallId: call.logicalCallId,
    });
    if (existing) {
      if (existing.toolName !== call.name || existing.argsDigest !== argsDigest) {
        return { kind: 'recovery_required', message: 'logical tool call identity changed across attempts' };
      }
      if (existing.status === 'completed' && existing.result) return { kind: 'result', result: existing.result };
      if (existing.status === 'pending_approval') {
        return { kind: 'waiting', reason: 'approval', interactionId: existing.approvedInteractionId ?? 'pending' };
      }
      if (existing.capability === 'non_idempotent_write') {
        const recovery = { ...existing, status: 'recovery_required' as const, updatedAt: this.now() };
        return {
          kind: 'recovery_required',
          correlationId: existing.externalCorrelationId,
          message: 'non-idempotent tool result is unknown and cannot be replayed automatically',
          ledgerUpdates: [recovery],
        };
      }
    }

    const startedAt = this.now();
    const record: ToolLedgerRecord = existing ? {
      ...existing, attemptId: context.attemptId, turnNo: context.turnNo, toolCallId: call.id,
      status: 'started', updatedAt: startedAt,
    } : {
      tenantId: context.identity.tenantId, runId: context.runId, attemptId: context.attemptId,
      turnNo: context.turnNo, logicalCallId: call.logicalCallId, toolCallId: call.id,
      toolName: call.name, argsDigest, capability: tool.capability, idempotencyKey,
      approvedInteractionId: approval.interactionId, status: 'started', createdAt: startedAt, updatedAt: startedAt,
    };
    if (existing) await this.options.ledger.update(record);
    else if (!await this.options.ledger.putIfAbsent(record)) return this.execute(call, context);

    this.options.onLock?.();
    const execute = async (): Promise<ToolExecutionOutcome> => {
      const raw = await tool.execute(call, { ...context, idempotencyKey });
      const limited = this.options.outputLimiter
        ? await this.options.outputLimiter.limit({ ...raw, callId: call.id }, tool)
        : { ...raw, callId: call.id };
      const completed: ToolLedgerRecord = {
        ...record, status: 'completed', result: limited, resultDigest: digest(limited.content), updatedAt: this.now(),
      };
      return { kind: 'result', result: limited, ledgerUpdates: [completed] };
    };
    let outcome: ToolExecutionOutcome;
    try {
      outcome = tool.capability === 'read'
        ? await execute()
        : await this.locks.run(policy.resourceKey ?? call.name, execute);
    } catch (error) {
      if (tool.capability === 'non_idempotent_write') {
        const recovery = { ...record, status: 'recovery_required' as const, updatedAt: this.now() };
        outcome = { kind: 'recovery_required', message: safeMessage(error), ledgerUpdates: [recovery] };
      } else {
        outcome = result(call.id, safeMessage(error), true);
      }
    }
    await this.options.audit?.record({ call, context, capability: tool.capability, outcome });
    return outcome;
  }

  private pendingApproval(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: RegisteredTool,
    interactionId: string,
  ): ToolLedgerRecord {
    this.options.onLedger?.();
    const now = this.now();
    return {
      tenantId: context.identity.tenantId, runId: context.runId, attemptId: context.attemptId,
      turnNo: context.turnNo, logicalCallId: call.logicalCallId, toolCallId: call.id,
      toolName: call.name, argsDigest: digest(call.arguments), capability: tool.capability,
      idempotencyKey: `${context.identity.tenantId}:${context.runId}:${call.logicalCallId}`,
      approvedInteractionId: interactionId, status: 'pending_approval', createdAt: now, updatedAt: now,
    };
  }
}

export interface PiToolOutputLimiterOptions {
  direction: 'head' | 'tail' | 'line';
  maxLines?: number;
  maxBytes?: number;
  maxChars?: number;
  saveOriginal?: (content: string) => Promise<string>;
}

export class PiToolOutputLimiter implements ToolOutputLimiter {
  constructor(private readonly options: PiToolOutputLimiterOptions) {}

  async limit(result: ToolResult, _tool?: RegisteredTool): Promise<ToolResult> {
    if (this.options.direction === 'line') {
      const limited = truncateLine(result.content, this.options.maxChars);
      return limited.wasTruncated ? { ...result, content: `${limited.text}\n[truncated:line]` } : result;
    }
    const limited = this.options.direction === 'head'
      ? truncateHead(result.content, { maxLines: this.options.maxLines, maxBytes: this.options.maxBytes })
      : truncateTail(result.content, { maxLines: this.options.maxLines, maxBytes: this.options.maxBytes });
    if (!limited.truncated) return result;
    const original = this.options.saveOriginal ? await this.options.saveOriginal(result.content) : undefined;
    const suffix = `[truncated:${limited.truncatedBy ?? 'unknown'}${original ? `; original=${original}` : ''}]`;
    return { ...result, content: `${limited.content}\n${suffix}` };
  }
}

class ResourceLocks {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

function result(callId: string, content: string, isError = false): ToolExecutionOutcome {
  return { kind: 'result', result: { callId, content, isError } };
}

function digest(value: JsonValue | string): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validate(value: JsonValue, schema: Record<string, unknown>): string | undefined {
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return 'expected object';
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
  if (required.length && value && typeof value === 'object' && !Array.isArray(value)) {
    const missing = required.find((name) => !(name in value));
    if (missing) return `missing required property ${missing}`;
  }
  return undefined;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}
