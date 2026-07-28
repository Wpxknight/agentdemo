import { createHash } from 'node:crypto';
import type { JsonValue, ToolExecutionOutcome, ToolRuntime } from '@aiop/control-contracts';
import type { ToolLedgerRepository } from '@aiop/agent-runtime-core';
import {
  GovernedToolFactory,
  type GovernedToolDefinition,
  type ResourceConcurrency,
} from '@aiop/pi-runtime';
import type { RunAgentOptions } from '../run-types.js';

export function createAIOPToolRuntime(
  options: RunAgentOptions,
  ledger: ToolLedgerRepository,
  concurrency: ResourceConcurrency,
): ToolRuntime {
  const definitions: GovernedToolDefinition[] = options.tools.defs().map((definition) => ({
    ...definition,
    capability: definition.capability ?? 'non_idempotent_write',
    interactionKind: interactionKind(definition.name),
    execute: async (call, context) => {
      await options.runGuard?.();
      const result = await options.tools.dispatch({
        id: call.id, name: call.name, args: call.arguments,
      }, {
        ...options.ctx,
        idempotencyKey: context.idempotencyKey,
        ...(options.onEvent ? {
          onOutput: ({ stream, text }: { stream: 'stdout' | 'stderr'; text: string }) =>
            options.onEvent?.({ type: 'tool_output', toolId: call.id, stream, text }),
          emitEvent: options.onEvent,
        } : {}),
        ...(options.askUser ? { askUser: options.askUser } : {}),
        ...(options.requestPlanApproval ? { requestPlanApproval: options.requestPlanApproval } : {}),
      });
      await options.runGuard?.();
      return { content: result.content, isError: result.isError };
    },
  }));
  const runtime = new GovernedToolFactory({
    ledger,
    concurrency,
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
