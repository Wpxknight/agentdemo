import type { Msg } from '../model/types.js';
import type { AuditEvent } from '../audit/sink.js';
import type {
  AuditFilter,
  ScheduledTask,
  ScheduledTaskInput,
  Store,
  TaskRun,
} from './store.js';
import { nextRunAt } from '../scheduler/cron.js';

/** 内存 Store：未配置 MySQL 时的回落实现，亦用于测试。 */
export class MemoryStore implements Store {
  private messages = new Map<string, Msg[]>();
  private audit: AuditEvent[] = [];
  private tasks = new Map<number, ScheduledTask>();
  private runs: TaskRun[] = [];
  private taskSeq = 0;

  async appendMessage(sessionId: string, msg: Msg): Promise<void> {
    const list = this.messages.get(sessionId) ?? [];
    list.push(msg);
    this.messages.set(sessionId, list);
  }

  async listMessages(sessionId: string): Promise<Msg[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async record(event: AuditEvent): Promise<void> {
    this.audit.push({ ...event });
  }

  async listAudit(filter: AuditFilter = {}): Promise<AuditEvent[]> {
    let rows = this.audit;
    if (filter.sessionId) rows = rows.filter((e) => e.sessionId === filter.sessionId);
    if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
    const out = [...rows];
    return filter.limit ? out.slice(-filter.limit) : out;
  }

  async createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const id = ++this.taskSeq;
    const task: ScheduledTask = {
      id,
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

  async listScheduledTasks(sessionId?: string): Promise<ScheduledTask[]> {
    const all = [...this.tasks.values()];
    return (sessionId ? all.filter((t) => t.sessionId === sessionId) : all).map((t) => ({ ...t }));
  }

  async setTaskEnabled(id: number, enabled: boolean): Promise<void> {
    const t = this.tasks.get(id);
    if (t) t.enabled = enabled;
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

  async listTaskRuns(taskId: number): Promise<TaskRun[]> {
    return this.runs.filter((r) => r.taskId === taskId).map((r) => ({ ...r }));
  }

  async close(): Promise<void> {
    this.messages.clear();
    this.audit = [];
    this.tasks.clear();
    this.runs = [];
  }
}
