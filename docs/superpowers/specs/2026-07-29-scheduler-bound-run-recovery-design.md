# Scheduler Bound Durable Run Recovery Design

## Goal

Prevent a scheduled fire that is already bound to a durable Run from returning to the ordinary dispatch path, while allowing a new scheduler worker to finish or recover that same deterministic Run after a crash.

## Fire state machine

- `pending`: eligible for ordinary due-fire claiming and new Run creation.
- `claimed`: temporarily owned while creating a deterministic Run. `claim_token`, `claim_owner`, and `lease_expires_at` fence this phase.
- `bound`: the deterministic Run ID is durable. The binding token remains the final-completion fence, while `claim_owner` is cleared. `lease_expires_at` becomes the startup/observation window inherited from the original scheduler claim. Ordinary `recoverExpired` never changes a bound fire to pending.
- `recovering`: a scheduler worker has won a compare-and-swap recovery claim for an expired bound fire. A new claim token, owner, and lease fence the formal durable resume attempt.
- `started`: the durable Run reached a final result and compatibility history was written.

`recoverExpired` changes expired `claimed` fires to `pending` and expired `recovering` fires back to `bound`. It never changes `bound` fires to `pending`.

## Binding and completion

`bindRun` runs under the original claimed token. It records `run_id`, inserts `task_agent_runs`, changes the fire to `bound`, clears the scheduler owner, and preserves the existing scheduler lease deadline as the observation window.

The original worker may complete the fire using the preserved binding token. Terminal reconciliation also uses that token. `completeFire` accepts a correctly fenced `bound` or `recovering` fire and is idempotent when the same Run was already completed.

## Bound reconciliation

Each tick inspects bound fires whose observation window has expired. Inspection reads the authoritative durable Run record and returns one of three explicit outcomes:

- `active`: a queued/running Run still has an effective durable lease. Keep the fire bound. Do not dispatch, claim recovery, or increment attempts.
- `terminal`: the durable record contains a final status and usage. Complete the fire with the existing binding token and write compatibility `task_runs`.
- `recoverable`: the queued/running Run has no effective durable lease. Compare-and-swap the fire from `bound` to `recovering`, replace its scheduler token and lease, then call the supported `DurableRunRuntime.resume()` API for the same Run ID. Await the returned handle result before completing.

If the durable resume loses a lease race or fails, release `recovering` back to `bound` with a bounded retry window. Never send it to `pending` and never call `run()` for a bound fire.

The bind-time scheduler lease is the queued startup observation window. No additional timing constant is introduced.

## Durable API boundary

There is no supported way to attach to another worker's active in-memory Run handle. Therefore active durable leases are observed only through durable storage and left untouched. Expired queued/running Runs use `DurableRunRuntime.resume()`, whose underlying store claim increments the durable fencing token and loads the committed session.

No recovery decision depends on exception text.

## Testing

1. Memory scheduler test: a result that waits beyond the fire lease remains bound; a second worker does not dispatch and attempts stay unchanged.
2. MySQL source/production contract: bind changes state/token/owner/lease correctly; ordinary recovery excludes bound; recovery claim uses state, Run ID, token, and expired lease compare-and-swap.
3. Real durable test with `DurableRunManager` and `MemoryRunStore`: valid durable lease remains bound without a second run/resume; after the durable lease expires, a second manager formally resumes the same Run and the scheduler stores its final result.
4. Recovery failure returns the fire to bound with a retry window and never creates a second deterministic Run.

