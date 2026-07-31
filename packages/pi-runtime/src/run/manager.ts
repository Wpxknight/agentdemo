import { randomUUID } from 'node:crypto';
import { AgentPlatformError } from '@aiop/control-contracts';
import type {
  AgentInputMessage, AgentRunEvent, AgentRunResult, AgentRunUsage, AppendRunMessageInput, CancelRunInput,
  AgentPlatformErrorData, ClaimedRun, CommitTurnInput, DurableInteractionUpdate, DurableRunRuntime,
  DurableToolLedgerUpdate, ResolvedInteraction, RunHandle,
  StartRunInput, ResumeRunInput,
} from '@aiop/control-contracts';
import type { SessionMetadata, SessionTreeEntry } from '@earendil-works/pi-agent-core';
import { AsyncEventStream } from './event-stream.js';
import { abortIfCancellationRequested } from './cancellation.js';
import { drainDurableInbox, type InboxCapableSession } from './inbox.js';
import { startLeaseHeartbeat } from './lease.js';
import { nextTurnNo } from './attempt.js';
import type { DurableRunStore } from '../store/types.js';
import { assertToolCallsAllowed, assertUsageAllowed } from './limits.js';
import { piSessionStorageId } from '../store/session-id.js';
import { GovernedToolOutcomeError } from '../pi/tool-bridge.js';
import { equalJsonValue } from '../tools/ledger.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } as const;

export interface ManagedPiSession extends InboxCapableSession {
  continue(signal?: AbortSignal): AsyncIterable<AgentRunEvent>;
  synchronizeInbox?(deliver: () => Promise<void>, signal?: AbortSignal): Promise<void>;
  replayInteraction(
    resolution: ResolvedInteraction,
    signal?: AbortSignal,
    guard?: () => Promise<void>,
  ): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
  metadata(): Promise<SessionMetadata & { tenantId?: string }>;
  entries(): Promise<SessionTreeEntry[]>;
  leafId(): Promise<string | null>;
  takeToolExecutionFacts?(): {
    ledgerUpdates: DurableToolLedgerUpdate[];
    interactionUpdates: DurableInteractionUpdate[];
  };
}

export interface DurableRunSessionFactory {
  create(input: { id?: string; identity: StartRunInput['identity']; interactionResolution?: ResolvedInteraction; execution?: StartRunInput['execution']; initialMessage: AgentInputMessage; events: unknown; session?: Record<string, unknown> }): Promise<ManagedPiSession>;
  load(input: { metadata: SessionMetadata & { tenantId?: string }; identity: StartRunInput['identity']; interactionResolution?: ResolvedInteraction; execution?: StartRunInput['execution']; initialMessage: AgentInputMessage; events: unknown }): Promise<ManagedPiSession>;
}

export interface DurableRunManagerOptions {
  store: DurableRunStore;
  sessions: DurableRunSessionFactory;
  eventOptions(input: { tenantId: string; runId: string; attemptId: string; turnNo: number }): unknown;
  workerId?: string;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  inboxClaimTtlMs?: number;
  inboxPollMs?: number;
  now?: () => Date;
}

export class DurableRunManager implements DurableRunRuntime {
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly inboxClaimTtlMs: number;
  private readonly inboxPollMs: number;
  private readonly now: () => Date;
  private readonly active = new Map<string, { abort: AbortController; session?: ManagedPiSession }>();
  private readonly executions = new Set<string>();

