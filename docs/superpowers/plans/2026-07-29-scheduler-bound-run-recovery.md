# Scheduler Bound Durable Run Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a scheduled fire that is already bound to a Durable Run from being dispatched again, while allowing another Scheduler worker to reconcile or formally resume the same Run after a crash.

**Architecture:** Extend the Scheduler fire state machine with `bound` and `recovering`. Ordinary dispatch only handles `pending`; bound reconciliation observes the authoritative Durable Run, completes terminal results, leaves active leases untouched, and uses `DurableRunRuntime.resume()` only after both the Scheduler observation window and Durable lease expire. Every transition is fenced by a claim token and never depends on exception text.

**Tech Stack:** TypeScript, Kysely/MySQL, Vitest, `@aiop/control-contracts`, `@aiop/pi-runtime`, `@aiop/scheduler-runtime`.

---

### Task 1: Define the bound-fire store contract and Memory state machine

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/packages/scheduler-runtime/src/domain.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/packages/scheduler-runtime/src/store.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/tests/scheduler-runtime/scheduler-runtime.test.ts`

- [ ] **Step 1: Write failing Memory tests for bind isolation and recovery fencing**

Add tests which assert:

```ts
expect((await store.listFires())[0]).toMatchObject({
  state: 'bound', runId: fire.fireId, claimToken: originalToken, claimedBy: undefined,
});
expect(await store.recoverExpired(afterSchedulerLease)).toBe(0);
expect(await store.claimDue({ now: afterSchedulerLease, limit: 1, workerId: 'worker-b', leaseMs: 1000 })).toEqual([]);

const recovering = await store.claimBound({
  fireId: fire.fireId, expectedClaimToken: originalToken,
  now: afterSchedulerLease, workerId: 'worker-b', leaseMs: 1000,
});
expect(recovering).toMatchObject({ state: 'recovering', runId: fire.fireId, claimedBy: 'worker-b' });
expect(recovering?.claimToken).not.toBe(originalToken);
```

Also assert `releaseBound` returns `recovering` to `bound`, preserves the replacement token, sets `retryAt`, and never changes `attempts`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts -t "bound|recovering|long Run"
```

Expected: FAIL because `ScheduledFireState`, `claimBound`, and `releaseBound` do not exist and `bindRun` leaves the fire `claimed`.

- [ ] **Step 3: Add exact domain and store contracts**

Define:

```ts
export type ScheduledFireState = 'pending' | 'claimed' | 'bound' | 'recovering' | 'started';

export interface BoundScheduledFire extends ScheduledFire {
  state: 'bound';
  runId: string;
  claimToken: string;
  leaseExpiresAt: Date;
}

export interface RecoveringScheduledFire extends ScheduledFire {
  state: 'recovering';
  runId: string;
  claimToken: string;
  claimedBy: string;
  leaseExpiresAt: Date;
}

export interface ListBoundInput { now: Date; limit: number }

export interface ClaimBoundInput {
  fireId: string;
  expectedClaimToken: string;
  now: Date;
  workerId: string;
  leaseMs: number;
}

export interface ReleaseBoundInput {
  fireId: string;
  claimToken: string;
  retryAt: Date;
  error: string;
}
```

Extend `SchedulerStore` with:

```ts
listBound(input: ListBoundInput): Promise<BoundScheduledFire[]>;
claimBound(input: ClaimBoundInput): Promise<RecoveringScheduledFire | undefined>;
releaseBound(input: ReleaseBoundInput): Promise<void>;
```

Implement Memory transitions:

- `bindRun`: `claimed → bound`, preserve `claimToken` and `leaseExpiresAt`, clear `claimedBy`, persist `runId`.
- `listBound`: return a bounded copy of expired `bound` rows whose `retryAt` is due.
- `claimBound`: CAS the exact `fireId + expectedClaimToken + state=bound` row to `recovering`, replace token/owner/lease, and do not increment ordinary dispatch `attempts`.
- `releaseBound`: `recovering → bound`, preserve the recovery token, clear owner, set the next observation lease and `retryAt` to the supplied retry time.
- `recoverExpired`: `claimed → pending`; `recovering → bound`; never change `bound`.
- `completeFire`: accept matching token in `bound` or `recovering`, plus idempotent same-Run `started` replay.

- [ ] **Step 4: Run focused and complete Scheduler package tests**

Run:

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts
```

Expected: PASS, with the MySQL environment contract skipped only when `MYSQL_HOST` is absent.

- [ ] **Step 5: Commit the Memory state machine**

```bash
git add packages/scheduler-runtime/src/domain.ts packages/scheduler-runtime/src/store.ts tests/scheduler-runtime/scheduler-runtime.test.ts
git commit -m "fix: fence bound scheduler fires" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
git show -s --format=%B HEAD
```

### Task 2: Implement MySQL bound and recovery transitions

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/packages/scheduler-runtime/src/mysql.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/docs/public-api/scheduler-runtime.d.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/tests/scheduler-runtime/scheduler-runtime.test.ts`

