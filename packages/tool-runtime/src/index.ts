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
  interactionKind?: 'question' | 'plan';
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

export class ToolRuntimeEngine implements ToolRuntime {
  private readonly definitions = new Map<string, RegisteredTool>();
  private readonly concurrency: ToolConcurrencyController;
  private readonly now: () => Date;

  constructor(private readonly options: ToolRuntimeEngineOptions) {
    for (const definition of options.definitions) {
      if (this.definitions.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
      this.definitions.set(definition.name, definition);
    }
    this.now = options.now ?? (() => new Date());
    this.concurrency = options.concurrencyController ?? new ToolConcurrencyController(options.concurrency);
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const tool = this.definitions.get(call.name);
    if (!tool) return result(call.id, `unknown tool: ${call.name}`, true);
    const validation = validate(call.arguments, tool.inputSchema);
    if (validation) return result(call.id, `invalid arguments: ${validation}`, true);

    const policy = await this.options.policy?.check(call, context, tool) ?? { allowed: true };
    if (!policy.allowed) return result(call.id, `blocked by policy: ${policy.reason ?? 'denied'}`, true);

    if (tool.interactionKind) return this.executeInteractionTool(call, context, tool, tool.interactionKind, policy);

    const trustedApproval = this.trustedApproval(call, context);
    if (trustedApproval?.kind === 'invalid') return trustedApproval.outcome;

    const approval = trustedApproval?.decision ?? (this.options.approval
      ? await this.options.approval.request(call, context, policy)
      : { approved: !policy.needsApproval });
    if (!approval.approved) {
      if (approval.pending && approval.interactionId) {
        const pending = this.pendingApproval(call, context, tool, approval.interactionId);
        const interaction = {
          tenantId: context.identity.tenantId,
          runId: context.runId,
          id: approval.interactionId,
          userId: context.identity.actorId,
          sessionId: context.sessionId,
          attemptId: context.attemptId,
          turnNo: context.turnNo,
          kind: 'approval' as const,
          toolCallId: call.id,
          status: 'pending' as const,
          payload: approval.payload ?? { toolName: call.name, reason: policy.reason ?? null },
          createdAt: this.now(),
        };
        return {
          kind: 'waiting', reason: 'approval', interactionId: approval.interactionId,
          ledgerUpdates: [pending], interactionUpdates: [interaction],
        };
      }
      if (trustedApproval?.decision.interactionId) {
        return this.completeWithoutExecution(
          call, context, tool, trustedApproval.decision.interactionId, 'approval denied', true,
        );
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
      if (existing.status === 'pending_approval' && !trustedApproval?.decision.approved) {
        return { kind: 'waiting', reason: 'approval', interactionId: existing.approvedInteractionId ?? 'pending' };
      }
      if (existing.status !== 'pending_approval' && existing.capability === 'non_idempotent_write') {
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
      outcome = await this.concurrency.run({
        tenantId: context.identity.tenantId,
        toolName: tool.name,
        resourceKey: policy.resourceKey ?? (tool.capability === 'read' ? undefined : call.name),
        signal: context.signal,
      }, execute);
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

  private async executeInteractionTool(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: RegisteredTool,
    interactionKind: 'question' | 'plan',
    _policy: PolicyDecision,
  ): Promise<ToolExecutionOutcome> {
    this.options.onLedger?.();
    const existing = await this.options.ledger.get({
      tenantId: context.identity.tenantId, runId: context.runId, logicalCallId: call.logicalCallId,
    });
    const mismatch = this.ledgerMismatch(existing, call);
    if (mismatch) return mismatch;
    if (existing?.status === 'completed' && existing.result) return { kind: 'result', result: existing.result };

    const resolution = context.interactionResolution;
    if (!resolution) {
      const interactionId = existing?.approvedInteractionId
        ?? digest(`${context.identity.tenantId}:${context.runId}:${call.logicalCallId}:${interactionKind}`);
      const pending = existing ?? this.pendingApproval(call, context, tool, interactionId, false);
      return {
        kind: 'waiting', reason: interactionKind, interactionId,
        ledgerUpdates: existing ? undefined : [pending],
        interactionUpdates: existing ? undefined : [{
          tenantId: context.identity.tenantId, runId: context.runId, id: interactionId,
          userId: context.identity.actorId, sessionId: context.sessionId,
          attemptId: context.attemptId, turnNo: context.turnNo, kind: interactionKind,
          toolCallId: call.id, status: 'pending', payload: call.arguments, createdAt: this.now(),
        }],
      };
    }
    if (resolution.kind !== interactionKind || resolution.toolCallId !== call.id
      || !existing || existing.status !== 'pending_approval'
      || existing.approvedInteractionId !== resolution.interactionId) {
      return { kind: 'recovery_required', message: 'interaction resolution does not match the pending tool call' };
    }
    const content = `${interactionKind} resolved: ${stable(resolution.value)}`;
    const outcome = this.completedOutcome(call, context, existing, content);
    await this.options.audit?.record({ call, context, capability: tool.capability, outcome });
    return outcome;
  }

  private trustedApproval(
    call: ToolCall,
    context: ToolExecutionContext,
  ): { kind: 'valid'; decision: ApprovalDecision } | { kind: 'invalid'; outcome: ToolExecutionOutcome } | undefined {
    const resolution = context.interactionResolution;
    if (!resolution) return undefined;
    if (resolution.kind !== 'approval' || resolution.toolCallId !== call.id || typeof resolution.value !== 'boolean') {
      return {
        kind: 'invalid',
        outcome: { kind: 'recovery_required', message: 'approval resolution does not match the pending tool call' },
      };
    }
    return {
      kind: 'valid',
      decision: { approved: resolution.value, interactionId: resolution.interactionId },
    };
  }

  private async completeWithoutExecution(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: RegisteredTool,
    interactionId: string,
    content: string,
    isError: boolean,
  ): Promise<ToolExecutionOutcome> {
    this.options.onLedger?.();
    const existing = await this.options.ledger.get({
      tenantId: context.identity.tenantId, runId: context.runId, logicalCallId: call.logicalCallId,
    });
    const mismatch = this.ledgerMismatch(existing, call);
    if (mismatch) return mismatch;
    if (!existing || existing.status !== 'pending_approval' || existing.approvedInteractionId !== interactionId) {
      return { kind: 'recovery_required', message: 'approval resolution does not match the pending tool call' };
    }
    const outcome = this.completedOutcome(call, context, existing, content, isError);
    await this.options.audit?.record({ call, context, capability: tool.capability, outcome });
    return outcome;
  }

  private completedOutcome(
    call: ToolCall,
    context: ToolExecutionContext,
    existing: ToolLedgerRecord,
    content: string,
    isError = false,
  ): ToolExecutionOutcome {
    const toolResult: ToolResult = { callId: call.id, content, isError };
    const completed: ToolLedgerRecord = {
      ...existing, attemptId: context.attemptId, turnNo: context.turnNo, toolCallId: call.id,
      status: 'completed', result: toolResult, resultDigest: digest(content), updatedAt: this.now(),
    };
    return { kind: 'result', result: toolResult, ledgerUpdates: [completed] };
  }

  private ledgerMismatch(existing: ToolLedgerRecord | undefined, call: ToolCall): ToolExecutionOutcome | undefined {
    if (existing && (existing.toolName !== call.name || existing.argsDigest !== digest(call.arguments))) {
      return { kind: 'recovery_required', message: 'logical tool call identity changed across attempts' };
    }
    return undefined;
  }

  private pendingApproval(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: RegisteredTool,
    interactionId: string,
    notify = true,
  ): ToolLedgerRecord {
    if (notify) this.options.onLedger?.();
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

export class ToolConcurrencyController {
  private readonly tenant = new SemaphorePool();
  private readonly tool = new SemaphorePool();
  private readonly resource = new SemaphorePool();

  constructor(private readonly limits: ConcurrencyLimits = {}) {}

  async run<T>(
    input: { tenantId: string; toolName: string; resourceKey?: string; signal?: AbortSignal },
    work: () => Promise<T>,
  ): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      if (this.limits.maxConcurrentPerTenant !== undefined) {
        releases.push(await this.tenant.acquire(
          `tenant:${input.tenantId}`, positiveLimit(this.limits.maxConcurrentPerTenant), input.signal,
        ));
      }
      if (this.limits.maxConcurrentPerTool !== undefined) {
        releases.push(await this.tool.acquire(
          `tool:${input.tenantId}:${input.toolName}`, positiveLimit(this.limits.maxConcurrentPerTool), input.signal,
        ));
      }
      const resourceLimit = this.limits.maxConcurrentPerResource ?? (input.resourceKey ? 1 : undefined);
      if (resourceLimit !== undefined && input.resourceKey) {
        releases.push(await this.resource.acquire(
          `resource:${input.tenantId}:${input.resourceKey}`, positiveLimit(resourceLimit), input.signal,
        ));
      }
      return await work();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}

class SemaphorePool {
  private readonly semaphores = new Map<string, FifoSemaphore>();

  async acquire(key: string, limit: number, signal?: AbortSignal): Promise<() => void> {
    const semaphore = this.semaphores.get(key) ?? new FifoSemaphore(limit);
    if (semaphore.limit !== limit) throw new Error(`Concurrency limit changed for ${key}`);
    this.semaphores.set(key, semaphore);
    const release = await semaphore.acquire(signal);
    return () => {
      release();
      if (semaphore.idle) this.semaphores.delete(key);
    };
  }
}

class FifoSemaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(readonly limit: number) {}

  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined as (() => void) | undefined };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      this.active++;
      waiter.resolve(this.releaseOnce());
    }
  }
}

function positiveLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Concurrency limit must be a positive integer: ${value}`);
  return value;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error(typeof signal?.reason === 'string' && signal.reason ? signal.reason : 'Tool execution aborted');
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
