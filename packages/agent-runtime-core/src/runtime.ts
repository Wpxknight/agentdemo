import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AgentPlatformError,
  type AgentKernelName,
  type AgentRunEvent,
  type AgentRunResult,
  type CancelRunInput,
  type ResumeRunInput,
  type ResolvedInteraction,
  type RunLimits,
  type RunHandle,
  type RuntimeObservation,
  type StartRunInput,
  type ToolDefinition,
} from '@aiop/control-contracts';
import type { AgentKernel, KernelEvent, KernelMessage, ModelBinding } from './kernel.js';
import type { RunIdentity, RunRecord, RuntimeStore, TurnCommit, TurnSnapshot } from './store.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } as const;

export interface DurableAgentRuntimeOptions {
  store: RuntimeStore;
  kernels: readonly AgentKernel[];
  defaultKernel: AgentKernelName;
  workerId?: string;
  runtimeVersion?: string;
  modelBinding?: ModelBinding;
  tools?: readonly ToolDefinition[];
  promptVersion?: string;
  skillSetVersion?: string;
  toolSetVersion?: string;
  policyVersion?: string;
  leaseTtlMs?: number;
  maxDurableEventsPerTurn?: number;
  now?: () => Date;
  observeEvent?: (event: KernelEvent) => void | Promise<void>;
  observe?: (observation: RuntimeObservation) => void | Promise<void>;
}

export interface DurableRuntimeStartRunInput extends StartRunInput {
  messages?: readonly KernelMessage[];
}

export class DurableAgentRuntime {
  private readonly kernels = new Map<string, AgentKernel>();
  private readonly active = new Map<string, AbortController>();
  private readonly workerId: string;
  private readonly runtimeVersion: string;
  private readonly modelBinding: ModelBinding;
  private readonly tools: readonly ToolDefinition[];
  private readonly promptVersion: string;
  private readonly skillSetVersion?: string;
  private readonly toolSetVersion: string;
  private readonly policyVersion: string;
  private readonly leaseTtlMs: number;
  private readonly leaseHeartbeatMs: number;
  private readonly maxDurableEventsPerTurn: number;
  private readonly now: () => Date;
  private readonly executions = new Map<string, Promise<AgentRunResult>>();

  constructor(private readonly options: DurableAgentRuntimeOptions) {
    for (const kernel of options.kernels) this.kernels.set(kernel.descriptor.name, kernel);
    this.workerId = options.workerId ?? `${process.pid}:${randomUUID()}`;
    this.runtimeVersion = options.runtimeVersion ?? '1';
    this.modelBinding = options.modelBinding ?? { provider: 'injected', model: 'default' };
    this.tools = options.tools ?? [];
    this.promptVersion = options.promptVersion ?? 'default';
    this.skillSetVersion = options.skillSetVersion;
    this.toolSetVersion = options.toolSetVersion ?? 'default';
    this.policyVersion = options.policyVersion ?? 'default';
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.leaseHeartbeatMs = Math.max(1, Math.floor(this.leaseTtlMs / 3));
    this.maxDurableEventsPerTurn = options.maxDurableEventsPerTurn ?? 256;
    this.now = options.now ?? (() => new Date());
  }

