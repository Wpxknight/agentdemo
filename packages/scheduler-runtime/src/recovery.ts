import type { SchedulerStore } from './store.js';

export class SchedulerRecovery {
  constructor(private readonly store: SchedulerStore) {}

  recover(now: Date): Promise<number> {
    return this.store.recoverExpired(now);
  }
}
