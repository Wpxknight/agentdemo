# Pi Integration Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` for inline, task-by-task execution. The repository owner explicitly requires serial development without worktrees or subagents.

**Goal:** Close every repository-development gap in `/home/opt/develop/aicoding/aiop/docs/design/12-pi-integration-plan.md`, with durable evidence for each acceptance condition and explicit separation of production-window tasks that cannot be completed from source code alone.

**Architecture:** Keep `@aiop/agent-runtime-core` kernel-neutral and persist every restart-sensitive decision in Runtime Store. Pi-specific context and loop behavior stay in `@aiop/agent-kernel-pi`; product compatibility stays in `@aiop/agent-runtime-aiop` and `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`. Optional providers must be usable from their public package roots without importing AIOP product implementations.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Kysely/MySQL, Pi 0.82.1, OpenSandbox 0.1.9, E2B Code Interpreter 2.6.0.

---

### Task 1: Durable limits, deadline recovery, bounded events, and shutdown

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-contracts/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/memory-store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-mysql/src/index.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/db/migrations/0020_agent_run_limits.sql`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/schema.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/durable-runtime.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/runtime-migrations.test.ts`

- [x] Add failing tests proving `maxTurns`, cumulative input/output tokens, cost, and deadline fail with `RUN_LIMIT_EXCEEDED`, including after resume.
- [x] Add a failing test proving `shutdown()` aborts active runs and persists `cancelled`.
- [x] Add a failing test proving text/thinking deltas reach the live observer but are not written as durable events, and that durable event buffering has a fixed upper bound.
- [x] Persist `RunLimits` in TurnSnapshot with `limits_json`, reload them during `resume()`, and enforce them at every Turn boundary.
- [x] Add `RUN_LIMIT_EXCEEDED` to the neutral error contract and return the exact violated limit in the sanitized error message.
- [x] Add `shutdown(reason?: string): Promise<void>` to `DurableAgentRuntime`; abort all active controllers and await their execution promises.
- [x] Persist only durable control facts (`tool_call`, `tool_result`, `usage`, `turn_end`, commit/failure events), while delivering text/thinking deltas only through the awaited live observer.
- [x] Run `npx vitest run tests/durable-runtime.test.ts tests/runtime-migrations.test.ts` and `npm run typecheck`.
- [x] Commit with the required AIOS co-author trailer.

### Task 2: Pi context management in the real Durable AIOP path

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-kernel-pi/src/context-manager.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-kernel-pi/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/pi/kernel.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/pi-context-manager.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/agent-runtime.test.ts`

- [x] Add a failing product-path test where an oversized committed transcript is compacted before the next model call and the compacted messages are committed.
- [x] Add neutral `ContextManager` hooks to Pi Kernel options; use Pi package-root `estimateContextTokens`, `prepareCompaction`, and `compact` only.
- [x] Adapt the existing AIOP summarizer/model credentials without exposing Pi types to Runtime Core.
- [x] Emit a durable compaction control event containing token counts and summary version, without persisting sensitive source text.
- [x] Verify usage accounting includes compaction model usage and survives resume.
- [x] Run Pi context, AIOP runtime, and full typecheck tests.
- [x] Commit with the required AIOS co-author trailer.

### Task 3: Transactional interaction and ledger completion facts

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-contracts/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/tool-runtime/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-kernel-pi/src/index.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/durable-runtime.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/tool-runtime-platform.test.ts`

- [x] Add failing tests for approval, question, and plan waits that restart with a fresh Runtime instance and create a new Attempt after resolution.
- [x] Add failing crash tests for: before Ledger begin, after external success/before Turn commit, and after Turn commit/before response delivery.
- [x] Represent pending interaction and final Ledger records as neutral `KernelExit` durable facts.
- [x] Keep the pre-side-effect `started` Ledger write synchronous, then include confirmed Ledger/Interaction updates in `turns.commit()` so transcript, usage, events, and final facts share one transaction.
- [x] Prevent any remaining write tool in the same Turn after one call enters waiting.
- [x] Verify completed idempotent calls reuse one result and unknown non-idempotent writes always become `recovery_required`.
- [ ] Commit with the required AIOS co-author trailer.

