import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../auth/types.js';
import { can } from '../../auth/rbac.js';
import type { InteractionKind, InteractionRecord, Store } from '../../db/store.js';

export interface CreateInteractionInput {
  id?: string;
  kind: InteractionKind;
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
  toolCallId?: string;
  payload: unknown;
  expiresAt: Date;
}

export interface InteractionResolution {
  sessionId: string;
  runId: string;
  value: unknown;
}

export class DurableInteractionService {
  private readonly waiters = new Map<string, Set<(record: InteractionRecord) => void>>();

  constructor(private readonly store: Store) {}

  async create(input: CreateInteractionInput): Promise<InteractionRecord> {
    if (input.id) {
      const existing = await this.store.getInteraction(input.tenantId, input.id);
      if (existing) return existing;
    }
    const now = new Date();
    const record: InteractionRecord = {
      ...input,
      id: input.id ?? randomUUID(),
      status: 'pending',
      createdAt: now,
    };
    await this.store.putInteraction(record);
    return record;
  }

  async listPending(ctx: RequestContext): Promise<InteractionRecord[]> {
    const records = await this.store.listPendingInteractions(ctx);
    return records.filter((record) => record.userId === ctx.userId || can(ctx.role, 'approve'));
  }

  async resolve(
    ctx: RequestContext,
    id: string,
    resolution: InteractionResolution,
  ): Promise<InteractionRecord> {
    const current = await this.store.getInteraction(ctx.tenantId, id);
    if (!current) throw new Error('交互不存在');
    if (current.status !== 'pending') throw new Error('交互已处理');
    if (current.expiresAt.getTime() <= Date.now()) {
      const expired = { ...current, status: 'expired' as const, resolvedAt: new Date() };
      await this.store.resolveInteraction(expired);
      throw new Error('交互已过期');
    }
    if (current.userId !== ctx.userId && !(current.kind === 'approval' && can(ctx.role, 'approve'))) {
      throw new Error('无权处理该交互');
    }
    if (current.sessionId !== resolution.sessionId || current.runId !== resolution.runId) {
      throw new Error('交互所属会话或运行不匹配');
    }
    const resolved: InteractionRecord = {
      ...current,
      status: 'resolved',
      resolution: resolution.value,
      resolvedBy: ctx.userId,
      resolvedAt: new Date(),
    };
    if (!await this.store.resolveInteraction(resolved)) throw new Error('交互已处理');
    this.notify(resolved);
    return resolved;
  }

  async cancel(tenantId: string, id: string): Promise<boolean> {
    const current = await this.store.getInteraction(tenantId, id);
    if (!current || current.status !== 'pending') return false;
    const cancelled = { ...current, status: 'cancelled' as const, resolvedAt: new Date() };
    if (!await this.store.resolveInteraction(cancelled)) return false;
    this.notify(cancelled);
    return true;
  }

  async wait(tenantId: string, id: string, signal?: AbortSignal): Promise<InteractionRecord> {
    const current = await this.store.getInteraction(tenantId, id);
    if (!current) throw new Error('交互不存在');
    if (current.status !== 'pending') return current;
    return new Promise<InteractionRecord>((resolve) => {
      const listeners = this.waiters.get(id) ?? new Set();
      const finish = (record: InteractionRecord) => {
        listeners.delete(finish);
        if (!listeners.size) this.waiters.delete(id);
        resolve(record);
      };
      listeners.add(finish);
      this.waiters.set(id, listeners);
      signal?.addEventListener('abort', () => void this.cancel(tenantId, id), { once: true });
    });
  }

  private notify(record: InteractionRecord): void {
    for (const resolve of this.waiters.get(record.id) ?? []) resolve(record);
  }
}
