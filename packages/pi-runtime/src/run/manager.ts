import { randomUUID } from 'node:crypto';
import type {
  AgentInputMessage, AgentRunEvent, AgentRunResult, AppendRunMessageInput, CancelRunInput, DurableRunRuntime,
  RunHandle, StartRunInput, ResumeRunInput,
} from '@aiop/control-contracts';
import type { SessionMetadata, SessionTreeEntry } from '@earendil-works/pi-agent-core';
import { AsyncEventStream } from './event-stream.js';
import { abortIfCancellationRequested } from './cancellation.js';
import { drainDurableInbox, type InboxCapableSession } from './inbox.js';
import { startLeaseHeartbeat } from './lease.js';
import { nextTurnNo } from './attempt.js';
import type { DurableRunStore } from '../store/types.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } as const;

export interface ManagedPiSession extends InboxCapableSession {
  continue(signal?: AbortSignal): AsyncIterable<AgentRunEvent>;
  abort(): Promise<void>;
  close(): Promise<void>;
  metadata(): Promise<SessionMetadata & { tenantId?: string }>;
  entries(): Promise<SessionTreeEntry[]>;
}

export interface DurableRunSessionFactory {
  create(input: { id?: string; initialMessage: AgentInputMessage; events: unknown; session?: Record<string, unknown> }): Promise<ManagedPiSession>;
  load(input: { metadata: SessionMetadata & { tenantId?: string }; initialMessage: AgentInputMessage; events: unknown }): Promise<ManagedPiSession>;
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
    await this.options.store.create({ record: {
      tenantId: input.identity.tenantId, runId, actorId: input.identity.actorId, sessionId: input.sessionId,
      kernel: 'pi', kernelVersion: '0.82.1', status: 'queued', leaseToken: 0n, limits: input.limits,
      usage: ZERO_USAGE, createdAt: now, updatedAt: now,
    } });
    await this.options.store.sessions.create({ tenantId: input.identity.tenantId, sessionId: input.sessionId, createdAt: now });
    return this.start(input.identity, runId, input.input[0] ?? { role: 'user', text: '' }, false, input.signal);
  }

  async resume(input: ResumeRunInput): Promise<RunHandle> {
    const run = await this.options.store.get({ tenantId: input.identity.tenantId, runId: input.runId });
    if (!run) throw new Error('Run not found');
    const message: AgentInputMessage = input.resolution
      ? { role: 'user', text: JSON.stringify(input.resolution) }
      : { role: 'user', text: 'Continue from the last committed state.' };
    return this.start(input.identity, input.runId, message, true, input.signal);
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
    identity: StartRunInput['identity'], runId: string, initialMessage: AgentInputMessage, resume: boolean, signal?: AbortSignal,
  ): Promise<RunHandle> {
    const stream = new AsyncEventStream<AgentRunEvent>();
    let resolveResult!: (result: AgentRunResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<AgentRunResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const execution = this.execute(identity, runId, initialMessage, resume, signal, stream)
      .then(resolveResult, rejectResult).finally(() => stream.close());
    void execution;
    return { runId, status: 'running', events: stream, result: () => result };
  }

  private async execute(
    identity: StartRunInput['identity'], runId: string, initialMessage: AgentInputMessage, resume: boolean,
    externalSignal: AbortSignal | undefined, stream: AsyncEventStream<AgentRunEvent>,
  ): Promise<AgentRunResult> {
    const claimed = await this.options.store.claim({ identity, runId, workerId: this.workerId, now: this.now(), leaseTtlMs: this.leaseTtlMs });
    if (!claimed) throw new Error('Run is not claimable');
    const storedRun = await this.options.store.get({ tenantId: identity.tenantId, runId });
    const turnNo = nextTurnNo(storedRun?.lastTurnNo ?? 0);
    const abort = new AbortController();
    const onAbort = () => abort.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    const stopHeartbeat = startLeaseHeartbeat({
      store: this.options.store, tenantId: identity.tenantId, runId, workerId: this.workerId,
      fencingToken: claimed.fencingToken, leaseTtlMs: this.leaseTtlMs, heartbeatMs: this.heartbeatMs, abort, now: this.now,
    });
    const activeKey = runKey(identity.tenantId, runId);
    this.active.set(activeKey, { abort });
    let session: ManagedPiSession | undefined;
    try {
      const events = this.options.eventOptions({ tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, turnNo });
      const sessionRecord = await this.options.store.sessions.get(identity.tenantId, claimed.record.sessionId);
      const metadata = {
        id: claimed.record.sessionId, tenantId: identity.tenantId,
        createdAt: (sessionRecord?.createdAt ?? claimed.record.createdAt).toISOString(), metadata: sessionRecord?.metadata,
      };
      session = resume
        ? await this.options.sessions.load({ metadata, initialMessage, events })
        : await this.options.sessions.create({ id: claimed.record.sessionId, initialMessage, events, session: { tenantId: identity.tenantId } });
      this.active.set(activeKey, { abort, session });
      let stopInboxPump = false;
      const pumpInbox = async (): Promise<void> => {
        while (!stopInboxPump && !abort.signal.aborted) {
          try {
            await drainDurableInbox({
              store: this.options.store, session: session!, entries: await session!.entries(),
              tenantId: identity.tenantId, runId, workerId: this.workerId, fencingToken: claimed.fencingToken,
              now: this.now, claimTtlMs: this.inboxClaimTtlMs,
            });
          } catch (error) {
            abort.abort(error);
            return;
          }
          await delay(this.inboxPollMs, abort.signal);
        }
      };
      const inboxPump = pumpInbox();
      const durableEvents: Array<Omit<AgentRunEvent, 'sequence'>> = [];
      try {
        for await (const event of session.continue(abort.signal)) {
          await abortIfCancellationRequested(this.options.store, { tenantId: identity.tenantId, runId }, abort);
          const normalized = normalizeEvent(event, identity.tenantId, runId, claimed.attemptId, turnNo);
          durableEvents.push(withoutSequence(normalized));
          stream.push(normalized);
        }
      } finally {
        stopInboxPump = true;
        await inboxPump;
      }
      await drainDurableInbox({
        store: this.options.store, session, entries: await session.entries(), tenantId: identity.tenantId, runId,
        workerId: this.workerId, fencingToken: claimed.fencingToken, now: this.now, claimTtlMs: this.inboxClaimTtlMs,
      });
      const entries = await session.entries();
      await this.syncEntries(identity.tenantId, claimed.record.sessionId, entries);
      const leafId = entries.at(-1)?.id ?? null;
      await this.options.store.commitTurn({
        tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, turnNo, fencingToken: claimed.fencingToken,
        checkpoint: { piSessionId: claimed.record.sessionId, piLeafId: leafId },
        events: durableEvents, status: 'succeeded', usage: claimed.record.usage,
      });
      await this.options.store.complete({
        tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, fencingToken: claimed.fencingToken,
        status: 'succeeded', usage: claimed.record.usage, completedAt: this.now(),
      });
      return { runId, status: 'succeeded', usage: claimed.record.usage };
    } catch (error) {
      if (abort.signal.aborted) {
        await session?.abort().catch(() => {});
        const status = await this.options.store.isCancellationRequested({ tenantId: identity.tenantId, runId }) ? 'cancelled' : 'recovery_required';
        await this.options.store.complete({
          tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, fencingToken: claimed.fencingToken,
          status, usage: claimed.record.usage, completedAt: this.now(),
        }).catch(() => {});
        return { runId, status, usage: claimed.record.usage };
      }
      const recoveryRequired = hasErrorCode(error, 'TOOL_RESULT_UNKNOWN');
      const status = recoveryRequired ? 'recovery_required' : 'failed';
      const errorData = {
        code: recoveryRequired ? 'TOOL_RESULT_UNKNOWN' as const : 'MODEL_PROVIDER_ERROR' as const,
        message: error instanceof Error ? error.message : String(error), retryable: false,
      };
      await this.options.store.complete({
        tenantId: identity.tenantId, runId, attemptId: claimed.attemptId, fencingToken: claimed.fencingToken,
        status, usage: claimed.record.usage, error: errorData, completedAt: this.now(),
      });
      return { runId, status, usage: claimed.record.usage, error: errorData };
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

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = () => done();
    function done() { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}