- [ ] **Step 1: Write failing MySQL contract tests**

Add source and executable MySQL assertions for these SQL invariants:

```ts
expect(bindRunSource).toContain("state: 'bound'");
expect(bindRunSource).toContain("claim_owner: null");
expect(recoverExpiredSource).toContain("where('state', '=', 'claimed')");
expect(claimBoundSource).toContain("where('state', '=', 'bound')");
expect(claimBoundSource).toContain("where('run_id', 'is not', null)");
expect(claimBoundSource).toContain("forUpdate().skipLocked()");
```

When MySQL is available, insert a fire, claim it, bind it, advance beyond its Scheduler lease, and assert ordinary `claimDue` does not return it. Then claim it through `claimBound` and verify the new token and `recovering` state.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts -t "MySQL.*bound|MySQL.*recover"
```

Expected: source contract FAIL; executable contract also FAIL when MySQL is configured.

- [ ] **Step 3: Implement transactional MySQL transitions**

Implement `bindRun` under `SELECT ... FOR UPDATE` with `fire_id + state=claimed + claim_token`, then set:

```ts
{
  state: 'bound',
  run_id: input.runId,
  claim_owner: null,
  updated_at: input.boundAt,
}
```

Keep the original token and observation deadline. Insert `task_agent_runs` in the same transaction.

Implement `listBound` using a bounded query over:

```sql
state = 'bound'
AND run_id IS NOT NULL
AND lease_expires_at <= :now
AND (retry_at IS NULL OR retry_at <= :now)
```

Implement `claimBound` as a transaction that locks the exact `fire_id + state=bound + expected claim_token`, verifies `run_id` and the expired lease/retry window, then CASes to `recovering` with a new UUID token, owner, and recovery lease. Implement `releaseBound` as token-fenced `recovering → bound`. Update `recoverExpired` with two explicit statements: expired `claimed → pending`, expired `recovering → bound`; exclude `bound`.

Make `completeFire` lock and accept `bound` or `recovering` with the matching token. If already `started` with the same `run_id`, return without duplicating `task_runs`; reject mismatched Run IDs.

- [ ] **Step 4: Regenerate API and run MySQL/package tests**

Run:

```bash
npm run build:packages
npm run check:public-api -- --update
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts
```

Expected: PASS; only environment-dependent MySQL execution may skip.

- [ ] **Step 5: Commit MySQL transitions**

```bash
git add packages/scheduler-runtime/src/mysql.ts docs/public-api/scheduler-runtime.d.ts tests/scheduler-runtime/scheduler-runtime.test.ts
git commit -m "fix: persist scheduler bound recovery state" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
git show -s --format=%B HEAD
```

### Task 3: Reconcile bound fires against the authoritative Durable Run

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/packages/scheduler-runtime/src/domain.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/packages/scheduler-runtime/src/runner.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/src/scheduler/runner.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/tests/scheduler-runtime/scheduler-runtime.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/tests/scheduler.test.ts`

- [ ] **Step 1: Write failing real-Durable recovery tests**

Use `DurableRunManager` with `MemoryRunStore` and a controllable clock to prove:

1. A bound fire whose Durable Run has an effective lease remains `bound`; a second Scheduler tick makes zero `run()` and zero `resume()` calls and does not increment `attempts`.
2. After the Durable lease expires, a second Durable manager calls `resume({ identity, runId })`, receives the same `runId`, completes the Run, and Scheduler writes one final compatibility result.
3. A terminal or `waiting` Durable record completes the fire without `run()` or `resume()`; `waiting` maps to compatibility error and preserves `status: "waiting"` in detail.
4. A resume lease race or failure calls `releaseBound`, leaving the fire `bound` with a future retry window and no new deterministic Run.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts tests/scheduler.test.ts -t "bound Durable|expired Durable|waiting bound|resume race"
```

Expected: FAIL because bound inspection/recovery ports and runner flow do not exist.

- [ ] **Step 3: Define the explicit Durable recovery port**

Add:

```ts
export type BoundRunInspection =
  | { kind: 'active' }
  | { kind: 'terminal'; result: AgentRunResult }
  | { kind: 'recoverable' };

