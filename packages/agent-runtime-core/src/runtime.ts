import { randomUUID } from 'node:crypto';
import {
  AgentPlatformError,
  type AgentKernel,
  type AgentKernelName,
  type AgentRunEvent,
  type AgentRunResult,
  type CancelRunInput,
  type KernelEvent,
  type KernelMessage,
  type ModelBinding,
  type ResumeRunInput,
  type RunHandle,
  type StartRunInput,
  type ToolDefinition,
} from '@aiop/agent-contracts';
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
  now?: () => Date;
  observeEvent?: (event: KernelEvent) => void | Promise<void>;
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
  private readonly now: () => Date;

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
    this.now = options.now ?? (() => new Date());
  }

  async run(input: StartRunInput): Promise<RunHandle> {
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
    return this.startHandle(record, kernel, input.identity, messages, false, input.signal, input.limits?.deadlineAt);
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
    if (input.resolution) {
      const interaction = await this.options.store.interactions.get({ ...identity, interactionId: input.resolution.interactionId });
      if (!interaction || interaction.status !== 'pending') {
        throw new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message: 'Interaction is not pending', retryable: false });
      }
      await this.options.store.interactions.put({
        ...interaction, status: 'resolved', resolution: input.resolution.value, resolvedAt: this.now(),
      });
    }
    const messages = (last.stopReason === 'error' || last.stopReason === 'aborted')
      && last.messages.at(-1)?.role === 'assistant'
      ? last.messages.slice(0, -1)
      : last.messages;
    return this.startHandle(record, kernel, input.identity, messages, true, input.signal);
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

  private startHandle(
    record: RunRecord,
    kernel: AgentKernel,
    identityContext: StartRunInput['identity'],
    messages: readonly KernelMessage[],
    continuation: boolean,
    externalSignal?: AbortSignal,
    deadlineAt?: Date,
  ): RunHandle {
    const identity = { tenantId: record.tenantId, runId: record.runId };
    let settled = false;
    const resultPromise = this.execute(
      record, kernel, identityContext, messages, continuation, externalSignal, deadlineAt,
    ).finally(() => { settled = true; });
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
    deadlineAt?: Date,
  ): Promise<AgentRunResult> {
    const identity = { tenantId: record.tenantId, runId: record.runId };
    const controller = new AbortController();
    this.active.set(runKey(identity), controller);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const attemptId = randomUUID();
    const lease = await this.options.store.runs.acquireLease(identity, this.workerId, this.now(), this.leaseTtlMs);
    if (!lease) throw new AgentPlatformError({ code: 'LEASE_LOST', message: 'Run is owned by another worker', retryable: false });
    let previous = await this.options.store.turns.getLastCommitted(identity);
    let turnNo = (previous?.turnNo ?? 0) + 1;
    let currentMessages = messages;
    let currentContinuation = continuation;
    let aggregateUsage = { ...record.usage };
    let snapshot = this.snapshot({
      identity, attemptId, turnNo, identityContext, messages: currentMessages, previous, deadlineAt,
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
    try {
      while (true) {
        const buffered: Omit<AgentRunEvent, 'sequence'>[] = [];
        await this.guard(identity, lease.token, deadlineAt, signal);
        const exit = await kernel.run({
          ...identity,
          attemptId,
          turnNo,
          identity: identityContext,
          messages: currentMessages,
          model: this.modelBinding,
          tools: this.tools,
          continuation: currentContinuation,
          signal,
        }, {
          emit: async (event) => {
            buffered.push(this.kernelEvent(identity, attemptId, turnNo, event));
            await this.options.observeEvent?.(event);
          },
          guard: async () => this.guard(identity, lease.token, deadlineAt, signal),
          shouldStopAfterTurn: async () => true,
        });
        await this.guard(identity, lease.token, deadlineAt, signal);
        aggregateUsage = addUsage(aggregateUsage, exit.usage);
        const status = exit.outcome === 'continue' ? 'running'
          : exit.outcome === 'completed' ? 'succeeded'
            : exit.outcome === 'waiting' ? 'waiting'
              : exit.outcome === 'recovery_required' ? 'recovery_required' : 'failed';
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
            ...identity, attemptId, turnNo, type: 'turn_committed',
            detail: { outcome: exit.outcome, stopReason: exit.stopReason ?? null }, createdAt: committedAt,
          }],
          runStatus: status,
          waitingReason: exit.waitingReason,
        });
        if (exit.outcome === 'continue') {
          previous = commit;
          turnNo++;
          currentMessages = exit.messages;
          currentContinuation = true;
          snapshot = this.snapshot({
            identity, attemptId, turnNo, identityContext, messages: currentMessages, previous, deadlineAt,
          });
          await this.options.store.turns.createSnapshot(snapshot);
          continue;
        }
        const finalStatus = status as AgentRunResult['status'];
        await this.options.store.attempts.update({ ...identity, attemptId }, {
          status: finalStatus === 'failed' || finalStatus === 'recovery_required' ? 'failed' : 'succeeded',
          completedAt: committedAt,
        });
        await this.release(identity, commit);
        return { runId: record.runId, status: finalStatus, text: lastText(exit.messages), usage: aggregateUsage, error: exit.error };
      }
    } catch (error) {
      const now = this.now();
      const cancelled = signal.aborted;
      const status = cancelled ? 'cancelled' : error instanceof AgentPlatformError && error.code === 'TOOL_RESULT_UNKNOWN'
        ? 'recovery_required' : 'failed';
      await this.options.store.transaction(async (tx) => {
        await tx.attempts.update({ ...identity, attemptId }, {
          status: cancelled ? 'cancelled' : 'failed', errorCode: errorCode(error), errorMessage: safeMessage(error), completedAt: now,
        });
        await tx.runs.update(identity, {
          status, waitingReason: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now,
        });
        await tx.events.append({
          ...identity, attemptId, turnNo, type: 'run_failed',
          detail: { code: errorCode(error), message: safeMessage(error) }, createdAt: now,
        });
      });
      return {
        runId: record.runId,
        status,
        usage: aggregateUsage,
        error: { code: status === 'recovery_required' ? 'TOOL_RESULT_UNKNOWN' : 'MODEL_PROVIDER_ERROR', message: safeMessage(error), retryable: false },
      };
    } finally {
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
    deadlineAt?: Date;
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
      deadlineAt: input.deadlineAt,
      messages: input.messages,
      createdAt: this.now(),
    };
  }

  private async guard(identity: RunIdentity, token: bigint, deadlineAt: Date | undefined, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (deadlineAt && deadlineAt <= this.now()) throw new Error('Run deadline exceeded');
    await this.options.store.runs.assertLease(identity, this.workerId, token, this.now());
    const run = await this.options.store.runs.get(identity);
    if (run?.cancelRequestedAt) throw new Error('Agent run cancelled');
  }

  private async release(identity: RunIdentity, _commit: TurnCommit): Promise<void> {
    await this.options.store.runs.update(identity, { leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: this.now() });
  }

  private kernelEvent(
    identity: RunIdentity, attemptId: string, turnNo: number, event: KernelEvent,
  ): Omit<AgentRunEvent, 'sequence'> {
    return {
      ...identity, attemptId, turnNo, type: event.type,
      detail: JSON.parse(JSON.stringify(event)) as AgentRunEvent['detail'], createdAt: this.now(),
    };
  }

  private async *eventStream(identity: RunIdentity, settled: () => boolean): AsyncIterable<AgentRunEvent> {
    let sequence = 0n;
    while (true) {
      const events = await this.options.store.events.list(identity, sequence);
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
}

function runKey(identity: RunIdentity): string {
  return `${identity.tenantId}/${identity.runId}`;
}

function notFound(): AgentPlatformError {
  return new AgentPlatformError({ code: 'RUN_NOT_FOUND', message: 'Run not found', retryable: false });
}

function lastText(messages: readonly KernelMessage[]): string | undefined {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (!assistant || assistant.role !== 'assistant') return undefined;
  return assistant.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
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
      : (left.costUsd ?? 0) + (right.costUsd ?? 0),
  };
}
