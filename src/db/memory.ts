import type { Msg } from '../model/types.js';
import type { AuditEvent } from '../audit/sink.js';
import type { RequestContext, Tenant, User } from '../auth/types.js';
import type {
  AuditFilter,
  NewUser,
  LlmSettings,
  SessionSummary,
  ScheduledTask,
  ScheduledTaskInput,
  Store,
  TaskRun,
  UserWithSecret,
} from './store.js';
import { nextRunAt } from '../scheduler/cron.js';

interface MsgRow {
  tenantId: string;
  sessionId: string;
  msg: Msg;
  createdAt: Date;
}

function summarize(text: string | undefined, max = 48): string {
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

/** 内存 Store：未配置 MySQL 时的回落实现，亦用于测试。租户隔离同样强制生效。 */
export class MemoryStore implements Store {
  private messages: MsgRow[] = [];
  private audit: AuditEvent[] = [];
  private tasks = new Map<number, ScheduledTask>();
  private runs: TaskRun[] = [];
  private tenants = new Map<string, Tenant>();
  private users = new Map<string, UserWithSecret>(); // key: tenantId/username
  private llmSettings = new Map<string, LlmSettings>();
  private taskSeq = 0;
  private userSeq = 0;

  async appendMessage(ctx: RequestContext, sessionId: string, msg: Msg): Promise<void> {
    this.messages.push({ tenantId: ctx.tenantId, sessionId, msg, createdAt: new Date() });
  }

  async listMessages(ctx: RequestContext, sessionId: string): Promise<Msg[]> {
    return this.messages
      .filter((r) => r.tenantId === ctx.tenantId && r.sessionId === sessionId)
      .map((r) => r.msg);
  }

  async listSessions(ctx: RequestContext, limit = 50, offset = 0): Promise<SessionSummary[]> {
    const bySession = new Map<string, MsgRow[]>();
    for (const row of this.messages.filter((r) => r.tenantId === ctx.tenantId)) {
      const rows = bySession.get(row.sessionId) ?? [];
      rows.push(row);
      bySession.set(row.sessionId, rows);
    }
    return [...bySession.entries()]
      .map(([sessionId, rows]) => {
        const firstUser = rows.find((r) => r.msg.role === 'user' && r.msg.text)?.msg.text;
        const last = rows.at(-1);
        return {
          sessionId,
          title: summarize(firstUser ?? rows[0]?.msg.text ?? sessionId),
          lastMessage: summarize(last?.msg.text),
          messageCount: rows.length,
          updatedAt: last?.createdAt.toISOString(),
        };
      })
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(Math.max(0, offset), Math.max(0, offset) + limit);
  }

  async countSessions(ctx: RequestContext): Promise<number> {
    return new Set(this.messages.filter((r) => r.tenantId === ctx.tenantId).map((r) => r.sessionId)).size;
  }

  async deleteSession(ctx: RequestContext, sessionId: string): Promise<boolean> {
    const before = this.messages.length;
    this.messages = this.messages.filter((r) => !(r.tenantId === ctx.tenantId && r.sessionId === sessionId));
    return this.messages.length < before;
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
    this.runs.push({ ...run });
  }

  async listTaskRuns(ctx: RequestContext, taskId: number): Promise<TaskRun[]> {
    const t = this.tasks.get(taskId);
    if (!t || t.tenantId !== ctx.tenantId) return [];
    return this.runs.filter((r) => r.taskId === taskId).map((r) => ({ ...r }));
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

  async close(): Promise<void> {
    this.messages = [];
    this.audit = [];
    this.tasks.clear();
    this.runs = [];
    this.tenants.clear();
    this.users.clear();
    this.llmSettings.clear();
  }
}