### Task 4: Tenant/tool/resource concurrency and execution quotas

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/tool-runtime/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/runtime.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/tool-runtime-platform.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/durable-runtime.test.ts`

- [x] Add failing tests for tenant, tool, and resource concurrency ceilings and FIFO release after success, failure, and cancellation.
- [x] Add explicit `ConcurrencyLimits` configuration with bounded semaphores keyed by trusted identity plus tool/resource.
- [x] Count tool calls per Run and fail safely when the configured maximum is reached.
- [x] Ensure locks and permits are always released in `finally` and never derive keys from model-supplied identity fields.
- [ ] Commit with the required AIOS co-author trailer.

### Task 5: Real standalone OpenSandbox and E2B providers

**Files:**
- Replace: `/home/opt/develop/aicoding/aiop/packages/sandbox-opensandbox/src/index.ts`
- Replace: `/home/opt/develop/aicoding/aiop/packages/sandbox-e2b/src/index.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/sandbox-platform-packages.test.ts`

- [x] Add failing SDK-factory tests for acquire, streaming execute, upload, download, timeout, release, tenant metadata, and path safety through each public package root.
- [x] Implement `OpenSandboxProvider` directly with `@alibaba-group/opensandbox`, injected connection settings, safe metadata, and byte file transfer.
- [x] Implement `E2BSandboxProvider` directly with `@e2b/code-interpreter`, injected API/domain/template settings, streamed commands, byte file transfer, and kill-on-release.
- [x] Keep credentials in constructor/factory inputs and never copy them into `SandboxHandle` or Runtime snapshots.
- [ ] Commit with the required AIOS co-author trailer.

### Task 6: Replay/dry-run semantics and rollout evidence

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-aiop/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/memory.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/mysql.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/agent-runtime.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/http-agent-runs.test.ts`

- [x] Add failing tests proving dry-run executes no tools, replay reads a committed transcript without executing model/tools, and neither mode mutates the source Run.
- [x] Persist rollout mode and comparison correlation in the new Run snapshot/event metadata.
- [x] Expose sanitized replay/dry-run outcome and usage comparison in Run Center details.
- [x] Keep `disabled` as an immediate new-Run fallback while preserving existing Kernel binding.
- [ ] Commit with the required AIOS co-author trailer.

### Task 7: Publishable package and public API gates

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/*/package.json`
- Create: `/home/opt/develop/aicoding/aiop/tsconfig.packages.json`
- Create: `/home/opt/develop/aicoding/aiop/scripts/check-public-api.ts`
- Modify: `/home/opt/develop/aicoding/aiop/package.json`
- Modify: `/home/opt/develop/aicoding/aiop/Makefile`
- Test: `/home/opt/develop/aicoding/aiop/tests/agent-platform-packages.test.ts`

- [x] Add failing tests that reject TypeScript-source exports, undeclared cross-package imports, AIOP product types in neutral packages, and Pi deep imports.
- [x] Build declarations and JavaScript for every public package into `dist/`, with package exports pointing to runtime JavaScript and types.
- [x] Add an API snapshot/diff command that fails on unreviewed breaking changes.
- [x] Run `npm pack --dry-run` for every preview package and import each tarball from a temporary non-AIOP project.
- [x] Add these checks to `make test-agent-platform`.
- [ ] Commit with the required AIOS co-author trailer.

### Task 8: Observability, failure injection, and completion evidence

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-contracts/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/docs/pi-agent-platform-operations.md`
- Modify: `/home/opt/develop/aicoding/aiop/docs/design/12-pi-integration-plan.md`
- Create: `/home/opt/develop/aicoding/aiop/docs/pi-agent-platform-completion-evidence.md`
- Test: `/home/opt/develop/aicoding/aiop/tests/pi-observability.test.ts`

- [ ] Add failing tests that every durable event includes tenant/run/attempt/turn/kernel/kernelVersion/correlation identifiers and that sensitive model/tool content is absent from control events.
- [ ] Add structured Runtime observer hooks for Run, Attempt, Turn, lease loss, compaction, tool, waiting, recovery, and SSE replay counters/timers.
- [ ] Execute the complete fault matrix for cancellation, deadline, shutdown, stale fencing, transaction rollback, resume, approval/question/plan, duplicate write, and unknown side effect.
- [ ] Update the design status from “拟实施” only for repository-development stages proven by command output.
- [ ] Record stages 8 and 10 as externally pending until a real checkpoint retention period, backup restore, audit query, and production rollout evidence exist; do not claim or simulate them in code.
- [ ] Run `make verify-node`, `make test-agent-platform`, `npm run typecheck`, `npm test`, `npm --prefix web run build`, `make image`, audit/deep-import checks, package tarball checks, and `git diff --check`.
- [ ] Commit with the required AIOS co-author trailer.