  constructor(private readonly options: DurableRunManagerOptions) {
    this.workerId = options.workerId ?? `${process.pid}:${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.floor(this.leaseTtlMs / 3));
    this.inboxClaimTtlMs = options.inboxClaimTtlMs ?? 30_000;
    this.inboxPollMs = options.inboxPollMs ?? 100;
    this.now = options.now ?? (() => new Date());
  }

  async run(input: StartRunInput): Promise<RunHandle> {
    const runId = input.runId ?? randomUUID();
    const now = this.now();
    const reservation = await this.options.store.create({ record: {
      tenantId: input.identity.tenantId, runId, actorId: input.identity.actorId, sessionId: input.sessionId,
      kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, limits: input.limits,
      execution: input.execution,
      usage: ZERO_USAGE, createdAt: now, updatedAt: now,
    } });
    return this.start(input.identity, runId, input.input[0] ?? { role: 'user', text: '' }, false, !reservation.sessionCreated, input.signal);
  }

  async resume(input: ResumeRunInput): Promise<RunHandle> {
    const run = await this.options.store.get({ tenantId: input.identity.tenantId, runId: input.runId });
    if (!run) throw new Error('Run not found');
    if (run.status === 'waiting' && !input.resolution) throw conflict('Waiting run requires an interaction resolution');
    let trustedResolution: ResolvedInteraction | undefined;
    if (input.resolution) {
      const interaction = await this.options.store.getInteraction({
        tenantId: input.identity.tenantId, runId: input.runId, interactionId: input.resolution.interactionId,
      });
      if (!interaction || interaction.tenantId !== input.identity.tenantId || interaction.runId !== input.runId
        || interaction.status !== 'resolved' || !interaction.toolCallId
        || (run.status === 'waiting' && interaction.kind !== run.waitingReason)
        || !equalJsonValue(interaction.resolution, input.resolution.value)) {
        throw conflict('Interaction resolution does not match the waiting run');
      }
      trustedResolution = {
        interactionId: interaction.id, kind: interaction.kind, toolCallId: interaction.toolCallId,
        value: interaction.resolution ?? input.resolution.value,
      };
    }
    const message: AgentInputMessage = { role: 'user', text: '' };
    return this.start(input.identity, input.runId, message, true, true, input.signal, trustedResolution);
  }

  async cancel(input: CancelRunInput): Promise<void> {
    await this.options.store.requestCancellation({ ...input, requestedAt: this.now() });
    const active = this.active.get(runKey(input.identity.tenantId, input.runId));
    active?.abort.abort(new Error(input.reason ?? 'Run cancelled'));
    await active?.session?.abort();
  }

  async append(input: AppendRunMessageInput): Promise<void> {
    await this.options.store.inbox.enqueue({ ...input, tenantId: input.identity.tenantId, createdAt: this.now() });
  }

  private async start(
    identity: StartRunInput['identity'], runId: string, initialMessage: AgentInputMessage, resume: boolean,
    loadCommittedSession: boolean, signal?: AbortSignal, interactionResolution?: ResolvedInteraction,
  ): Promise<RunHandle> {
    const key = runKey(identity.tenantId, runId);
    if (this.executions.has(key)) throw conflict('Run recovery is already active');
    this.executions.add(key);
    const stream = new AsyncEventStream<AgentRunEvent>();
    let resolveResult!: (result: AgentRunResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<AgentRunResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const claim = this.options.store.claim({
      identity, runId, workerId: this.workerId, now: this.now(), leaseTtlMs: this.leaseTtlMs, resume,
      resolution: interactionResolution
        ? { interactionId: interactionResolution.interactionId, value: interactionResolution.value }
        : undefined,
    });
    const execution = this.execute(
      identity, runId, initialMessage, loadCommittedSession, signal, stream, claim, interactionResolution,
    )
      .then(resolveResult, rejectResult).finally(() => { stream.close(); this.executions.delete(key); });
    void execution;
    return {
      runId, status: 'running', events: stream,
      attempt: async () => {
        const claimed = await claim;
        if (!claimed) throw new Error('Run is not claimable');
        return { attemptId: claimed.attemptId, workerId: this.workerId, fencingToken: claimed.fencingToken };
      },
      result: () => result,
    };
  }

  private async execute(
    identity: StartRunInput['identity'], runId: string, initialMessage: AgentInputMessage,
    loadCommittedSession: boolean, externalSignal: AbortSignal | undefined, stream: AsyncEventStream<AgentRunEvent>,
    claim: Promise<ClaimedRun | null>,
    interactionResolution?: ResolvedInteraction,
  ): Promise<AgentRunResult> {
    const claimed = await claim;
    if (!claimed) throw new Error('Run is not claimable');
    const storedRun = await this.options.store.get({ tenantId: identity.tenantId, runId });
    const turnNo = nextTurnNo(storedRun?.lastTurnNo ?? 0);
    const persistedToolCallIds = toolCallIdsFromEvents(await this.options.store.listEvents({ tenantId: identity.tenantId, runId }));
    const abort = new AbortController();
    const onAbort = () => abort.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    if (externalSignal?.aborted) onAbort();
    const stopHeartbeat = startLeaseHeartbeat({
      store: this.options.store, tenantId: identity.tenantId, runId, workerId: this.workerId,
      fencingToken: claimed.fencingToken, leaseTtlMs: this.leaseTtlMs, heartbeatMs: this.heartbeatMs, abort, now: this.now,
    });
    const activeKey = runKey(identity.tenantId, runId);
    this.active.set(activeKey, { abort });
    let session: ManagedPiSession | undefined;
    let baselineUsage = zeroUsage();
    let observedUsage = zeroUsage();
    let hasObservedUsage = false;
    const durableEvents: Array<Omit<AgentRunEvent, 'sequence'>> = [];
    let eventsPersisted = false;
    const piSessionId = piSessionStorageId(claimed.record.actorId, claimed.record.sessionId);
    try {
      const events = this.options.eventOptions({ tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, turnNo });
      const sessionRecord = await this.options.store.sessions.get(identity.tenantId, piSessionId);
      const metadata = {
        id: piSessionId, tenantId: identity.tenantId,
        createdAt: (sessionRecord?.createdAt ?? claimed.record.createdAt).toISOString(), metadata: sessionRecord?.metadata,
      };
      session = loadCommittedSession
        ? await this.options.sessions.load({
            metadata, identity, interactionResolution, execution: claimed.record.execution, initialMessage, events,
          })
        : await this.options.sessions.create({
            id: piSessionId, identity, interactionResolution, execution: claimed.record.execution,
            initialMessage, events, session: { tenantId: identity.tenantId },
          });
      this.active.set(activeKey, { abort, session });
      baselineUsage = usageFromEntries(await session.entries());
      const stopControl = new AbortController();
      const controlSignal = AbortSignal.any([abort.signal, stopControl.signal]);
      let stopControlPump = false;
      const guardControl = async (): Promise<void> => {
        await abortIfCancellationRequested(this.options.store, { tenantId: identity.tenantId, runId }, abort);
        if (claimed.record.limits?.deadlineAt && claimed.record.limits.deadlineAt <= this.now()) {
          abort.abort(new AgentPlatformError({
            code: 'RUN_LIMIT_EXCEEDED', message: 'Run deadline exceeded', retryable: false,
          }));
        }
        if (abort.signal.aborted) throw abort.signal.reason ?? new Error('Run control aborted');
      };
      const pumpControl = async (): Promise<void> => {
        while (!stopControlPump && !abort.signal.aborted) {
          try {
            await guardControl();
          } catch (error) {
            abort.abort(error);
            await session!.abort().catch(() => {});
            return;
          }
          await delay(this.inboxPollMs, controlSignal);
        }
      };
      const controlPump = pumpControl();
      try {
        if (interactionResolution) {
          await guardControl();
          await session.replayInteraction(interactionResolution, abort.signal, guardControl);
          await guardControl();
        }
        let stopInboxPump = false;
        const inboxStop = new AbortController();
        const inboxSignal = AbortSignal.any([abort.signal, inboxStop.signal]);
        const pumpInbox = async (): Promise<void> => {
          const drain = async () => drainDurableInbox({
            store: this.options.store, session: session!, entries: await session!.entries(),
            tenantId: identity.tenantId, runId, workerId: this.workerId, fencingToken: claimed.fencingToken,
            now: this.now, claimTtlMs: this.inboxClaimTtlMs,
          });
          try {
            if (session!.synchronizeInbox) await session!.synchronizeInbox(drain, inboxSignal);
            else await drain();
            while (!stopInboxPump && !abort.signal.aborted) {
              await drainDurableInbox({
                store: this.options.store, session: session!, entries: await session!.entries(),
                tenantId: identity.tenantId, runId, workerId: this.workerId, fencingToken: claimed.fencingToken,
                now: this.now, claimTtlMs: this.inboxClaimTtlMs,
              });
              await delay(this.inboxPollMs, inboxSignal);
            }
          } catch (error) {
            if (!inboxSignal.aborted) abort.abort(error);
          }
        };
        const inboxPump = pumpInbox();
        const currentToolCallIds = new Set<string>();
        try {
          for await (const event of session.continue(abort.signal)) {
            await guardControl();
            const normalized = normalizeEvent(event, identity.tenantId, runId, claimed.attemptId, turnNo);
            durableEvents.push(withoutSequence(normalized));
            stream.push(normalized);
            if (normalized.type === 'message_end') {
              observedUsage = addUsage(observedUsage, usageFromEvent(normalized));
              hasObservedUsage = true;
              assertOnlineUsageAllowed(claimed.record.limits, addUsage(claimed.record.usage, observedUsage), observedUsage);
            }
            const toolCallId = toolCallIdFromEvent(normalized);
            if (toolCallId) currentToolCallIds.add(toolCallId);
            assertToolCallsAllowed(claimed.record.limits, unionSize(persistedToolCallIds, currentToolCallIds));
          }
        } finally {
          stopInboxPump = true;
          inboxStop.abort();
          await inboxPump;
        }
        await this.options.store.closeInbox({
          tenantId: identity.tenantId, runId, workerId: this.workerId,
          fencingToken: claimed.fencingToken, now: this.now(),
        });
        await drainDurableInbox({
          store: this.options.store, session, entries: await session.entries(), tenantId: identity.tenantId, runId,
          workerId: this.workerId, fencingToken: claimed.fencingToken, now: this.now, claimTtlMs: this.inboxClaimTtlMs,
        });
        const entries = await session.entries();
        const actualUsage = addUsage(claimed.record.usage, subtractUsage(usageFromEntries(entries), baselineUsage));
        assertUsageAllowed(claimed.record.limits, actualUsage);
        assertToolCallsAllowed(claimed.record.limits, unionSize(persistedToolCallIds, currentToolCallIds));
        const leafId = await session.leafId();
        const terminalError = terminalAssistantError(entries, leafId);
        if (terminalError) throw terminalError;
        await this.syncEntries(identity.tenantId, piSessionId, entries);
        const facts = session.takeToolExecutionFacts?.();
        const committedAt = this.now();
        await this.options.store.commitTurn({
          tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, turnNo, fencingToken: claimed.fencingToken,
          checkpoint: { piSessionId, piLeafId: leafId },
          events: durableEvents, status: 'succeeded', usage: actualUsage,
          ledgerUpdates: facts?.ledgerUpdates, interactionUpdates: facts?.interactionUpdates, committedAt,
        });
        eventsPersisted = true;
        await this.options.store.complete({
          tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, fencingToken: claimed.fencingToken,
          status: 'succeeded', usage: actualUsage, completedAt: this.now(),
        });
        return { runId, status: 'succeeded', text: assistantText(entries, leafId), usage: actualUsage };
      } finally {
        stopControlPump = true;
        stopControl.abort();
        await controlPump;
      }
    } catch (error) {
      const actualUsage = await terminalUsage(session, claimed.record.usage, baselineUsage, observedUsage, hasObservedUsage);
      const cancellation = await this.options.store.isCancellationRequested({ tenantId: identity.tenantId, runId });
      if (error instanceof GovernedToolOutcomeError && !cancellation) {
        const entries = await session?.entries() ?? [];
        if (session) await this.syncEntries(identity.tenantId, piSessionId, entries);
        const leafId = await session?.leafId() ?? null;
        const outcome = error.outcome;
        const facts = session?.takeToolExecutionFacts?.();
        const governedCommit: CommitTurnInput = {
          tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, turnNo,
          fencingToken: claimed.fencingToken,
          checkpoint: { piSessionId, piLeafId: leafId },
          events: durableEvents, status: outcome.kind,
          waitingReason: outcome.kind === 'waiting' ? outcome.reason : undefined,
          ledgerUpdates: facts?.ledgerUpdates ?? outcome.ledgerUpdates,
          interactionUpdates: facts?.interactionUpdates ?? outcome.interactionUpdates,
          error: outcome.kind === 'recovery_required'
            ? { code: 'TOOL_RESULT_UNKNOWN', message: error.message, retryable: false }
            : undefined,
          usage: actualUsage, committedAt: this.now(),
        };
        try {
          await this.options.store.commitTurn(governedCommit);
        } catch (commitError) {
          const cancellationWon = hasErrorCode(commitError, 'RUN_STATE_CONFLICT')
            && await this.options.store.isCancellationRequested({ tenantId: identity.tenantId, runId });
          if (!cancellationWon) throw commitError;
          await this.options.store.commitTurn({
            ...governedCommit, status: 'cancelled', waitingReason: undefined, error: undefined,
          });
          eventsPersisted = true;
          await this.options.store.complete({
            tenantId: identity.tenantId, runId, attemptId: claimed.attemptId,
            fencingToken: claimed.fencingToken, status: 'cancelled', usage: actualUsage, completedAt: this.now(),
          });
          return { runId, status: 'cancelled', usage: actualUsage };
        }
        eventsPersisted = true;
        if (outcome.kind === 'waiting') return { runId, status: 'waiting', usage: actualUsage };
        const errorData = { code: 'TOOL_RESULT_UNKNOWN' as const, message: error.message, retryable: false };
        return { runId, status: 'recovery_required', usage: actualUsage, error: errorData };
      }
      let leafId: string | null = null;
      if (session) {
        try {
          const entries = await session.entries();
          await this.syncEntries(identity.tenantId, piSessionId, entries);
        } catch {
          // Provider/session failures may leave the terminal tree unreadable; durable facts still must commit.
        }
        try { leafId = await session.leafId(); } catch { leafId = null; }
      }
      const facts = session?.takeToolExecutionFacts?.();
      const commitFailure = async (
        status: 'cancelled' | 'failed' | 'recovery_required',
        errorData?: AgentPlatformErrorData,
      ): Promise<'cancelled' | 'failed' | 'recovery_required'> => {
        const committedAt = this.now();
        const commit: CommitTurnInput = {
          tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, turnNo,
          fencingToken: claimed.fencingToken,
          checkpoint: { piSessionId, piLeafId: leafId },
          events: durableEvents, status, usage: actualUsage, error: errorData,
          ledgerUpdates: facts?.ledgerUpdates, interactionUpdates: facts?.interactionUpdates, committedAt,
        };
        try {
          await this.options.store.commitTurn(commit);
        } catch (commitError) {
          const cancellationWon = status !== 'cancelled' && hasErrorCode(commitError, 'RUN_STATE_CONFLICT')
            && await this.options.store.isCancellationRequested({ tenantId: identity.tenantId, runId });
          if (!cancellationWon) throw commitError;
          status = 'cancelled';
          errorData = undefined;
          await this.options.store.commitTurn({ ...commit, status, error: undefined });
        }
        eventsPersisted = true;
        if (status !== 'recovery_required') {
          await this.options.store.complete({
            tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, fencingToken: claimed.fencingToken,
            status, usage: actualUsage, error: errorData, completedAt: this.now(),
          });
        }
        return status;
      };
      const terminalProviderError = error instanceof AgentPlatformError && error.code === 'MODEL_PROVIDER_ERROR';
      if ((abort.signal.aborted && !terminalProviderError) || cancellation) {
        await session?.abort().catch(() => {});
        const limitError = abort.signal.reason instanceof AgentPlatformError && abort.signal.reason.code === 'RUN_LIMIT_EXCEEDED'
          ? abort.signal.reason : undefined;
        const status = cancellation ? 'cancelled' : limitError ? 'failed' : 'recovery_required';
        const errorData = limitError ? { code: limitError.code, message: limitError.message, retryable: limitError.retryable } : undefined;
        const committedStatus = await commitFailure(status, errorData).catch(() => status);
        return {
          runId, status: committedStatus, usage: actualUsage,
          error: committedStatus === status ? errorData : undefined,
        };
      }
      const recoveryRequired = hasErrorCode(error, 'TOOL_RESULT_UNKNOWN');
      const status = recoveryRequired ? 'recovery_required' : 'failed';
      const errorData = error instanceof AgentPlatformError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : { code: recoveryRequired ? 'TOOL_RESULT_UNKNOWN' as const : 'MODEL_PROVIDER_ERROR' as const,
            message: error instanceof Error ? error.message : String(error), retryable: false };
      const committedStatus = await commitFailure(status, errorData);
      return {
        runId, status: committedStatus, usage: actualUsage,
        error: committedStatus === status ? errorData : undefined,
      };
    } finally {
      stopHeartbeat();
      externalSignal?.removeEventListener('abort', onAbort);
      this.active.delete(activeKey);
      await session?.close().catch(() => {});
    }
  }

  private async syncEntries(tenantId: string, sessionId: string, entries: SessionTreeEntry[]): Promise<void> {
    const existing = new Set((await this.options.store.sessions.listEntries(tenantId, sessionId)).map((item) => item.entry.id));
    for (const entry of entries) if (!existing.has(entry.id)) await this.options.store.sessions.appendEntry(tenantId, sessionId, entry);
  }
}

function normalizeEvent(event: AgentRunEvent, tenantId: string, runId: string, attemptId: string, turnNo: number): AgentRunEvent {
  return { ...event, tenantId, runId, attemptId, turnNo, kernel: 'pi', kernelVersion: '0.82.1' };
}

function withoutSequence(event: AgentRunEvent): Omit<AgentRunEvent, 'sequence'> {
  const { sequence: _sequence, ...stored } = event;
  return stored;
}

function runKey(tenantId: string, runId: string): string { return `${tenantId}\0${runId}`; }

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === code);
}

function conflict(message: string): AgentPlatformError {
  return new AgentPlatformError({ code: 'RUN_STATE_CONFLICT', message, retryable: false });
}

function assistantText(entries: readonly SessionTreeEntry[], leafId: string | null): string | undefined {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let cursor = leafId;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry) return undefined;
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      const text = entry.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      return text || undefined;
    }
    cursor = entry.parentId;
  }
  return undefined;
}

function terminalAssistantError(
  entries: readonly SessionTreeEntry[],
  leafId: string | null,
): AgentPlatformError | undefined {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let cursor = leafId;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry) return undefined;
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      if (entry.message.stopReason !== 'error' && entry.message.stopReason !== 'aborted') return undefined;
      const fallback = entry.message.stopReason === 'aborted'
        ? 'Model provider aborted the response'
        : 'Model provider returned an error response';
      return new AgentPlatformError({
        code: 'MODEL_PROVIDER_ERROR', message: entry.message.errorMessage || fallback, retryable: false,
      });
    }
    cursor = entry.parentId;
  }
  return undefined;
}

function zeroUsage(): AgentRunUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function addUsage(left: AgentRunUsage, right: AgentRunUsage): AgentRunUsage {
  const cost = left.costUsd === undefined && right.costUsd === undefined ? undefined : (left.costUsd ?? 0) + (right.costUsd ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

function subtractUsage(value: AgentRunUsage, baseline: AgentRunUsage): AgentRunUsage {
  const cost = value.costUsd === undefined ? undefined : Math.max(0, value.costUsd - (baseline.costUsd ?? 0));
  return {
    inputTokens: Math.max(0, value.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, value.outputTokens - baseline.outputTokens),
    cacheReadTokens: Math.max(0, value.cacheReadTokens - baseline.cacheReadTokens),
    cacheCreationTokens: Math.max(0, value.cacheCreationTokens - baseline.cacheCreationTokens),
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

function usageFromEntries(entries: readonly SessionTreeEntry[]): AgentRunUsage {
  let result = zeroUsage();
  for (const entry of entries) {
    const usage = entry.type === 'message'
      ? entry.message.role === 'assistant' ? entry.message.usage : undefined
      : entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.usage : undefined;
    if (!usage) continue;
    result = addUsage(result, {
      inputTokens: finite(usage.input), outputTokens: finite(usage.output),
      cacheReadTokens: finite(usage.cacheRead), cacheCreationTokens: finite(usage.cacheWrite),
      ...(Number.isFinite(usage.cost?.total) ? { costUsd: usage.cost.total } : {}),
    });
  }
  return result;
}

function usageFromEvent(event: AgentRunEvent): AgentRunUsage {
  const detail = event.detail && typeof event.detail === 'object' ? event.detail as Record<string, unknown> : {};
  const message = detail.message && typeof detail.message === 'object' ? detail.message as Record<string, unknown> : {};
  const usage = message.usage && typeof message.usage === 'object' ? message.usage as Record<string, unknown> : {};
  return {
    inputTokens: finite(usage.input), outputTokens: finite(usage.output),
    cacheReadTokens: finite(usage.cacheRead), cacheCreationTokens: finite(usage.cacheWrite),
    ...(Number.isFinite(usage.costTotal) ? { costUsd: Number(usage.costTotal) } : {}),
  };
}

function assertOnlineUsageAllowed(
  limits: Parameters<typeof assertUsageAllowed>[0],
  totalUsage: AgentRunUsage,
  observedUsage: AgentRunUsage,
): void {
  if (observedUsage.costUsd !== undefined) return assertUsageAllowed(limits, totalUsage);
  assertUsageAllowed(limits ? { ...limits, maxCostUsd: undefined } : undefined, totalUsage);
}

async function terminalUsage(
  session: ManagedPiSession | undefined,
  committedUsage: AgentRunUsage,
  baselineUsage: AgentRunUsage,
  observedUsage: AgentRunUsage,
  hasObservedUsage: boolean,
): Promise<AgentRunUsage> {
  if (session) {
    try {
      return addUsage(committedUsage, subtractUsage(usageFromEntries(await session.entries()), baselineUsage));
    } catch {
      // Some provider/session failures make the final tree unreadable; retain priced event facts as a fallback.
    }
  }
  return hasObservedUsage ? addUsage(committedUsage, observedUsage) : committedUsage;
}

function toolCallIdsFromEvents(events: readonly AgentRunEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const id = toolCallIdFromEvent(event);
    if (id) ids.add(id);
  }
  return ids;
}

function toolCallIdFromEvent(event: AgentRunEvent): string | undefined {
  if (!['tool_execution_start', 'tool_execution_end', 'tool_call', 'tool_result'].includes(event.type)) return undefined;
  const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
    ? event.detail as Record<string, unknown> : {};
  return typeof detail.toolCallId === 'string' && detail.toolCallId ? detail.toolCallId : undefined;
}

function unionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  return new Set([...left, ...right]).size;
}

function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = () => done();
    function done() { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}
