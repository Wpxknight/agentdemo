export type SchedulerObservationName =
  | 'backlog'
  | 'due_lag_ms'
  | 'state_count'
  | 'retry'
  | 'duration_ms'
  | 'completion'
  | 'long_stuck';

/** Low-cardinality scheduler measurements. Fire IDs are correlation fields, not metric labels. */
export interface SchedulerObservation {
  name: SchedulerObservationName;
  value: number;
  fireId?: string;
  state?: 'claimed' | 'bound' | 'completed' | 'failed';
}

export interface SchedulerObserver {
  record(observation: SchedulerObservation): void;
}

/** Dependency-free observer for embedding and tests; callers may export its snapshot as desired. */
export class InMemorySchedulerObserver implements SchedulerObserver {
  private readonly observations: SchedulerObservation[] = [];

  record(observation: SchedulerObservation): void {
    this.observations.push({ ...observation });
  }

  snapshot(): readonly SchedulerObservation[] {
    return this.observations.map((observation) => ({ ...observation }));
  }
}
