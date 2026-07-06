import type { Msg } from '../model/types.js';
import { estimateTokens } from '../agent/context.js';
import type { AuditEvent } from '../audit/sink.js';
import type { RequestContext, Tenant, User } from '../auth/types.js';
import type { McpServerConfig } from '../mcp/types.js';
import type {
  AuditFilter,
  NewUser,
  LlmSettings,
  SchedulerSettings,
  SessionContextUsage,
  SessionInput,
  SessionSummary,
  SessionTouchInput,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskPatch,
  Store,
  TaskRun,
  UserWithSecret,
} from './store.js';
import { DEFAULT_SESSION_TITLE } from './store.js';
import { nextRunAt } from '../scheduler/cron.js';

interface MsgRow {
  tenantId: string;
  sessionId: string;
  msg: Msg;
  createdAt: Date;
}

interface SessionRow {
  tenantId: string;
  sessionId: string;
  title: string;
  explicitTitle: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function summarize(text: string | undefined, max = 48): string {
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

/** 内存 Store：未配置 MySQL 时的回落实现，亦用于测试。租户隔离同样强制生效。 */
export class MemoryStore implements Store {
  private messages: MsgRow[] = [];
  private sessions = new Map<string, SessionRow>();
  private audit: AuditEvent[] = [];
  private tasks = new Map<number, ScheduledTask>();
  private runs: TaskRun[] = [];
  private tenants = new Map<string, Tenant>();
  private users = new Map<string, UserWithSecret>(); // key: tenantId/username
  private llmSettings = new Map<string, LlmSettings>();
  private schedulerSettings = new Map<string, SchedulerSettings>();
  private mcpServers = new Map<string, Record<string, McpServerConfig>>();
  private taskSeq = 0;
  private runSeq = 0;
  private userSeq = 0;

  private sessionKey(ctx: Pick<RequestContext, 'tenantId'>, sessionId: string): string {
    return `${ctx.tenantId}/${sessionId}`;
  }

  private sessionMessages(ctx: RequestContext, sessionId: string): MsgRow[] {
    return this.messages.filter((r) => r.tenantId === ctx.tenantId && r.sessionId === sessionId);
  }

  private sessionSummary(ctx: RequestContext, session: SessionRow): SessionSummary {
    const rows = this.sessionMessages(ctx, session.sessionId);
    const last = rows.at(-1);
    return {
      sessionId: session.sessionId,
      title: session.title,
      lastMessage: summarize(last?.msg.text),
      messageCount: rows.length,
      updatedAt: (last?.createdAt ?? session.updatedAt).toISOString(),
    };
  }

  async createSession(ctx: RequestContext, input: SessionInput): Promise<SessionSummary> {
    const now = new Date();
    const key = this.sessionKey(ctx, input.sessionId);
    // 占位标题（如前端默认的“新会话”）不算显式命名，之后首条用户消息可覆盖。
    const explicitTitle = Boolean(input.title) && input.title !== DEFAULT_SESSION_TITLE;
    const existing = this.sessions.get(key);
    if (existing) {
      if (input.title) {
        existing.title = summarize(input.title);
        existing.explicitTitle = explicitTitle || existing.explicitTitle;
      }
      existing.updatedAt = now;
      return this.sessionSummary(ctx, existing);
    }

    const session: SessionRow = {
      tenantId: ctx.tenantId,
      sessionId: input.sessionId,
      title: summarize(input.title ?? input.sessionId),
      explicitTitle,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    return this.sessionSummary(ctx, session);
  }

  async touchSession(ctx: RequestContext, sessionId: string, input: SessionTouchInput = {}): Promise<void> {
    const key = this.sessionKey(ctx, sessionId);
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : new Date();
    const existing = this.sessions.get(key);
    if (existing) {
      // 占位标题被首条用户消息覆盖一次后即锁定，后续消息不再改名。
      if (input.title && !existing.explicitTitle) {
        existing.title = summarize(input.title);
        existing.explicitTitle = true;
      }
      existing.updatedAt = updatedAt;
      return;
    }

    this.sessions.set(key, {
      tenantId: ctx.tenantId,
      sessionId,
      title: summarize(input.title ?? sessionId),
      explicitTitle: Boolean(input.title) && input.title !== DEFAULT_SESSION_TITLE,
      createdAt: updatedAt,
      updatedAt,
    });
  }

  async appendMessage(ctx: RequestContext, sessionId: string, msg: Msg): Promise<void> {
    const createdAt = new Date();
    this.messages.push({ tenantId: ctx.tenantId, sessionId, msg, createdAt });
    await this.touchSession(ctx, sessionId, {
      title: msg.role === 'user' ? msg.text : undefined,
      updatedAt: createdAt,
    });
  }

  async appendMessages(ctx: RequestContext, sessionId: string, msgs: Msg[]): Promise<void> {
    if (!msgs.length) return;
    const createdAt = new Date();
    for (const msg of msgs) this.messages.push({ tenantId: ctx.tenantId, sessionId, msg, createdAt });
    await this.touchSession(ctx, sessionId, {
      title: msgs.find((m) => m.role === 'user' && m.text)?.text,
      updatedAt: createdAt,
    });
  }

  async listMessages(ctx: RequestContext, sessionId: string): Promise<Msg[]> {
    return this.sessionMessages(ctx, sessionId).map((r) => r.msg);
  }

  async replaceMessages(ctx: RequestContext, sessionId: string, messages: Msg[]): Promise<void> {
    const createdAt = new Date();
    this.messages = this.messages.filter((r) => !(r.tenantId === ctx.tenantId && r.sessionId === sessionId));
    for (const msg of messages) this.messages.push({ tenantId: ctx.tenantId, sessionId, msg, createdAt });
  }

  async listSessions(ctx: RequestContext, limit = 50, offset = 0): Promise<SessionSummary[]> {
    const safeLimit = Math.max(0, limit);
    const safeOffset = Math.max(0, offset);
    if (safeLimit <= 0) return [];

    return [...this.sessions.values()]
      .filter((r) => r.tenantId === ctx.tenantId)
      .map((session) => this.sessionSummary(ctx, session))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(safeOffset, safeOffset + safeLimit);
  }

  async countSessions(ctx: RequestContext): Promise<number> {
    return [...this.sessions.values()].filter((r) => r.tenantId === ctx.tenantId).length;
  }

  async deleteSession(ctx: RequestContext, sessionId: string): Promise<boolean> {
    const before = this.messages.length;
    this.messages = this.messages.filter((r) => !(r.tenantId === ctx.tenantId && r.sessionId === sessionId));
    const deletedSession = this.sessions.delete(this.sessionKey(ctx, sessionId));
    return this.messages.length < before || deletedSession;
  }

  async getSessionContextUsage(
    ctx: RequestContext,
    sessionId: string,
    maxTokens: number,
  ): Promise<SessionContextUsage> {
    return {
      usedTokens: estimateTokens(await this.listMessages(ctx, sessionId)),
      maxTokens,
      estimated: true,
    };
  }

  async record(event: AuditEvent): Promise<void> {
    this.audit.push({ ...event });
  }

  async listAudit(ctx: RequestContext, filter: AuditFilter = {}): Promise<AuditEvent[]> {
    let rows = this.audit.filter((e) => e.tenantId === ctx.tenantId);
    if (filter.sessionId) rows = rows.filter((e) => e.sessionId === filter.sessionId);
    if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
    const out = [...rows];
    return filter.limit ? out.slice(-filter.limit) : out;
  }

  async createScheduledTask(ctx: RequestContext, input: ScheduledTaskInput): Promise<ScheduledTask> {
    const id = ++this.taskSeq;
    const task: ScheduledTask = {
      id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: input.sessionId,
      cron: input.cron,
      task: input.task,
      preApproved: input.preApproved ?? false,
      enabled: input.enabled ?? true,
      nextRunAt: nextRunAt(input.cron, new Date()),
    };
    this.tasks.set(id, task);
    return { ...task };
  }

  async listScheduledTasks(ctx: RequestContext): Promise<ScheduledTask[]> {
    return [...this.tasks.values()]
      .filter((t) => t.tenantId === ctx.tenantId)
      .map((t) => ({ ...t }));
  }

  async getScheduledTask(ctx: RequestContext, id: number): Promise<ScheduledTask | undefined> {
    const t = this.tasks.get(id);
    return t && t.tenantId === ctx.tenantId ? { ...t } : undefined;
  }

  async updateScheduledTask(ctx: RequestContext, id: number, patch: ScheduledTaskPatch): Promise<ScheduledTask | undefined> {
    const t = this.tasks.get(id);
    if (!t || t.tenantId !== ctx.tenantId) return undefined;
    if (patch.task !== undefined) t.task = patch.task;
    if (patch.preApproved !== undefined) t.preApproved = patch.preApproved;
    if (patch.enabled !== undefined) t.enabled = patch.enabled;
    if (patch.cron !== undefined && patch.cron !== t.cron) {
      t.cron = patch.cron;
      t.nextRunAt = nextRunAt(patch.cron, new Date());
    }
    return { ...t };
  }

  async deleteScheduledTask(ctx: RequestContext, id: number): Promise<boolean> {
    const t = this.tasks.get(id);
    if (!t || t.tenantId !== ctx.tenantId) return false;
    this.tasks.delete(id);
    this.runs = this.runs.filter((r) => r.taskId !== id);
    return true;
  }

  async setTaskEnabled(ctx: RequestContext, id: number, enabled: boolean): Promise<void> {
    const t = this.tasks.get(id);
    if (t && t.tenantId === ctx.tenantId) t.enabled = enabled;
  }

  // 单进程内 JS 单线程：select→推进之间无 await，天然原子，并发 tick 不会重复领取。
  async claimDueTasks(now: Date, limit: number): Promise<ScheduledTask[]> {
    const due = [...this.tasks.values()]
      .filter((t) => t.enabled && t.nextRunAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
      .slice(0, limit);
    const claimed = due.map((t) => ({ ...t }));
    for (const t of due) {
      t.lastRunAt = now;
      t.nextRunAt = nextRunAt(t.cron, now);
    }
    return claimed;
  }

  async recordTaskRun(run: TaskRun): Promise<void> {
    this.runs.push({
      ...run,
      id: run.id ?? ++this.runSeq,
      createdAt: run.createdAt ?? new Date(),
    });
  }

  async listTaskRuns(ctx: RequestContext, taskId: number): Promise<TaskRun[]> {
    const t = this.tasks.get(taskId);
    if (!t || t.tenantId !== ctx.tenantId) return [];
    return this.runs
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
      .map((r) => ({ ...r }));
  }

  async createTenant(tenant: Tenant): Promise<void> {
    this.tenants.set(tenant.id, { ...tenant });
  }

  async listTenants(): Promise<Tenant[]> {
    return [...this.tenants.values()];
  }

  async createUser(user: NewUser): Promise<User> {
    const id = `u${++this.userSeq}`;
    const rec: UserWithSecret = {
      id,
      tenantId: user.tenantId,
      username: user.username,
      role: user.role,
      passwordHash: user.passwordHash,
    };
    this.users.set(`${user.tenantId}/${user.username}`, rec);
    const { passwordHash: _omit, ...pub } = rec;
    return pub;
  }

  async getUserByUsername(tenantId: string, username: string): Promise<UserWithSecret | undefined> {
    const u = this.users.get(`${tenantId}/${username}`);
    return u ? { ...u } : undefined;
  }

  async getUser(tenantId: string, userId: string): Promise<User | undefined> {
    for (const u of this.users.values()) {
      if (u.tenantId === tenantId && u.id === userId) {
        const { passwordHash: _omit, ...pub } = u;
        return pub;
      }
    }
    return undefined;
  }

  async getLlmSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<LlmSettings | undefined> {
    const settings = this.llmSettings.get(ctx.tenantId);
    return settings ? { ...settings } : undefined;
  }

  async setLlmSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: LlmSettings): Promise<void> {
    this.llmSettings.set(ctx.tenantId, { ...settings });
  }

  async getSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>): Promise<SchedulerSettings | undefined> {
    const settings = this.schedulerSettings.get(ctx.tenantId);
    return settings ? { ...settings } : undefined;
  }

  async setSchedulerSettings(ctx: Pick<RequestContext, 'tenantId'>, settings: SchedulerSettings): Promise<void> {
    this.schedulerSettings.set(ctx.tenantId, { ...settings });
  }

  async getMcpServers(ctx: Pick<RequestContext, 'tenantId'>): Promise<Record<string, McpServerConfig> | undefined> {
    const servers = this.mcpServers.get(ctx.tenantId);
    return servers ? structuredClone(servers) : undefined;
  }

  async setMcpServers(ctx: Pick<RequestContext, 'tenantId'>, servers: Record<string, McpServerConfig>): Promise<void> {
    this.mcpServers.set(ctx.tenantId, structuredClone(servers));
  }

  async close(): Promise<void> {
    this.messages = [];
    this.sessions.clear();
    this.audit = [];
    this.tasks.clear();
    this.runs = [];
    this.runSeq = 0;
    this.tenants.clear();
    this.users.clear();
    this.llmSettings.clear();
    this.schedulerSettings.clear();
    this.mcpServers.clear();
  }
}
