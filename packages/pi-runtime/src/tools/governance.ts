import type {
  DurableToolLedgerUpdate,
  JsonValue,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionOutcome,
  ToolResult,
  ToolRuntime,
} from '@aiop/control-contracts';
import type { GovernedToolDefinition } from './adapter.js';
import type { ToolApproval, ToolApprovalDecision, ToolInteractionStore } from './approval.js';
import type { ToolAudit, ToolAuditEvent, ToolAuditStatus } from './audit.js';
import { ResourceConcurrencyController, type ResourceConcurrency } from './concurrency.js';
import { digestToolValue, type ToolLedgerStore } from './ledger.js';
import type { ToolPolicy, ToolPolicyDecision } from './policy.js';

export interface GovernedToolFactoryOptions {
  ledger: ToolLedgerStore;
  policy?: ToolPolicy;
  approval?: ToolApproval;
  interactions?: ToolInteractionStore;
  concurrency?: ResourceConcurrency;
  audit?: ToolAudit;
  now?: () => Date;
}

export class GovernedToolFactory {
  constructor(private readonly options: GovernedToolFactoryOptions) {}

  create(definitions: readonly GovernedToolDefinition[]): ToolRuntime {
    return new GovernedToolRuntime(this.options, definitions);
  }
}

class GovernedToolRuntime implements ToolRuntime {
  private readonly definitions = new Map<string, GovernedToolDefinition>();
  private readonly concurrency: ResourceConcurrency;
  private readonly now: () => Date;

