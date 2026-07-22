import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../auth/types.js';
import type { AgentRunStatus, AgentRunUsage, Store } from '../db/store.js';
import type { RunAgentResult } from './core.js';
import { RecoveryRequiredError } from './tool-ledger/store.js';

const DEFAULT_LEASE_TTL_MS = 30_000;

export class AgentRunLeaseLostError extends Error {
  constructor(message = 'Agent run lease lost') {
    super(message);
    this.name = 'AgentRunLeaseLostError';
  }
}

export class AgentRunCancelledError extends Error {
  constructor(message = 'Agent run cancelled') {
    super(message);
    this.name = 'AgentRunCancelledError';
  }
}

export interface AgentRunLifecycleObserver {
  guard(): Promise<void>;
  nodeStarted(node: string): Promise<void>;
  nodeCompleted(node: string, detail?: Record<string, unknown>): Promise<void>;
  nodeFailed(node: string, error: unknown): Promise<void>;
  waiting(detail?: Record<string, unknown>): Promise<void>;
  running(detail?: Record<string, unknown>): Promise<void>;
}

export interface AgentRunCoordinatorOptions {
  ownerId?: string;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  now?: () => Date;
}

export class AgentRunCoordinator {
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => Date;

  constructor(private readonly store: Store, options: AgentRunCoordinatorOptions = {}) {
    this.ownerId = options.ownerId ?? `${process.pid}:${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseTtlMs / 3));
    this.now = options.now ?? (() => new Date());
  }

  async start(ctx: RequestContext, runId: string): Promise<AgentRunExecution> {
    const lease = await this.store.acquireAgentRunLease(
      ctx.tenantId, runId, this.ownerId, this.now(), this.leaseTtlMs,
    );
    if (!lease) throw new AgentRunLeaseLostError('Agent run is owned by another replica');
    const current = await this.store.getAgentRun(ctx, runId);
    const now = this.now();
    await this.store.updateAgentRun(ctx.tenantId, runId, {
      status: 'running', currentNode: null, errorMessage: null,
      startedAt: current?.startedAt ?? now, updatedAt: now, completedAt: null,
    });
    await this.store.appendAgentRunEvent({
      tenantId: ctx.tenantId, runId, type: 'run', status: 'running', createdAt: now,
      detail: { ownerId: this.ownerId, leaseToken: lease.token },
    });
    return new AgentRunExecution(
      this.store, ctx, runId, lease.token, this.ownerId, this.leaseTtlMs, this.heartbeatMs, this.now,
    );
  }
}

export class AgentRunExecution implements AgentRunLifecycleObserver {
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly ctx: RequestContext,
    private readonly runId: string,
    private readonly leaseToken: number,
    private readonly ownerId: string,
    private readonly leaseTtlMs: number,
    heartbeatMs: number,
    private readonly now: () => Date,
  ) {
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        void this.store.renewAgentRunLease(
          this.ctx.tenantId, this.runId, this.ownerId, this.leaseToken, this.now(), this.leaseTtlMs,
        );
      }, heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  async guard(): Promise<void> {
    try {
      await this.store.assertAgentRunLease(
        this.ctx.tenantId, this.runId, this.ownerId, this.leaseToken, this.now(),
      );
    } catch {
      throw new AgentRunLeaseLostError();
    }
    if (await this.store.isAgentRunCancellationRequested(this.ctx.tenantId, this.runId)) {
      throw new AgentRunCancelledError();
    }
  }

  async nodeStarted(node: string): Promise<void> {
    await this.guard();
    const now = this.now();
    await Promise.all([
      this.store.updateAgentRun(this.ctx.tenantId, this.runId, { currentNode: node, updatedAt: now }),
      this.store.appendAgentRunEvent({
        tenantId: this.ctx.tenantId, runId: this.runId, type: 'node', node, status: 'started', createdAt: now,
      }),
    ]);
  }

  async nodeCompleted(node: string, detail?: Record<string, unknown>): Promise<void> {
    await this.guard();
    const now = this.now();
    await this.store.appendAgentRunEvent({
      tenantId: this.ctx.tenantId, runId: this.runId, type: 'node', node, status: 'completed', detail, createdAt: now,
    });
    if (typeof detail?.steps === 'number') {
      await this.store.updateAgentRun(this.ctx.tenantId, this.runId, { stepCount: detail.steps, updatedAt: now });
    }
  }

  async nodeFailed(node: string, error: unknown): Promise<void> {
    const now = this.now();
    await this.store.appendAgentRunEvent({
      tenantId: this.ctx.tenantId, runId: this.runId, type: 'node', node, status: 'failed',
      detail: { error: safeError(error) }, createdAt: now,
    });
  }

  async waiting(detail?: Record<string, unknown>): Promise<void> {
    await this.transition('waiting', 'interaction', detail);
  }

  async running(detail?: Record<string, unknown>): Promise<void> {
    await this.transition('running', 'interaction', detail);
  }

  async succeed(result: RunAgentResult): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    await this.store.updateAgentRun(this.ctx.tenantId, this.runId, {
      status: 'succeeded', currentNode: null, stepCount: result.steps,
      usage: normalizeUsage(result.usage), completedAt: now, updatedAt: now, clearLease: true,
    });
    await this.store.appendAgentRunEvent({
      tenantId: this.ctx.tenantId, runId: this.runId, type: 'run', status: 'succeeded',
      detail: { steps: result.steps, usage: normalizeUsage(result.usage) }, createdAt: now,
    });
    this.closeHeartbeat();
  }

  async fail(error: unknown): Promise<void> {
    if (this.closed) return;
    if (error instanceof AgentRunLeaseLostError) {
      this.closeHeartbeat();
      return;
    }
    const now = this.now();
    const status: AgentRunStatus = error instanceof AgentRunCancelledError
      ? 'cancelled'
      : error instanceof RecoveryRequiredError ? 'recovery_required' : 'failed';
    const message = safeError(error);
    await this.store.updateAgentRun(this.ctx.tenantId, this.runId, {
      status, currentNode: null, errorMessage: message, completedAt: now, updatedAt: now, clearLease: true,
    });
    await this.store.appendAgentRunEvent({
      tenantId: this.ctx.tenantId, runId: this.runId, type: 'run', status,
      detail: { error: message }, createdAt: now,
    });
    this.closeHeartbeat();
  }

  private async transition(status: 'waiting' | 'running', type: string, detail?: Record<string, unknown>): Promise<void> {
    await this.guard();
    const now = this.now();
    await Promise.all([
      this.store.updateAgentRun(this.ctx.tenantId, this.runId, { status, updatedAt: now }),
      this.store.appendAgentRunEvent({
        tenantId: this.ctx.tenantId, runId: this.runId, type, status, detail, createdAt: now,
      }),
    ]);
  }

  private closeHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.closed = true;
  }
}

function normalizeUsage(usage: Partial<AgentRunUsage>): AgentRunUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
  };
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return raw
    .replace(/(api[-_ ]?key|authorization|password|secret[-_ ]?token|token)\s*[:=]?\s*\S+/gi, '[redacted]')
    .slice(0, 1_024);
}
