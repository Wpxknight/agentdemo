import { createRunDispatcher, scheduledFireId } from '../../packages/scheduler-runtime/src/index.js';
import type { Runtime } from '../runtime.js';
import type { ScheduledTask } from '../db/store.js';
import { Scheduler, type TaskRunner } from './ticker.js';

type Env = Record<string, string | undefined>;

export function shouldEmbedScheduler(env: Env = process.env): boolean {
  const value = env.AIOP_EMBED_SCHEDULER?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

/** Creates a durable product Run. The scheduler never enters an agent/Pi execution loop. */
export function createScheduledTaskRunner(rt: Runtime): TaskRunner {
  return async (task: ScheduledTask) => {
    if (!rt.durableRunRuntime) {
      throw new Error('DurableRunRuntime is required for scheduled Run creation');
    }
    const dispatcher = createRunDispatcher(rt.durableRunRuntime);
    const fireTime = task.nextRunAt;
    const result = await dispatcher.startScheduledRun({
      taskId: String(task.id),
      fireId: scheduledFireId(String(task.id), fireTime),
      fireTime,
      identity: { tenantId: task.tenantId, actorId: task.userId, roles: ['user'] },
      sessionId: task.sessionId,
      input: [{ role: 'user', text: task.task }],
    });
    return { status: 'success', detail: result.runId };
  };
}

export function startRuntimeScheduler(rt: Runtime): Scheduler {
  const scheduler = new Scheduler({ store: rt.store, runner: createScheduledTaskRunner(rt) });
  scheduler.start();
  return scheduler;
}
