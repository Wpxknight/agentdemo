import { createHash } from 'node:crypto';
import type { JsonValue, ToolExecutionOutcome, ToolRuntime } from '@aiop/control-contracts';
import type { InteractionRepository, ToolLedgerRepository } from '@aiop/agent-runtime-core';
import {
  GovernedToolFactory,
  ResourceConcurrencyController,
  type GovernedToolDefinition,
  type ResourceConcurrency,
} from '@aiop/pi-runtime';
import type { RunAgentOptions } from '../run-types.js';
import { logger } from '../../logger.js';

export function createAIOPToolRuntime(
  options: RunAgentOptions,
  ledger: ToolLedgerRepository,
  concurrency: ResourceConcurrency,
  interactions?: InteractionRepository,
  commitLedgerUpdates = false,
): ToolRuntime {
  const durableGovernance = Boolean(interactions);
  const unified = options.tools.unified((call) => ({
    ...options.ctx,
    ...(options.onEvent ? {
      onOutput: ({ stream, text }: { stream: 'stdout' | 'stderr'; text: string }) =>
        options.onEvent?.({ type: 'tool_output', toolId: call.id, stream, text }),
      emitEvent: options.onEvent,
    } : {}),
    ...(options.askUser ? { askUser: options.askUser } : {}),
    ...(options.requestPlanApproval ? { requestPlanApproval: options.requestPlanApproval } : {}),
  }), options.filterToolDefs);
  const definitions: GovernedToolDefinition[] = unified.definitions().map((definition) => ({
    ...definition,
    interactionKind: durableGovernance ? interactionKind(definition.name) : undefined,
    execute: async (call, context) => {
      await options.runGuard?.();
      const result = await definition.execute(call, context);
      await options.runGuard?.();
      return { content: result.content, isError: result.isError };
    },
  }));
  const runtime = new GovernedToolFactory({
    ledger,
    concurrency,
    interactions,
    audit: {
      record: async (event) => {
        logger.info({ mod: 'pi-tool-audit', ...event }, 'governed tool outcome');
      },
      failure: (error, event) => {
        logger.warn({
          mod: 'pi-tool-audit', err: safeAuditError(error),
          tenantId: event.tenantId, runId: event.runId,
          toolCallId: event.toolCallId, status: event.status,
        }, 'governed tool audit sink failed');
      },
    },
    policy: {
      check: async (call) => {
        await options.runGuard?.();
        const decision = await options.policy.check({
          id: call.id, name: call.name, args: call.arguments,
        }, options.ctx);
        return {
          allowed: !decision.blocked,
          reason: decision.reason,
          needsApproval: decision.needApproval,
          resourceKey: resourceKey(call.name, call.arguments),
        };
      },
    },
    approval: {
      request: async (call, context, decision) => {
        if (!decision.needsApproval) return { approved: true };
        if (!durableGovernance) {
          const approved = options.approval
            ? await options.approval.request({
                call: { id: call.id, name: call.name, args: call.arguments },
                reason: decision.reason,
                ctx: options.ctx,
              })
            : false;
          return { approved };
        }
        const interactionId = createHash('sha256')
          .update(`${context.runId}\0approval\0${call.id}`)
          .digest('hex');
        return {
          approved: false,
          pending: true,
          interactionId,
          payload: {
            call: { id: call.id, name: call.name, args: call.arguments },
            reason: decision.reason ?? null,
          },
        };
      },
    },
  }).create(definitions);

  return {
    execute: async (call, context): Promise<ToolExecutionOutcome> => {
      const normalizedResolution = context.interactionResolution && options.durableInteractions
        ? await options.durableInteractions.wait(context.interactionResolution.interactionId)
        : undefined;
      const outcome = await runtime.execute(call, normalizedResolution === undefined ? context : {
        ...context,
        interactionResolution: {
          ...context.interactionResolution!,
          value: toJsonValue(normalizedResolution),
        },
      });
      if (commitLedgerUpdates) {
        for (const update of outcome.ledgerUpdates ?? []) await commitLedger(ledger, update);
      }
      if (!outcome.interactionUpdates?.length) return outcome;
      return {
        ...outcome,
        interactionUpdates: outcome.interactionUpdates.map((interaction) => {
          const base = {
            id: interaction.id,
            tenantId: interaction.tenantId,
            userId: interaction.userId ?? context.identity.actorId,
            sessionId: interaction.sessionId ?? context.sessionId ?? '',
            runId: interaction.runId,
            createdAt: interaction.createdAt.toISOString(),
          };
          const payload = interaction.kind === 'plan'
            ? {
                ...base,
                questions: [{
                  question: `请审批变更方案：${planSummary(interaction.payload)}`,
                  header: '变更审批',
                  options: [{ label: '批准' }, { label: '拒绝' }],
                }],
                plan: interaction.payload,
              }
            : { ...base, ...asObject(interaction.payload) };
          return {
            ...interaction,
            userId: interaction.userId ?? context.identity.actorId,
            sessionId: interaction.sessionId ?? context.sessionId,
            payload,
            expiresAt: interaction.expiresAt
              ?? new Date(interaction.createdAt.getTime() + 24 * 60 * 60 * 1000),
          };
        }),
      };
    },
  };
}

