// file: index.d.ts
import type { Generated, Kysely } from 'kysely';
import type { ClaimedTask, SchedulerStore, TaskAgentRunLink } from '@aiop/scheduler-core';
export interface SchedulerMysqlDatabase {
    scheduled_tasks: {
        id: Generated<number>;
        tenant_id: string;
        user_id: string;
        session_id: string;
        title: string;
        cron: string;
        task: string;
        pre_approved: number;
        enabled: number;
        next_run_at: Date;
        last_run_at: Date | null;
        created_at: Generated<Date>;
    };
    task_agent_runs: {
        tenant_id: string;
        task_id: number;
        run_id: string;
        created_at: Date;
    };
}
export declare class MysqlSchedulerStore implements SchedulerStore {
    private readonly db;
    constructor(db: Kysely<SchedulerMysqlDatabase>);
    claimDue(now: Date, limit: number): Promise<ClaimedTask[]>;
    recordRunLink(input: TaskAgentRunLink): Promise<void>;
}