export interface BoundRunRecovery {
  inspect(fire: BoundScheduledFire, now: Date): Promise<BoundRunInspection>;
  resume(fire: RecoveringScheduledFire, signal?: AbortSignal): Promise<AgentRunResult>;
}
```

Require `boundRecovery` in `SchedulerRunnerOptions`. Production implementation in `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/src/scheduler/runner.ts` must:

- Verify the persisted binding matches tenant, actor, session, and deterministic fire/run ID.
- Convert `waiting`, `succeeded`, `failed`, `cancelled`, and `recovery_required` records to `terminal` results.
- Return `active` only for `queued`/`running` records whose Durable `leaseExpiresAt` is later than `now`.
- Return `recoverable` for `queued`/`running` records with no effective lease.
- Call only `rt.durableRunRuntime.resume({ identity, runId, signal })` for recovery and await `handle.result()`.

- [ ] **Step 4: Add bound reconciliation before ordinary due claims**

In `SchedulerRunner.tick`:

```ts
const bound = await store.listBound({ now, limit });
for (const fire of bound) {
  const inspected = await boundRecovery.inspect(fire, now);
  if (inspected.kind === 'active') continue;
  if (inspected.kind === 'terminal') {
    await store.completeFire({ fireId: fire.fireId, claimToken: fire.claimToken, runId: fire.runId, result: inspected.result, completedAt: now });
    continue;
  }
  const claimed = await store.claimBound({
    fireId: fire.fireId, expectedClaimToken: fire.claimToken, now, workerId, leaseMs,
  });
  if (!claimed) continue;
  try {
    const result = await boundRecovery.resume(claimed, signal);
    await store.completeFire({ fireId: claimed.fireId, claimToken: claimed.claimToken, runId: claimed.runId, result, completedAt: now });
  } catch (error) {
    await store.releaseBound({ fireId: claimed.fireId, claimToken: claimed.claimToken, retryAt: new Date(now.getTime() + retryDelayMs), error: String(error) });
  }
}
```

The exact-fire CAS prevents an unrelated worker from claiming the inspected row between inspection and recovery. Do not call `run()` for any `bound` or `recovering` fire.

- [ ] **Step 5: Run focused and full Scheduler tests**

Run:

```bash
npx vitest run tests/scheduler-runtime tests/scheduler.test.ts tests/scheduler-platform.test.ts
```

Expected: PASS with no duplicate dispatch and no ordinary-attempt increment during recovery.

- [ ] **Step 6: Commit bound reconciliation**

```bash
git add packages/scheduler-runtime/src/domain.ts packages/scheduler-runtime/src/runner.ts src/scheduler/runner.ts tests/scheduler-runtime/scheduler-runtime.test.ts tests/scheduler.test.ts
git commit -m "fix: recover bound scheduled runs" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
git show -s --format=%B HEAD
```

### Task 4: Verify integration, public API, and regression safety

**Files:**
- Modify if generated: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/docs/public-api/scheduler-runtime.d.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/tests/http.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task10-scheduler/tests/pi-runtime/durable-run.test.ts`

- [ ] **Step 1: Run package build, API, and type gates**

```bash
npm run build:packages
npm run check:public-api -- --update
npm run check:public-api
npm run typecheck
npm run verify:packages
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run Task 7/8/9/10 integration regression**

```bash
npx vitest run \
  --exclude '.worktrees/**' \
  --exclude 'dist/**' \
  --exclude 'node_modules/**' \
  tests/scheduler-runtime tests/scheduler.test.ts tests/scheduler-platform.test.ts \
  tests/pi-runtime/durable-run.test.ts tests/pi-runtime/recovery.test.ts \
  tests/mcp-runtime tests/mcp.test.ts tests/mcp-runtime-platform.test.ts \
  tests/sandbox-runtime tests/sandbox.test.ts tests/http.test.ts
```

Expected: all executable tests pass; only MySQL/provider tests may skip when their environment variables are absent.

- [ ] **Step 3: Confirm architectural boundaries**

Run:

```bash
rg -n "pi-agent-core|enter.*Pi|agentLoop" packages/scheduler-runtime src/scheduler
rg -n "startScheduledRun|runtime\.run\(" packages/scheduler-runtime/src src/scheduler
```

Expected: Scheduler package contains no Pi loop import; ordinary `runtime.run()` exists only in the new-fire dispatcher, while bound recovery calls `runtime.resume()`.

- [ ] **Step 4: Commit generated API updates or final corrections**

```bash
git add docs/public-api tests packages/scheduler-runtime src/scheduler
git commit -m "test: verify scheduler bound recovery" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
git show -s --format=%B HEAD
```

- [ ] **Step 5: Request independent spec and code-quality reviews**

Review base: `10b2005e5446855b93aff25462ce58a8c59f7ddb`.

The spec reviewer must confirm both prior Important findings are closed. After spec approval, the code-quality reviewer must inspect transaction fencing, idempotency, error handling, and test realism. Any Critical or Important finding requires another RED→GREEN fix and re-review.