export function createCompatibilityAIOPToolRuntime(options: RunAgentOptions): ToolRuntime {
  return createAIOPToolRuntime(
    options,
    new MemoryToolLedger(),
    new ResourceConcurrencyController(),
    undefined,
    true,
  );
}

class MemoryToolLedger implements ToolLedgerRepository {
  private readonly records = new Map<string, import('@aiop/control-contracts').DurableToolLedgerUpdate>();

  async putIfAbsent(record: import('@aiop/control-contracts').DurableToolLedgerUpdate): Promise<boolean> {
    const key = ledgerKey(record);
    if (this.records.has(key)) return false;
    this.records.set(key, structuredClone(record));
    return true;
  }

  async get(input: { tenantId: string; runId: string; logicalCallId: string }) {
    return structuredClone(this.records.get(ledgerKey(input)));
  }

  async update(record: import('@aiop/control-contracts').DurableToolLedgerUpdate): Promise<void> {
    this.records.set(ledgerKey(record), structuredClone(record));
  }

  async claimPendingApproval(input: import('@aiop/agent-runtime-core').ToolLedgerApprovalClaim): Promise<boolean> {
    const key = ledgerKey(input);
    const current = this.records.get(key);
    if (!current || current.status !== 'pending_approval' || current.attemptId !== input.attemptId
      || current.turnNo !== input.turnNo || current.toolCallId !== input.toolCallId
      || current.toolName !== input.toolName || current.argsDigest !== input.argsDigest
      || current.approvedInteractionId !== input.approvedInteractionId) return false;
    this.records.set(key, structuredClone(input.started));
    return true;
  }
}

async function commitLedger(
  ledger: ToolLedgerRepository,
  update: import('@aiop/control-contracts').DurableToolLedgerUpdate,
): Promise<void> {
  const existing = await ledger.get(update);
  if (existing) await ledger.update(update);
  else await ledger.putIfAbsent(update);
}

function ledgerKey(input: { tenantId: string; runId: string; logicalCallId: string }): string {
  return `${input.tenantId}:${input.runId}:${input.logicalCallId}`;
}

function safeAuditError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interactionKind(name: string): 'question' | 'plan' | undefined {
  if (name === 'ask_user') return 'question';
  if (name === 'submit_change_plan') return 'plan';
  return undefined;
}

function resourceKey(toolName: string, args: JsonValue): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  for (const key of ['resourceKey', 'cluster', 'namespace', 'resource', 'target']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return `${toolName}:${key}:${value.trim()}`;
  }
  return undefined;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function planSummary(value: JsonValue): string {
  const summary = asObject(value).summary;
  return typeof summary === 'string' ? summary : '';
}
