// file: index.d.ts
import type { AgentRuntime } from '@aiop/control-contracts';
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
export declare class Scheduler {
    private readonly options;
    constructor(options: {
        store: SchedulerStore;
        runtime: AgentRuntime;
    });
    tick(now: Date, limit: number): Promise<number>;
}
