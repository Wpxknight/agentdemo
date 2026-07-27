# Durable Pi Tool and Interaction Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AIOP Durable Pi product path use the public Tool Runtime and resume approval/question/plan interactions in a fresh Attempt after HTTP resolution.

**Architecture:** Extend neutral contracts so Runtime can pass a Store-validated interaction resolution to Kernel and Tool Runtime. Add a focused AIOP Tool Runtime adapter backed by the same Runtime Store repositories used by Turn commits, share model/tool concurrency controllers at the long-lived AIOP Runtime, and trigger asynchronous recovery immediately after product HTTP resolve.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Pi 0.82.1, Kysely/MySQL, AIOP Runtime Store and HTTP/SSE.

---

### Task 1: Trusted interaction resolution contract and Runtime resume

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-contracts/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/runtime.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/durable-runtime.test.ts`

- [x] Add a failing test where a waiting interaction has `toolCallId`, `userId`, `sessionId`, and `expiresAt`, `resume()` receives a resolution, and the fresh Kernel receives the resolved interaction in `KernelRunInput.interactionResolution`.
- [x] Add a failing test where the Interaction was already resolved by the product Store; matching resolution resumes, conflicting resolution fails with `RUN_STATE_CONFLICT`, and the original TurnCommit remains unchanged.
- [x] Extend `DurableInteractionUpdate`, `KernelRunInput`, and `ToolExecutionContext` with the exact trusted fields from the spec; add `InteractionRepository.list(run)`.
- [x] Pass `record.sessionId` and the validated resolution through `startHandle()` and `execute()` into every Kernel invocation of the new Attempt.
- [x] Run `npx vitest run tests/durable-runtime.test.ts tests/memory-runtime-store.test.ts` and confirm the new tests pass.
- [x] Commit with the required AIOS co-author trailer.

### Task 2: Complete Memory/MySQL Interaction repositories

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/memory-store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-mysql/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/memory.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/mysql.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/memory-runtime-store.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/mysql-runtime-store.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/durable-interaction.test.ts`

- [x] Add failing contract tests proving every Interaction field round-trips and `list()` is tenant/run scoped and creation ordered.
- [x] Add a failing product Memory Store test proving `putInteraction` and `agentRuntimeStore().interactions.get/list` observe the same record and transaction rollback does not expose a pending Interaction.
- [x] Persist/map `user_id`, `session_id`, `tool_call_id`, `expires_at`, and `resolved_by` in the MySQL Runtime Adapter.
- [x] Replace the product Memory Store's separate Interaction map with delegation to the shared Memory Runtime repository while preserving product authorization behavior.
- [x] Run the three targeted Store/Interaction test files and typecheck.
- [x] Commit with the required AIOS co-author trailer.

### Task 3: Shared Tool Runtime concurrency and durable interaction tools

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/tool-runtime/src/index.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/tool-runtime-platform.test.ts`

- [ ] Add a failing test proving two fresh `ToolRuntimeEngine` instances sharing one controller enforce tenant/tool/resource FIFO ceilings.
- [ ] Add failing tests proving `interactionKind: question|plan` returns a pending durable Interaction without executing the handler, then returns a deterministic ToolResult when given the matching trusted resolution.
- [ ] Add failing tests proving approval=true resumes the same logical call with the same idempotency key, approval=false never executes it, and both finalize the pending Ledger fact safely.
- [ ] Export `ToolConcurrencyController`; allow `ToolRuntimeEngineOptions` to inject it while retaining bounded defaults.
- [ ] Add interaction metadata to `RegisteredTool` and implement initial waiting/resolved execution paths without weakening Policy → Approval → Hook → Ledger → Lock → Execute → Audit ordering.
- [ ] Run `npx vitest run tests/tool-runtime-platform.test.ts` and typecheck.
- [ ] Commit with the required AIOS co-author trailer.

### Task 4: Pi Kernel resume execution

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-kernel-pi/src/index.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/pi-contract.test.ts`

