# Task 11 Runtime Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Correct durable cancellation, SSE supervision, recovery observability, memory transaction isolation, concurrency cleanup, migration-lock safety, and lockfile integrity found by Task 11 review.

**Architecture:** Durable state is authoritative: HTTP session termination discovers runs through the product Store, cancellation transitions inactive runs atomically, and SSE connections only consume an independently supervised execution. Recovery supervision writes sanitized lifecycle events through the durable event repository. Memory transactions use a non-reentrant transactional view over one serialized mutation boundary, matching MySQL transaction semantics.

**Tech Stack:** TypeScript, Vitest, Pi durable runtime, Kysely/MySQL, Node HTTP/SSE, npm lockfile v3.

---

### Task 1: Durable session termination and inactive cancellation

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/src/db/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/src/db/memory.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/src/db/mysql.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/src/server/http.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/packages/pi-runtime/src/run/manager.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/packages/pi-runtime/src/store/types.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/packages/pi-runtime/src/store/memory.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/packages/pi-runtime/src/store/mysql.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/tests/http.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/tests/pi-runtime/durable-run.test.ts`

- [x] Add real HTTP lifecycle tests proving termination cancels owner-scoped queued/waiting runs even when the server-local active map is empty.
- [x] Run the focused tests and confirm termination reports success while durable run state remains uncancelled.
- [x] Add a tenant/owner/session active-run query to `Store`, backed by the single durable Memory/MySQL Store.
- [x] Change termination to abort local consumers as an acceleration, then call mandatory `durableRunRuntime.cancel()` for every authoritative queued/running/waiting run.
- [x] Add Memory/MySQL cancellation tests proving queued/waiting without an active lease become terminal `cancelled`, inbox closes, and lease state clears; running with a live lease remains request-only.
- [x] Add an atomic Store cancellation operation used by `DurableRunManager.cancel()` and verify focused tests pass.

### Task 2: SSE detach and durable background supervision

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/src/server/http.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/tests/http.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/tests/http-agent-runs.test.ts`

- [x] Add a real HTTP test that disconnects the SSE response, lets the durable handle finish, and reconnects with `Last-Event-ID` to observe persisted events/result.
- [x] Run it and confirm response close currently aborts the durable execution.
- [x] Separate the response consumer from a background supervisor that drains both events and `handle.result()` independently of socket lifetime.
- [x] Make socket close detach only the response writer; retain explicit cancel/terminate as the only abort paths.
- [x] Run focused HTTP tests and confirm disconnect continuation and replay.

### Task 3: Recovery supervisor lifecycle and failure persistence

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/src/server/http.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/tests/http-agent-runs.test.ts`

- [x] Add lifecycle tests for immediate `resume()` rejection and later `handle.result()` rejection using the real Memory Store event/run projections.
- [x] Run them and confirm missing `recovery_requested/started/failed` events and ambiguous run state.
- [x] Persist `recovery_requested`, `recovery_started`, `recovery_succeeded`, and `recovery_failed` events with sanitized details.
- [x] On failure, perform a fenced durable transition to `recovery_required`, retaining retryability and no raw secret-bearing error.
- [x] Run focused recovery tests and verify both failure phases.

### Task 4: Memory transaction serialization and rollback isolation

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/packages/pi-runtime/src/store/memory.ts`
- Test: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/tests/pi-runtime/durable-run.test.ts`

- [x] Add timeout-bounded tests proving `tx.create()` and `tx.inbox.enqueue()` do not self-deadlock.
- [x] Add a controlled concurrent-write test proving a failed transaction rollback does not erase a successful write serialized after it.
- [x] Run tests and confirm deadlock/rollback failure.
- [x] Introduce a transaction-scoped non-reentrant facade whose mutation methods call locked internal implementations while outer transactions own the single serialization boundary.
- [x] Run all Memory durable Store tests and verify rollback parity.

### Task 5: Model concurrency cleanup

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/packages/pi-runtime/src/model/concurrency.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/tests/pi-runtime/model-concurrency.test.ts`

- [x] Add a test-visible diagnostics count and a test proving a pre-aborted first acquisition leaves no semaphore key.
- [x] Run the test and confirm the key remains allocated.
- [x] Delete an idle semaphore when `acquire()` rejects, without deleting a live/replaced semaphore.
- [x] Run the model concurrency suite.

### Task 6: Migration advisory lock destruction

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/src/db/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/tests/integration/runtime-assembly.test.ts`

- [x] Add tests for `RELEASE_LOCK` returning `0`/`null` and throwing, asserting the connection is destroyed rather than returned to the pool.
- [x] Run focused integration tests and confirm the connection is currently released.
- [x] Validate the release result equals `1`; destroy on failure and release only after confirmed unlock.
- [x] Run migration assembly tests.

### Task 7: Lockfile integrity

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/.worktrees/task11-runtime-assembly/package-lock.json`

- [x] Compare the lockfile against the pre-refactor lock and identify registry packages lacking `resolved` or `integrity`.
- [x] Regenerate with the repository npm configuration and installed npm version using `npm install --package-lock-only --ignore-scripts`.
- [x] Verify retired workspaces/dependencies are removed without unrelated dependency upgrades.
- [x] Run a script that rejects non-link registry packages missing `resolved` or `integrity`.

### Task 8: Final verification and commit

**Files:**
- Update generated public API snapshots only if source declarations changed.

- [x] Run focused RED/GREEN suites and MySQL integration when `MYSQL_HOST` is available; otherwise record the explicit conditional skip and run MySQL source/contract tests.
- [x] Run `npm test`.
- [x] Run `make test-agent-platform`.
- [x] Run `make verify-runtime-refactor`.
- [x] Run `git diff --check` and the lockfile integrity check.
- [x] Commit with subject `fix: harden durable runtime lifecycle` and exactly one `Co-authored-by: AIOS <noreply@bocloud.com>` trailer.

### Task 9: Second review lifecycle hardening

- [x] Reproduce escaped `AsyncLocalStorage` descendants being erased by a later transaction rollback, then replace the boolean context with an invalidatable token released only after deactivation.
- [x] Reproduce stale recovery token1 overwriting token2's waiting state; require durable token equality in Memory and MySQL even after owner/expiry are cleared.
- [x] Add conditional MySQL behavior parity coverage and an always-run MySQL source contract because `MYSQL_HOST` is unset in this environment.
- [x] Reproduce the HTTP supervisor race and remove the generic unfenced `updateAgentRun` fallback; failed recovery event append remains best-effort.
- [x] Require exact lockfile copies and unconditional `npm ci` in both backend and frontend Dockerfiles.
- [x] Align inactive Memory cancellation with MySQL by persisting the cancellation reason as `errorMessage`.
- [x] Restore the five optional WASM transitive packages to their pre-hardening versions with their original `resolved` and `integrity` metadata: `@emnapi/core@2.0.0-alpha.3`, `@emnapi/runtime@2.0.0-alpha.3`, `@emnapi/wasi-threads@2.0.1`, `@napi-rs/wasm-runtime@1.2.0`, and `@tybys/wasm-util@0.10.3`.
- [x] Verify npm 11.6.2 accepts the restored lock with `npm ci --ignore-scripts --dry-run`; registry integrity and retired-workspace checks both report zero violations.
- [x] Run final full gates and prepare the second-review fixes for commit.
