import { logger } from '../logger.js';
import type { ScheduledTask, Store, TaskRun } from '../db/store.js';

const log = logger.child({ mod: 'scheduler' });

/** 执行一个到点任务，返回运行结果（由 index.ts 注入 runAgent 实现）。 */
export type TaskRunner = (task: ScheduledTask) => Promise<Omit<TaskRun, 'taskId'>>;

export interface SchedulerOptions {
  store: Store;
  runner: TaskRunner;
  /** 每轮领取的最大任务数。 */
  batch?: number;
  /** tick 间隔(ms)。 */
  intervalMs?: number;
  /** 可注入时钟，便于测试。 */
  now?: () => Date;
}

/**
 * DB 驱动的调度器：周期 tick 通过行锁领取到点任务 → 执行 → 记录 task_runs。
 * 多副本各自 tick，靠 Store.claimDueTasks 的原子领取避免重复执行。
 */
export class Scheduler {
  private readonly store: Store;
  private readonly runner: TaskRunner;
  private readonly batch: number;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.runner = opts.runner;
    this.batch = opts.batch ?? 10;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** 执行一轮：领取到点任务并逐个运行，返回处理的任务数。 */
  async tick(): Promise<number> {
    const due = await this.store.claimDueTasks(this.now(), this.batch);
    for (const task of due) {
      try {
        const result = await this.runner(task);
        await this.store.recordTaskRun({ taskId: task.id, ...result });
        log.info({ taskId: task.id, status: result.status }, 'task run recorded');
      } catch (err) {
        await this.store.recordTaskRun({ taskId: task.id, status: 'error', detail: String(err) });
        log.error({ taskId: task.id, err: String(err) }, 'task run failed');
      }
    }
    return due.length;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // 跳过重叠 tick
      this.running = true;
      void this.tick()
        .catch((err) => log.error({ err: String(err) }, 'tick error'))
        .finally(() => {
          this.running = false;
        });
    }, this.intervalMs);
    this.timer.unref?.();
    log.info({ intervalMs: this.intervalMs }, 'scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