  constructor(
    private readonly options: GovernedToolFactoryOptions,
    definitions: readonly GovernedToolDefinition[],
  ) {
    for (const definition of definitions) {
      if (this.definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
      this.definitions.set(definition.name, definition);
    }
    this.concurrency = options.concurrency ?? new ResourceConcurrencyController();
    this.now = options.now ?? (() => new Date());
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const startedAt = Date.now();
    try {
      const outcome = await this.executeGoverned(call, context);
      await this.recordAuditBestEffort(call, context, outcome, startedAt);
      return outcome;
    } catch (error) {
      await this.recordAuditBestEffort(call, context, undefined, startedAt, error);
      throw error;
    }
  }

  private async executeGoverned(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
    const tool = this.definitions.get(call.name);
    if (!tool) return result(call.id, `unknown tool: ${call.name}`, true);
    const policy = await this.options.policy?.check(call, context, tool) ?? { allowed: true };
    if (!policy.allowed) return result(
      call.id, `blocked by policy: ${policy.reason ?? 'denied'}`, true,
    );
    if (tool.interactionKind) return this.executeInteraction(call, context, tool, tool.interactionKind);

    const argsDigest = digestToolValue(call.arguments);
    const existing = await this.options.ledger.get({
      tenantId: context.identity.tenantId, runId: context.runId, logicalCallId: call.logicalCallId,
    });
    const mismatch = ledgerMismatch(existing, call, argsDigest, tool.capability);
    if (mismatch) return mismatch;
    if (existing?.status === 'completed' && existing.result) return { kind: 'result', result: existing.result };

    const trustedApproval = await this.trustedApproval(call, context, existing);
    if (trustedApproval?.outcome) return trustedApproval.outcome;
    if (existing?.status === 'pending_approval' && !trustedApproval) {
      return { kind: 'waiting', reason: 'approval', interactionId: existing.approvedInteractionId ?? 'pending' };
    }
    if (existing && existing.status !== 'pending_approval' && existing.capability === 'non_idempotent_write') {
      return {
        kind: 'recovery_required',
        correlationId: existing.externalCorrelationId,
        message: 'non-idempotent tool result is unknown and cannot be replayed automatically',
        ledgerUpdates: [{ ...existing, status: 'recovery_required', updatedAt: this.now() }],
      };
    }

    const approval = trustedApproval?.decision ?? await this.requestApproval(call, context, policy);
    if (!approval.approved) return this.handleUnapproved(call, context, tool, policy, approval);

    const record = this.startedRecord(call, context, tool, argsDigest, approval, existing);
    if (existing && trustedApproval) {
      const claimed = await this.options.ledger.claimPendingApproval({
        tenantId: existing.tenantId, runId: existing.runId, logicalCallId: existing.logicalCallId,
        attemptId: existing.attemptId, turnNo: existing.turnNo, toolCallId: existing.toolCallId,
        toolName: existing.toolName, argsDigest: existing.argsDigest,
        approvedInteractionId: existing.approvedInteractionId!, started: record,
      });
      if (!claimed) return this.claimLoser(call, context);
    } else if (existing) await this.options.ledger.update(record);
    else if (!await this.options.ledger.putIfAbsent(record)) return this.executeGoverned(call, context);

    const execute = async (): Promise<ToolExecutionOutcome> => {
      try {
        const raw = await tool.execute(call, { ...context, idempotencyKey: record.idempotencyKey });
        const toolResult: ToolResult = { ...raw, callId: call.id };
        return {
          kind: 'result', result: toolResult,
          ledgerUpdates: [{
            ...record, status: 'completed', result: toolResult,
            resultDigest: digestToolValue(toolResult.content), updatedAt: this.now(),
          }],
        };
      } catch (error) {
        if (tool.capability === 'non_idempotent_write') {
          return {
            kind: 'recovery_required', message: safeMessage(error),
            ledgerUpdates: [{ ...record, status: 'recovery_required', updatedAt: this.now() }],
          };
        }
        return result(call.id, safeMessage(error), true);
      }
    };
    const outcome = await this.concurrency.run({
      tenantId: context.identity.tenantId, resourceKey: policy.resourceKey, signal: context.signal,
    }, execute);
    return outcome;
  }

  private async requestApproval(
    call: ToolCall,
    context: ToolExecutionContext,
    policy: ToolPolicyDecision,
  ): Promise<ToolApprovalDecision> {
    if (this.options.approval) return this.options.approval.request(call, context, policy);
    return { approved: !policy.needsApproval };
  }

  private async handleUnapproved(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: GovernedToolDefinition,
    policy: ToolPolicyDecision,
    approval: ToolApprovalDecision,
  ): Promise<ToolExecutionOutcome> {
    if (approval.pending && approval.interactionId) {
      const pending = this.pendingRecord(call, context, tool, approval.interactionId);
      return {
        kind: 'waiting', reason: 'approval', interactionId: approval.interactionId,
        ledgerUpdates: [pending],
        interactionUpdates: [{
          tenantId: context.identity.tenantId, runId: context.runId, id: approval.interactionId,
          userId: context.identity.actorId, sessionId: context.sessionId,
          attemptId: context.attemptId, turnNo: context.turnNo, kind: 'approval',
          toolCallId: call.id, status: 'pending',
          payload: approval.payload ?? {
            call: { id: call.id, name: call.name, args: call.arguments },
            reason: policy.reason ?? null,
          },
          createdAt: this.now(),
        }],
      };
    }
    if (approval.interactionId) {
      return this.completeDenied(call, context, tool, approval.interactionId);
    }
    return result(
      call.id, `needs approval: ${policy.reason ?? 'denied'}`, true,
    );
  }

  private async trustedApproval(
    call: ToolCall,
    context: ToolExecutionContext,
    existing: DurableToolLedgerUpdate | undefined,
  ): Promise<{
    decision?: ToolApprovalDecision;
    outcome?: ToolExecutionOutcome;
  } | undefined> {
    const resolution = context.interactionResolution;
    if (!resolution) return undefined;
    if (resolution.kind !== 'approval' || resolution.toolCallId !== call.id || typeof resolution.value !== 'boolean') {
      return { outcome: { kind: 'recovery_required', message: 'approval resolution does not match the pending tool call' } };
    }
    if (!existing || existing.status !== 'pending_approval'
      || existing.toolCallId !== call.id || existing.approvedInteractionId !== resolution.interactionId) {
      return { outcome: { kind: 'recovery_required', message: 'approval resolution has no matching pending ledger record' } };
    }
    const interaction = await this.options.interactions?.get({
      tenantId: context.identity.tenantId,
      runId: context.runId,
      interactionId: resolution.interactionId,
    });
    if (!interaction || interaction.tenantId !== context.identity.tenantId || interaction.runId !== context.runId
      || interaction.id !== resolution.interactionId || interaction.kind !== 'approval'
      || interaction.status !== 'resolved' || interaction.attemptId !== existing.attemptId
      || interaction.turnNo !== existing.turnNo
      || interaction.toolCallId !== existing.toolCallId || interaction.toolCallId !== call.id
      || interaction.resolution !== resolution.value) {
      return { outcome: { kind: 'recovery_required', message: 'approval resolution is not bound to the pending interaction' } };
    }
    const payloadIdentity = approvalPayloadIdentity(interaction.payload);
    const callArgsDigest = digestToolValue(call.arguments);
    if (!payloadIdentity || payloadIdentity.name !== call.name || payloadIdentity.name !== existing.toolName
      || payloadIdentity.argsDigest !== callArgsDigest || payloadIdentity.argsDigest !== existing.argsDigest
      || payloadIdentity.toolCallIds.some((toolCallId) => toolCallId !== call.id || toolCallId !== existing.toolCallId)) {
      return { outcome: { kind: 'recovery_required', message: 'approval payload is not bound to the pending tool call' } };
    }
    return { decision: { approved: resolution.value, interactionId: resolution.interactionId } };
  }

  private async completeDenied(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: GovernedToolDefinition,
    interactionId: string,
  ): Promise<ToolExecutionOutcome> {
    const existing = await this.options.ledger.get({
      tenantId: context.identity.tenantId, runId: context.runId, logicalCallId: call.logicalCallId,
    });
    const mismatch = ledgerMismatch(existing, call, digestToolValue(call.arguments), tool.capability);
    if (mismatch) return mismatch;
    if (!existing || existing.status !== 'pending_approval' || existing.approvedInteractionId !== interactionId) {
      return { kind: 'recovery_required', message: 'approval resolution does not match the pending tool call' };
    }
    const toolResult: ToolResult = { callId: call.id, content: 'approval denied', isError: true };
    return {
      kind: 'result', result: toolResult,
      ledgerUpdates: [{
        ...existing, attemptId: context.attemptId, turnNo: context.turnNo, toolCallId: call.id,
        status: 'completed', result: toolResult, resultDigest: digestToolValue(toolResult.content), updatedAt: this.now(),
      }],
    };
  }

  private async claimLoser(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionOutcome> {
    const current = await this.options.ledger.get({
      tenantId: context.identity.tenantId, runId: context.runId, logicalCallId: call.logicalCallId,
    });
    if (current?.status === 'completed' && current.result) return { kind: 'result', result: current.result };
    if (current?.status === 'pending_approval') {
      return { kind: 'waiting', reason: 'approval', interactionId: current.approvedInteractionId ?? 'pending' };
    }
    return {
      kind: 'recovery_required', correlationId: current?.externalCorrelationId,
      message: current?.status === 'started'
        ? 'approved tool execution is already in progress'
        : 'approved tool execution could not be claimed',
    };
  }

  private async executeInteraction(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: GovernedToolDefinition,
    kind: 'question' | 'plan',
  ): Promise<ToolExecutionOutcome> {
    const existing = await this.options.ledger.get({
      tenantId: context.identity.tenantId, runId: context.runId, logicalCallId: call.logicalCallId,
    });
    const mismatch = ledgerMismatch(existing, call, digestToolValue(call.arguments), tool.capability);
    if (mismatch) return mismatch;
    if (existing?.status === 'completed' && existing.result) return { kind: 'result', result: existing.result };
    if (!context.interactionResolution) {
      const interactionId = existing?.approvedInteractionId
        ?? digestToolValue(`${context.identity.tenantId}:${context.runId}:${call.logicalCallId}:${kind}`);
      const pending = existing ?? this.pendingRecord(call, context, tool, interactionId);
      return {
        kind: 'waiting', reason: kind, interactionId,
        ledgerUpdates: existing ? undefined : [pending],
        interactionUpdates: existing ? undefined : [{
          tenantId: context.identity.tenantId, runId: context.runId, id: interactionId,
          userId: context.identity.actorId, sessionId: context.sessionId,
          attemptId: context.attemptId, turnNo: context.turnNo, kind,
          toolCallId: call.id, status: 'pending', payload: call.arguments, createdAt: this.now(),
        }],
      };
    }
    const resolution = context.interactionResolution;
    if (resolution.kind !== kind || resolution.toolCallId !== call.id || !existing
      || existing.status !== 'pending_approval' || existing.approvedInteractionId !== resolution.interactionId) {
      return { kind: 'recovery_required', message: 'interaction resolution does not match the pending tool call' };
    }
    const interaction = await this.options.interactions?.get({
      tenantId: context.identity.tenantId,
      runId: context.runId,
      interactionId: resolution.interactionId,
    });
    if (!interaction || interaction.tenantId !== context.identity.tenantId || interaction.runId !== context.runId
      || interaction.id !== resolution.interactionId || interaction.kind !== kind
      || interaction.status !== 'resolved' || interaction.attemptId !== existing.attemptId
      || interaction.turnNo !== existing.turnNo || interaction.toolCallId !== existing.toolCallId
      || interaction.toolCallId !== call.id
      || digestToolValue(interaction.resolution ?? null) !== digestToolValue(resolution.value)) {
      return { kind: 'recovery_required', message: 'interaction resolution is not bound to the pending interaction' };
    }
    const callArgsDigest = digestToolValue(call.arguments);
    if (digestToolValue(interaction.payload) !== callArgsDigest || existing.argsDigest !== callArgsDigest) {
      return { kind: 'recovery_required', message: 'interaction payload is not bound to the pending tool call' };
    }
    const toolResult: ToolResult = {
      callId: call.id, content: `${kind} resolved: ${stableJson(resolution.value)}`,
    };
    return {
      kind: 'result', result: toolResult,
      ledgerUpdates: [{
        ...existing, attemptId: context.attemptId, turnNo: context.turnNo, toolCallId: call.id,
        status: 'completed', result: toolResult, resultDigest: digestToolValue(toolResult.content), updatedAt: this.now(),
      }],
    };
  }

  private pendingRecord(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: GovernedToolDefinition,
    interactionId: string,
  ): DurableToolLedgerUpdate {
    const now = this.now();
    return {
      tenantId: context.identity.tenantId, runId: context.runId, attemptId: context.attemptId,
      turnNo: context.turnNo, logicalCallId: call.logicalCallId, toolCallId: call.id,
      toolName: call.name, argsDigest: digestToolValue(call.arguments), capability: tool.capability,
      idempotencyKey: `${context.identity.tenantId}:${context.runId}:${call.logicalCallId}`,
      approvedInteractionId: interactionId, status: 'pending_approval', createdAt: now, updatedAt: now,
    };
  }

  private startedRecord(
    call: ToolCall,
    context: ToolExecutionContext,
    tool: GovernedToolDefinition,
    argsDigest: string,
    approval: ToolApprovalDecision,
    existing?: DurableToolLedgerUpdate,
  ): DurableToolLedgerUpdate {
    const now = this.now();
    if (existing) {
      return {
        ...existing, attemptId: context.attemptId, turnNo: context.turnNo,
        toolCallId: call.id, status: 'started', updatedAt: now,
      };
    }
    return {
      tenantId: context.identity.tenantId, runId: context.runId, attemptId: context.attemptId,
      turnNo: context.turnNo, logicalCallId: call.logicalCallId, toolCallId: call.id,
      toolName: call.name, argsDigest, capability: tool.capability,
      idempotencyKey: `${context.identity.tenantId}:${context.runId}:${call.logicalCallId}`,
      approvedInteractionId: approval.interactionId, status: 'started', createdAt: now, updatedAt: now,
    };
  }

  private async recordAuditBestEffort(
    call: ToolCall,
    context: ToolExecutionContext,
    outcome: ToolExecutionOutcome | undefined,
    startedAt: number,
    error?: unknown,
  ): Promise<void> {
    if (!this.options.audit) return;
    const tool = this.definitions.get(call.name);
    const status = auditStatus(outcome, error);
    const event: ToolAuditEvent = {
      tenantId: context.identity.tenantId, actorId: context.identity.actorId,
      runId: context.runId, attemptId: context.attemptId, turnNo: context.turnNo,
      sessionId: context.sessionId, toolName: call.name, toolCallId: call.id,
      logicalCallId: call.logicalCallId, capability: tool?.capability,
      argsDigest: digestToolValue(call.arguments), status,
      outcomeKind: outcome?.kind ?? 'exception',
      isError: Boolean(error) || outcome?.kind === 'recovery_required'
        || (outcome?.kind === 'result' && outcome.result.isError === true),
      errorCode: auditErrorCode(status),
      resultDigest: outcome?.kind === 'result' ? digestToolValue(outcome.result.content) : undefined,
      durationMs: Math.max(0, Date.now() - startedAt), recordedAt: this.now(),
    };
    try {
      await this.options.audit.record(event);
    } catch (auditError) {
      try {
        this.options.audit.failure?.(auditError, event);
      } catch {
        // Both audit hooks are best-effort and must never affect durable execution facts.
      }
    }
  }
}

function auditStatus(outcome: ToolExecutionOutcome | undefined, error?: unknown): ToolAuditStatus {
  if (error || !outcome) return 'internal_error';
  if (outcome.kind === 'waiting') return 'approval_waiting';
  if (outcome.kind === 'recovery_required') {
    if (outcome.message === 'logical tool call identity changed across attempts') return 'ledger_mismatch';
    if (outcome.message.includes('approval') || outcome.message.includes('interaction resolution')) return 'invalid_resolution';
    return 'recovery_required';
  }
  if (outcome.result.content.startsWith('unknown tool:')) return 'unknown_tool';
  if (outcome.result.content.startsWith('blocked by policy:')) return 'policy_denied';
  if (outcome.result.isError) return 'failure';
  return outcome.ledgerUpdates?.some((update) => update.status === 'completed') ? 'success' : 'cached_completed';
}

function auditErrorCode(status: ToolAuditStatus): string | undefined {
  return status === 'success' || status === 'cached_completed' || status === 'approval_waiting'
    ? undefined
    : status.toUpperCase();
}

function ledgerMismatch(
  existing: DurableToolLedgerUpdate | undefined,
  call: ToolCall,
  argsDigest: string,
  capability: GovernedToolDefinition['capability'],
): ToolExecutionOutcome | undefined {
  if (existing && (existing.toolName !== call.name || existing.argsDigest !== argsDigest
    || existing.capability !== capability)) {
    return { kind: 'recovery_required', message: 'logical tool call identity changed across attempts' };
  }
  return undefined;
}

function result(callId: string, content: string, isError = false): ToolExecutionOutcome {
  return { kind: 'result', result: { callId, content, isError } };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function approvalPayloadIdentity(payload: JsonValue): {
  name: string;
  argsDigest: string;
  toolCallIds: string[];
} | undefined {
  if (!isJsonObject(payload) || !isJsonObject(payload.call)) return undefined;
  const pendingCall = payload.call;
  if (typeof pendingCall.name !== 'string' || !Object.hasOwn(pendingCall, 'args')
    || !isJsonValue(pendingCall.args)) return undefined;
  const toolCallIds: string[] = [];
  for (const key of ['id', 'toolCallId'] as const) {
    if (!Object.hasOwn(pendingCall, key)) continue;
    if (typeof pendingCall[key] !== 'string' || pendingCall[key].length === 0) return undefined;
    toolCallIds.push(pendingCall[key]);
  }
  if (toolCallIds.length === 0) return undefined;
  return { name: pendingCall.name, argsDigest: digestToolValue(pendingCall.args), toolCallIds };
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