  async run(input: DurableRuntimeStartRunInput): Promise<RunHandle> {
    const kernel = this.resolveKernel(input.kernel ?? this.options.defaultKernel);
    const runId = input.runId ?? randomUUID();
    const now = this.now();
    const created: RunRecord = {
      tenantId: input.identity.tenantId,
      runId,
      actorId: input.identity.actorId,
      sessionId: input.sessionId,
      kernel: kernel.descriptor.name,
      kernelVersion: kernel.descriptor.version,
      runtimeVersion: this.runtimeVersion,
      status: 'queued',
      leaseToken: 0n,
      usage: { ...ZERO_USAGE },
      createdAt: now,
      updatedAt: now,
    };
    const existing = await this.options.store.runs.get({ tenantId: input.identity.tenantId, runId });
    if (existing && (existing.actorId !== input.identity.actorId || existing.sessionId !== input.sessionId
      || existing.kernel !== kernel.descriptor.name || existing.kernelVersion !== kernel.descriptor.version)) {
      throw new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message: 'Existing run binding does not match', retryable: false });
    }
    const record = existing ?? created;
    if (!existing) await this.options.store.runs.create(record);
    const messages = input.messages ?? input.input.map<KernelMessage>((message) => ({
      role: 'user',
      content: message.content ?? (message.text === undefined ? [] : [{ type: 'text', text: message.text }]),
    }));
    return this.startHandle(record, kernel, {
      ...input.identity, correlationId: input.identity.correlationId ?? runId,
    }, messages, false, input.signal, input.limits);
  }

  async resume(input: ResumeRunInput): Promise<RunHandle> {
    const identity = { tenantId: input.identity.tenantId, runId: input.runId };
    const record = await this.options.store.runs.get(identity);
    if (!record || record.actorId !== input.identity.actorId) throw notFound();
    if (!['waiting', 'failed', 'recovery_required'].includes(record.status)) {
      throw new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message: `Run cannot resume from ${record.status}`, retryable: true });
    }
    const kernel = this.resolveKernel(record.kernel, record.kernelVersion);
    const last = await this.options.store.turns.getLastCommitted(identity);
    if (!last) throw new AgentPlatformError({ code: 'TURN_COMMIT_FAILED', message: 'No committed turn to resume', retryable: false });
    const snapshot = await this.options.store.turns.getSnapshot({
      ...identity, attemptId: last.attemptId, turnNo: last.turnNo,
    });
    if (!snapshot) {
      throw new AgentPlatformError({ code: 'TURN_COMMIT_FAILED', message: 'Committed turn snapshot is missing', retryable: false });
    }
    if (!input.resolution) {
      const pending = (await this.options.store.interactions.list(identity))
        .find((interaction) => interaction.status === 'pending');
      if (pending) {
        throw new AgentPlatformError({
          code: 'RUN_STATE_CONFLICT',
          message: `Pending Interaction ${pending.id} requires a trusted resolution`,
          retryable: false,
        });
      }
    }
    await this.assertAttemptBudget(identity, snapshot.limits);
    let interactionResolution: ResolvedInteraction | undefined;
    if (input.resolution) {
      const interaction = await this.options.store.interactions.get({ ...identity, interactionId: input.resolution.interactionId });
      if (!interaction) {
        throw new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message: 'Interaction does not exist', retryable: false });
      }
      if (!interaction.toolCallId) {
        throw new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message: 'Interaction tool call is missing', retryable: false });
      }
      if (interaction.status === 'pending') {
        await this.options.store.interactions.put({
          ...interaction, status: 'resolved', resolution: input.resolution.value, resolvedAt: this.now(),
        });
      } else if (interaction.status !== 'resolved' || !isDeepStrictEqual(interaction.resolution, input.resolution.value)) {
        throw new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message: 'Interaction resolution conflicts', retryable: false });
      }
      interactionResolution = {
        interactionId: interaction.id,
        kind: interaction.kind,
        toolCallId: interaction.toolCallId,
        value: input.resolution.value,
      };
    }
    const messages = (last.stopReason === 'error' || last.stopReason === 'aborted')
      && last.messages.at(-1)?.role === 'assistant'
      ? last.messages.slice(0, -1)
      : last.messages;
    return this.startHandle(record, kernel, {
      ...input.identity, correlationId: input.identity.correlationId ?? snapshot.identity.correlationId ?? input.runId,
    }, messages, true, input.signal, snapshot.limits, interactionResolution);
  }

  async cancel(input: CancelRunInput): Promise<void> {
    const identity = { tenantId: input.identity.tenantId, runId: input.runId };
    const record = await this.options.store.runs.get(identity);
    if (!record || record.actorId !== input.identity.actorId) throw notFound();
    if (!['queued', 'running', 'waiting'].includes(record.status)) {
      throw new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message: `Run cannot cancel from ${record.status}`, retryable: false });
    }
    const now = this.now();
    await this.options.store.runs.update(identity, { cancelRequestedAt: now, updatedAt: now });
    this.active.get(runKey(identity))?.abort(new Error(input.reason ?? 'Agent run cancelled'));
    if (record.status !== 'running') await this.options.store.runs.update(identity, { status: 'cancelled', updatedAt: now });
  }

  async shutdown(reason = 'Agent runtime shutdown'): Promise<void> {
    for (const controller of this.active.values()) controller.abort(new Error(reason));
    await Promise.allSettled([...this.executions.values()]);
  }

  private startHandle(
    record: RunRecord,
    kernel: AgentKernel,
    identityContext: StartRunInput['identity'],
    messages: readonly KernelMessage[],
    continuation: boolean,
    externalSignal?: AbortSignal,
    limits?: RunLimits,
    interactionResolution?: ResolvedInteraction,
  ): RunHandle {
    const identity = { tenantId: record.tenantId, runId: record.runId };
    const key = runKey(identity);
    let settled = false;
    const resultPromise = this.execute(
      record, kernel, identityContext, messages, continuation, externalSignal, limits, interactionResolution,
    ).finally(() => {
      settled = true;
      this.executions.delete(key);
    });
    this.executions.set(key, resultPromise);
    return {
      runId: record.runId,
      status: record.status,
      events: this.eventStream(identity, () => settled),
      result: () => resultPromise,
    };
  }

  private async execute(
    record: RunRecord,
    kernel: AgentKernel,
    identityContext: StartRunInput['identity'],
    messages: readonly KernelMessage[],
    continuation: boolean,
    externalSignal?: AbortSignal,
    limits?: RunLimits,
    interactionResolution?: ResolvedInteraction,
  ): Promise<AgentRunResult> {
    const identity = { tenantId: record.tenantId, runId: record.runId };
    const controller = new AbortController();
    this.active.set(runKey(identity), controller);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    await this.assertAttemptBudget(identity, limits);
    const attemptId = randomUUID();
    const correlationId = identityContext.correlationId ?? record.runId;
    const runStartedAt = this.now();
    const lease = await this.options.store.runs.acquireLease(identity, this.workerId, this.now(), this.leaseTtlMs);
    if (!lease) throw new AgentPlatformError({ code: 'LEASE_LOST', message: 'Run is owned by another worker', retryable: false });
    let previous = await this.options.store.turns.getLastCommitted(identity);
    let turnNo = (previous?.turnNo ?? 0) + 1;
    let currentMessages = messages;
    let currentContinuation = continuation;
    let aggregateUsage = { ...(previous?.usage ?? record.usage) };
    let toolCalls = (await this.options.store.events.list(identity))
      .filter((event) => event.type === 'tool_call').length;
    let snapshot = this.snapshot({
      identity, attemptId, turnNo, identityContext, messages: currentMessages, previous, limits,
    });
    await this.options.store.transaction(async (tx) => {
      await tx.runs.update(identity, { status: 'running', waitingReason: undefined, updatedAt: this.now() });
      await tx.attempts.create({
        ...identity, attemptId, workerId: this.workerId, leaseToken: lease.token,
        kernel: kernel.descriptor.name, kernelVersion: kernel.descriptor.version,
        status: 'running', startedAt: this.now(),
      });
      await tx.turns.createSnapshot(snapshot);
    });
    await this.observe(record, attemptId, turnNo, correlationId, 'run_started', {
      kind: 'counter', name: 'runtime.runs.started', value: 1,
    });
    await this.observe(record, attemptId, turnNo, correlationId, 'attempt_started', {
      kind: 'counter', name: 'runtime.attempts.started', value: 1,
    });
    const leaseHeartbeat = setInterval(() => {
      void this.options.store.runs.renewLease(
        identity, this.workerId, lease.token, this.now(), this.leaseTtlMs,
      ).catch(() => undefined);
    }, this.leaseHeartbeatMs);
    leaseHeartbeat.unref?.();
    try {
      while (true) {
        const turnStartedAt = this.now();
        const buffered: Omit<AgentRunEvent, 'sequence'>[] = [];
        await this.observe(record, attemptId, turnNo, correlationId, 'turn_started', {
          kind: 'counter', name: 'runtime.turns.started', value: 1,
        });
        await this.guard(identity, lease.token, limits?.deadlineAt, signal);
        if (limits?.maxTurns !== undefined && turnNo > limits.maxTurns) {
          throw limitExceeded(`Run maxTurns exceeded: ${limits.maxTurns}`);
        }
        const exit = await kernel.run({
          ...identity,
          attemptId,
          turnNo,
          sessionId: record.sessionId,
          identity: identityContext,
          messages: currentMessages,
          model: this.modelBinding,
          tools: this.tools,
          continuation: currentContinuation,
          interactionResolution,
          signal,
        }, {
          emit: async (event) => {
            await this.options.observeEvent?.(event);
            if (event.type === 'tool_call') {
              toolCalls++;
              if (limits?.maxToolCalls !== undefined && toolCalls > limits.maxToolCalls) {
                throw limitExceeded(`Run maxToolCalls exceeded: ${limits.maxToolCalls}`);
              }
            }
            if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'context_compacted') {
              await this.observe(record, attemptId, turnNo, correlationId, event.type, {
                kind: 'counter',
                name: event.type === 'tool_call' ? 'runtime.tool_calls' : event.type === 'tool_result'
                  ? 'runtime.tool_results' : 'runtime.compactions',
                value: 1,
              });
            }
            const durable = this.kernelEvent(record, attemptId, turnNo, correlationId, event);
            if (!durable) return;
            if (buffered.length >= this.maxDurableEventsPerTurn) {
              throw limitExceeded(`Durable event limit exceeded: ${this.maxDurableEventsPerTurn}`);
            }
            buffered.push(durable);
          },
          guard: async () => this.guard(identity, lease.token, limits?.deadlineAt, signal),
          shouldStopAfterTurn: async () => true,
        });
        await this.guard(identity, lease.token, limits?.deadlineAt, signal);
        aggregateUsage = addUsage(aggregateUsage, exit.usage);
        const limitError = runLimitError(limits, aggregateUsage, turnNo, exit.outcome);
        const outcome = limitError ? 'failed' : exit.outcome;
        const status = outcome === 'continue' ? 'running'
          : outcome === 'completed' ? 'succeeded'
            : outcome === 'waiting' ? 'waiting'
              : outcome === 'recovery_required' ? 'recovery_required' : 'failed';
        const committedAt = this.now();
        const commit = await this.options.store.turns.commit({
          leaseOwner: this.workerId,
          leaseToken: lease.token,
          snapshot,
          commit: {
            ...identity, attemptId, turnNo, commitId: randomUUID(),
            transcriptVersion: (previous?.transcriptVersion ?? 0n) + 1n,
            stopReason: exit.stopReason, usage: aggregateUsage, messages: exit.messages, committedAt,
          },
          events: [...buffered, {
            ...identity, attemptId, turnNo, kernel: record.kernel, kernelVersion: record.kernelVersion,
            correlationId, type: 'turn_committed',
            detail: {
              outcome,
              stopReason: exit.stopReason ?? null,
              rolloutMode: this.modelBinding.rolloutMode ?? null,
              comparisonRunId: this.modelBinding.comparisonRunId ?? null,
            },
            createdAt: committedAt,
          }],
          runStatus: status,
          waitingReason: exit.waitingReason,
          ledgerUpdates: exit.ledgerUpdates,
          interactionUpdates: exit.interactionUpdates,
        });
        await this.observe(record, attemptId, turnNo, correlationId, 'turn_committed', {
          kind: 'timer', name: 'runtime.turn.duration', value: elapsedMs(turnStartedAt, committedAt), unit: 'ms',
        }, status);
        if (outcome === 'continue') {
          previous = commit;
          turnNo++;
          currentMessages = exit.messages;
          currentContinuation = true;
          snapshot = this.snapshot({
            identity, attemptId, turnNo, identityContext, messages: currentMessages, previous, limits,
          });
          await this.options.store.turns.createSnapshot(snapshot);
          continue;
        }
        const finalStatus = status as AgentRunResult['status'];
        if (finalStatus === 'waiting') {
          await this.observe(record, attemptId, turnNo, correlationId, 'waiting', {
            kind: 'counter', name: 'runtime.waiting', value: 1,
          }, finalStatus, { reason: exit.waitingReason ?? 'external' });
        }
        if (finalStatus === 'recovery_required') {
          await this.observe(record, attemptId, turnNo, correlationId, 'recovery_required', {
            kind: 'counter', name: 'runtime.recovery_required', value: 1,
          }, finalStatus);
        }
        await this.options.store.attempts.update({ ...identity, attemptId }, {
          status: finalStatus === 'failed' || finalStatus === 'recovery_required' ? 'failed' : 'succeeded',
          completedAt: committedAt,
        });
        await this.release(identity, commit);
        const finishedAt = this.now();
        await this.observe(record, attemptId, turnNo, correlationId, 'attempt_finished', {
          kind: 'timer', name: 'runtime.attempt.duration', value: elapsedMs(runStartedAt, finishedAt), unit: 'ms',
        }, finalStatus);
        await this.observe(record, attemptId, turnNo, correlationId, 'run_finished', {
          kind: 'timer', name: 'runtime.run.duration', value: elapsedMs(runStartedAt, finishedAt), unit: 'ms',
        }, finalStatus);
        return {
          runId: record.runId,
          status: finalStatus,
          text: lastText(exit.messages),
          usage: aggregateUsage,
          error: limitError ? errorData(limitError) : exit.error,
        };
      }
    } catch (error) {
      const now = this.now();
      const cancelled = signal.aborted;
      const status = cancelled ? 'cancelled' : error instanceof AgentPlatformError && error.code === 'TOOL_RESULT_UNKNOWN'
        ? 'recovery_required' : 'failed';
      if (errorCode(error) === 'LEASE_LOST') {
        await this.observe(record, attemptId, turnNo, correlationId, 'lease_lost', {
          kind: 'counter', name: 'runtime.lease_lost', value: 1,
        }, status);
      }
      await this.options.store.transaction(async (tx) => {
        await tx.attempts.update({ ...identity, attemptId }, {
          status: cancelled ? 'cancelled' : 'failed', errorCode: errorCode(error), errorMessage: safeMessage(error), completedAt: now,
        });
        await tx.runs.update(identity, {
          status, waitingReason: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now,
        });
        await tx.events.append({
          ...identity, attemptId, turnNo, kernel: record.kernel, kernelVersion: record.kernelVersion,
          correlationId, type: 'run_failed',
          detail: { code: errorCode(error), message: safeMessage(error) }, createdAt: now,
        });
      });
      if (status === 'recovery_required') {
        await this.observe(record, attemptId, turnNo, correlationId, 'recovery_required', {
          kind: 'counter', name: 'runtime.recovery_required', value: 1,
        }, status);
      }
      await this.observe(record, attemptId, turnNo, correlationId, 'attempt_finished', {
        kind: 'timer', name: 'runtime.attempt.duration', value: elapsedMs(runStartedAt, now), unit: 'ms',
      }, status);
      await this.observe(record, attemptId, turnNo, correlationId, 'run_finished', {
        kind: 'timer', name: 'runtime.run.duration', value: elapsedMs(runStartedAt, now), unit: 'ms',
      }, status);
      return {
        runId: record.runId,
        status,
        usage: aggregateUsage,
        error: error instanceof AgentPlatformError ? errorData(error) : {
          code: status === 'recovery_required' ? 'TOOL_RESULT_UNKNOWN' : 'MODEL_PROVIDER_ERROR',
          message: safeMessage(error),
          retryable: false,
        },
      };
    } finally {
      clearInterval(leaseHeartbeat);
      this.active.delete(runKey(identity));
    }
  }

  private snapshot(input: {
    identity: RunIdentity;
    attemptId: string;
    turnNo: number;
    identityContext: StartRunInput['identity'];
    messages: readonly KernelMessage[];
    previous?: TurnCommit;
    limits?: RunLimits;
  }): TurnSnapshot {
    return {
      ...input.identity,
      attemptId: input.attemptId,
      turnNo: input.turnNo,
      sessionVersion: input.previous?.transcriptVersion ?? 0n,
      parentCommitId: input.previous?.commitId,
      identity: input.identityContext,
      modelBinding: this.modelBinding,
      promptVersion: this.promptVersion,
      skillSetVersion: this.skillSetVersion,
      toolSetVersion: this.toolSetVersion,
      policyVersion: this.policyVersion,
      limits: input.limits,
      deadlineAt: input.limits?.deadlineAt,
      messages: input.messages,
      createdAt: this.now(),
    };
  }

  private async guard(identity: RunIdentity, token: bigint, deadlineAt: Date | undefined, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (deadlineAt && deadlineAt <= this.now()) throw limitExceeded('Run deadline exceeded');
    await this.options.store.runs.assertLease(identity, this.workerId, token, this.now());
    const run = await this.options.store.runs.get(identity);
    if (run?.cancelRequestedAt) throw new Error('Agent run cancelled');
  }

  private async release(identity: RunIdentity, _commit: TurnCommit): Promise<void> {
    await this.options.store.runs.update(identity, { leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: this.now() });
  }

  private async assertAttemptBudget(identity: RunIdentity, limits?: RunLimits): Promise<void> {
    if (limits?.maxAttempts === undefined) return;
    if (!Number.isInteger(limits.maxAttempts) || limits.maxAttempts < 1) {
      throw limitExceeded(`Run maxAttempts must be a positive integer: ${limits.maxAttempts}`);
    }
    const attempts = await this.options.store.attempts.list(identity);
    if (attempts.length >= limits.maxAttempts) {
      throw limitExceeded(`Run maxAttempts exceeded: ${limits.maxAttempts}`);
    }
  }

  private kernelEvent(
    record: RunRecord, attemptId: string, turnNo: number, correlationId: string, event: KernelEvent,
  ): Omit<AgentRunEvent, 'sequence'> | undefined {
    if (event.type === 'text_delta' || event.type === 'thinking_delta') return undefined;
    const detail = event.type === 'tool_call' ? {
      type: event.type,
      call: { id: event.call.id, logicalCallId: event.call.logicalCallId, name: event.call.name },
    } : event.type === 'tool_result' ? {
      type: event.type,
      result: { callId: event.result.callId, isError: Boolean(event.result.isError) },
    } : event.type === 'turn_end' ? {
      type: event.type,
      result: {
        turnNo: event.result.turnNo,
        stopReason: event.result.stopReason,
        usage: event.result.usage,
        waitingReason: event.result.waitingReason,
      },
    } : event;
    return {
      tenantId: record.tenantId, runId: record.runId, attemptId, turnNo,
      kernel: record.kernel, kernelVersion: record.kernelVersion, correlationId, type: event.type,
      detail: JSON.parse(JSON.stringify(detail)) as AgentRunEvent['detail'], createdAt: this.now(),
    };
  }

  private async *eventStream(identity: RunIdentity, settled: () => boolean): AsyncIterable<AgentRunEvent> {
    let sequence = 0n;
    while (true) {
      const events = await this.options.store.events.list(identity, sequence);
      if (events.length > 0) {
        const first = events[0]!;
        await this.emitObservation({
          type: 'sse_replay', tenantId: first.tenantId, runId: first.runId,
          attemptId: first.attemptId, turnNo: first.turnNo, kernel: first.kernel,
          kernelVersion: first.kernelVersion, correlationId: first.correlationId,
          metric: { kind: 'counter', name: 'runtime.sse_replay.events', value: events.length },
          occurredAt: this.now(),
        });
      }
      for (const event of events) {
        sequence = event.sequence;
        yield event;
      }
      if (settled() && events.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private resolveKernel(name: AgentKernelName, version?: string): AgentKernel {
    const kernel = this.kernels.get(name);
    if (!kernel || (version && kernel.descriptor.version !== version)) {
      throw new AgentPlatformError({
        code: 'KERNEL_VERSION_UNAVAILABLE', message: `Kernel unavailable: ${name}@${version ?? 'current'}`, retryable: false,
      });
    }
    return kernel;
  }

  private async observe(
    record: RunRecord,
    attemptId: string,
    turnNo: number,
    correlationId: string,
    type: RuntimeObservation['type'],
    metric: RuntimeObservation['metric'],
    status?: RuntimeObservation['status'],
    detail?: RuntimeObservation['detail'],
  ): Promise<void> {
    await this.emitObservation({
      type, tenantId: record.tenantId, runId: record.runId, attemptId, turnNo,
      kernel: record.kernel, kernelVersion: record.kernelVersion, correlationId,
      metric, status, detail, occurredAt: this.now(),
    });
  }

  private async emitObservation(observation: RuntimeObservation): Promise<void> {
    try {
      await this.options.observe?.(observation);
    } catch {
      // Observability must never change durable runtime semantics.
    }
  }
}

function runKey(identity: RunIdentity): string {
  return `${identity.tenantId}/${identity.runId}`;
}

function notFound(): AgentPlatformError {
  return new AgentPlatformError({ code: 'RUN_NOT_FOUND', message: 'Run not found', retryable: false });
}

function limitExceeded(message: string): AgentPlatformError {
  return new AgentPlatformError({ code: 'RUN_LIMIT_EXCEEDED', message, retryable: false });
}

function runLimitError(
  limits: RunLimits | undefined,
  usage: AgentRunResult['usage'],
  turnNo: number,
  outcome: string,
): AgentPlatformError | undefined {
  if (!limits) return undefined;
  if (limits.maxTurns !== undefined && outcome === 'continue' && turnNo >= limits.maxTurns) {
    return limitExceeded(`Run maxTurns exceeded: ${limits.maxTurns}`);
  }
  if (limits.maxInputTokens !== undefined && usage.inputTokens > limits.maxInputTokens) {
    return limitExceeded(`Run maxInputTokens exceeded: ${usage.inputTokens} > ${limits.maxInputTokens}`);
  }
  if (limits.maxOutputTokens !== undefined && usage.outputTokens > limits.maxOutputTokens) {
    return limitExceeded(`Run maxOutputTokens exceeded: ${usage.outputTokens} > ${limits.maxOutputTokens}`);
  }
  if (limits.maxCostUsd !== undefined && (usage.costUsd ?? 0) > limits.maxCostUsd) {
    return limitExceeded(`Run maxCostUsd exceeded: ${usage.costUsd ?? 0} > ${limits.maxCostUsd}`);
  }
  return undefined;
}

function errorData(error: AgentPlatformError) {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

function elapsedMs(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function lastText(messages: readonly KernelMessage[]): string | undefined {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!assistant || assistant.role !== 'assistant') return undefined;
  return assistant.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function safeMessage(error: unknown): string {
  return error instanceof AgentPlatformError ? error.message.slice(0, 1_024) : 'Agent execution failed';
}

function errorCode(error: unknown): string {
  return error instanceof AgentPlatformError ? error.code : 'MODEL_PROVIDER_ERROR';
}

function addUsage(left: AgentRunResult['usage'], right: AgentRunResult['usage']): AgentRunResult['usage'] {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    costUsd: left.costUsd === undefined && right.costUsd === undefined
      ? undefined
      : roundCost((left.costUsd ?? 0) + (right.costUsd ?? 0)),
  };
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
