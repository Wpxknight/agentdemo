import { randomUUID } from 'node:crypto';
import type { ToolCall } from '../model/types.js';
import type { ToolContext } from './tools.js';

export interface ApprovalRequest {
  call: ToolCall;
  reason?: string;
  ctx: ToolContext;
}

export interface ApprovalPending {
  id: string;
  tenantId: string;
  sessionId: string;
  userId: string;
  call: ToolCall;
  reason?: string;
  diff?: string;
  createdAt: string;
}

interface PendingEntry {
  pending: ApprovalPending;
  resolve: (approved: boolean) => void;
  promise: Promise<boolean>;
}

function publicPending(entry: PendingEntry): ApprovalPending {
  return entry.pending;
}

/**
 * 审批门：当 Policy 判定 needApproval 时，由 gate 决定放行与否。
 * HTTP 服务可实现交互式 gate（暂停 loop、推 diff、等确认续跑）。
 */
export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<boolean>;
}

/** 默认拒绝（无人值守且未预批准时的安全默认）。 */
export class AutoDenyGate implements ApprovalGate {
  async request(): Promise<boolean> {
    return false;
  }
}

/** 自动批准（测试 / 受信环境）。 */
export class AutoApproveGate implements ApprovalGate {
  async request(): Promise<boolean> {
    return true;
  }
}

/** 用回调实现的审批门（便于 HTTP 层接入人工确认）。 */
export class CallbackGate implements ApprovalGate {
  constructor(private readonly fn: (req: ApprovalRequest) => Promise<boolean>) {}
  request(req: ApprovalRequest): Promise<boolean> {
    return this.fn(req);
  }
}

/** 进程内待审批队列；用于一条活跃 SSE 连接的暂停/续跑。 */
export class InMemoryApprovalStore {
  private readonly pending = new Map<string, PendingEntry>();

  create(input: Omit<ApprovalPending, 'id' | 'createdAt'>): { pending: ApprovalPending; promise: Promise<boolean> } {
    const id = randomUUID();
    let resolve!: (approved: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    const entry: PendingEntry = {
      pending: { ...input, id, createdAt: new Date().toISOString() },
      resolve,
      promise,
    };
    this.pending.set(id, entry);
    return { pending: publicPending(entry), promise };
  }

  get(id: string): ApprovalPending | undefined {
    const entry = this.pending.get(id);
    return entry ? publicPending(entry) : undefined;
  }

  list(tenantId: string): ApprovalPending[] {
    return [...this.pending.values()]
      .map(publicPending)
      .filter((p) => p.tenantId === tenantId);
  }

  async approve(id: string, tenantId: string): Promise<boolean> {
    return this.resolve(id, tenantId, true);
  }

  async deny(id: string, tenantId: string): Promise<boolean> {
    return this.resolve(id, tenantId, false);
  }

  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(false);
  }

  private resolve(id: string, tenantId: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry || entry.pending.tenantId !== tenantId) return false;
    this.pending.delete(id);
    entry.resolve(approved);
    return true;
  }
}

export class InteractiveApprovalGate implements ApprovalGate {
  constructor(private readonly opts: {
    store: InMemoryApprovalStore;
    emit: (pending: ApprovalPending) => unknown | Promise<unknown>;
    diff?: (req: ApprovalRequest) => Promise<string | undefined>;
    signal?: AbortSignal;
    onCancel?: (pending: ApprovalPending) => unknown | Promise<unknown>;
  }) {}

  async request(req: ApprovalRequest): Promise<boolean> {
    if (this.opts.signal?.aborted) return false;

    let diff: string | undefined;
    if (this.opts.diff) {
      try {
        diff = await this.opts.diff(req);
      } catch (err) {
        diff = `[dry-run error]\n${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const { pending, promise } = this.opts.store.create({
      tenantId: req.ctx.tenantId ?? '',
      sessionId: req.ctx.sessionId,
      userId: req.ctx.userId ?? '',
      call: req.call,
      reason: req.reason,
      diff,
    });

    const onAbort = () => {
      this.opts.store.cancel(pending.id);
      void this.opts.onCancel?.(pending);
    };
    this.opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.opts.emit(pending);
      return await promise;
    } finally {
      this.opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}