- [ ] Add a failing test where a first Kernel returns `waiting`, a fresh Kernel receives an approval resolution, re-executes the original call before the model stream, replaces `waiting:<id>`, and commits the real ToolResult.
- [ ] Add failing question/plan tests proving the model receives the resolved value and the tool handler is not executed.
- [ ] Locate the original assistant ToolCall by trusted `toolCallId`; reject missing or mismatched calls as `RUN_STATE_CONFLICT` rather than asking the model to recreate the write.
- [ ] Merge ledger/interaction updates produced during resolution execution into the same `KernelExit` facts used by Turn commit.
- [ ] Run Pi contract and Durable Runtime tests.
- [ ] Commit with the required AIOS co-author trailer.

### Task 5: AIOP public Tool Runtime adapter

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/pi/tool-runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/pi/kernel.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/core.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/agent-runtime.test.ts`

- [ ] Add a failing product-path test proving a policy-gated write creates pending Interaction/Ledger facts in the Runtime Store and does not call the product handler.
- [ ] Add a failing fresh-Runtime resume test proving approval executes the original `ToolRegistry` handler once with a stable idempotency key and cumulative usage/transcript survives.
- [ ] Adapt product Tool definitions, Policy decisions, Hook decisions, ToolContext output events, question/plan payloads, and Runtime Store Ledger into `ToolRuntimeEngine`.
- [ ] Keep old `executeToolCall` only for Legacy/non-durable compatibility; Durable Pi must receive the new adapter explicitly.
- [ ] Hold one shared `ToolConcurrencyController` on `AgentRuntime`; parse positive integer tenant/tool/resource limits from `AIOP_PI_MAX_CONCURRENT_TOOLS_PER_TENANT`, `AIOP_PI_MAX_CONCURRENT_TOOLS_PER_TOOL`, and `AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE`.
- [ ] Run Agent Runtime, Tool Runtime, Pi contract, and typecheck tests.
- [ ] Commit with the required AIOS co-author trailer.

### Task 6: HTTP resolve automatically starts a fresh Attempt

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-aiop/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/server/http.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/http-agent-runs.test.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/http.test.ts`

- [ ] Add failing HTTP tests proving approve/deny/question/plan resolve invokes recovery with `{interactionId,value}`, returns after scheduling, and a new Attempt is created without a separate `/resume` call.
- [ ] Add failing tests for duplicate matching resolve, conflicting resolve, cross-user/cross-tenant access, expired Interaction, and session-busy recovery protection.
- [ ] Extend recovery orchestration and `RunAgentOptions` to carry the resolution into `DurableAgentRuntime.resume()`.
- [ ] Keep explicit Run Center resume for failed/recovery-required Runs; reject bypass of a pending Interaction without resolution.
- [ ] Record recovery requested/failed events without persisting sensitive answer content in control-event detail.
- [ ] Run both HTTP test files plus the fault matrix.
- [ ] Commit with the required AIOS co-author trailer.

### Task 7: Remaining design limit audit and delivery evidence

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-contracts/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-core/src/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-mysql/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/docs/pi-agent-platform-completion-evidence.md`
- Modify: `/home/opt/develop/aicoding/aiop/docs/pi-agent-platform-operations.md`
- Modify: `/home/opt/develop/aicoding/aiop/docs/design/12-pi-integration-plan.md`
- Test: `/home/opt/develop/aicoding/aiop/tests/durable-runtime.test.ts`

- [ ] Add a failing `maxAttempts` test proving the second cross-process resume is rejected after the persisted Attempt budget is exhausted.
- [ ] Add `RunLimits.maxAttempts`, persist it in the existing `limits_json`, and enforce it before acquiring a new Attempt; do not create production-only evidence or checkpoint cleanup migrations.
- [ ] Re-run BR-01～BR-07, interfaces, migrations, non-functional requirements, stage acceptance conditions, and minimum-test-coverage evidence matrix.
- [ ] Update public API snapshots only after reviewing every changed declaration.
- [ ] Run `make verify-node`, `make test-agent-platform`, `npm run typecheck`, `npm test`, `npm --prefix web run build`, `npm audit --audit-level=high`, `npm run verify:packages`, `make image`, and `git diff --check`.
- [ ] Update evidence with fresh file/test counts and keep stages 7 production metrics, 8 retention window, and 10 backup/audit/drop work explicitly external.
- [ ] Commit with the required AIOS co-author trailer and confirm the worktree is clean.
