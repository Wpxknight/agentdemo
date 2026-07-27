import type { AgentRuntime } from '@aiop/agent-contracts';

export interface ClaimedTask {
  taskId: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  input: string;
  roles?: readonly string[];
}

export interface TaskAgentRunLink {
  taskId: string;
  tenantId: string;
  runId: string;
}

export interface SchedulerStore {
  claimDue(now: Date, limit: number): Promise<ClaimedTask[]>;
  recordRunLink(input: TaskAgentRunLink): Promise<void>;
}

export class Scheduler {
  constructor(private readonly options: { store: SchedulerStore; runtime: AgentRuntime }) {}

  async tick(now: Date, limit: number): Promise<number> {
    const tasks = await this.options.store.claimDue(now, limit);
    for (const task of tasks) {
      const handle = await this.options.runtime.run({
        identity: { tenantId: task.tenantId, actorId: task.actorId, roles: task.roles ?? ['user'] },
        sessionId: task.sessionId,
        input: [{ role: 'user', text: task.input }],
      });
      await this.options.store.recordRunLink({ taskId: task.taskId, tenantId: task.tenantId, runId: handle.runId });
    }
    return tasks.length;
  }
}
