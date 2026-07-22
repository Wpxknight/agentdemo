# Agent Run Center and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenant-safe Agent Run Center with durable lifecycle, node timeline, cancellation, checkpoint recovery, and database lease/fencing.

**Architecture:** Extend `agent_runs` as the authoritative lifecycle record, add an append-only event table, and introduce an `AgentRunCoordinator` around LangGraph execution. REST APIs expose the read model and control actions; the React management shell adds a polling Run Center page.

**Tech Stack:** TypeScript, Node.js, LangGraph 1.4, Kysely, MySQL 8.4, React 19, Vite, Vitest, Kubernetes.

---

### Task 1: Run lifecycle schema and Store contract

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/db/migrations/0014_agent_run_center.sql`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/schema.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/memory.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/mysql.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/agent-run-store.test.ts`

- [ ] **Step 1: Write failing Store tests**

Cover creation defaults, status transitions, filtered pagination, event ordering, role/user scoping, tool/interactions detail aggregation inputs, lease acquisition, lease renewal, expired takeover, stale-token fencing, durable cancellation, and terminal lease clearing.

```ts
const lease = await store.acquireAgentRunLease(ctx, runId, 'owner-a', now, 30_000);
expect(lease?.token).toBe(1);
expect(await store.acquireAgentRunLease(ctx, runId, 'owner-b', now, 30_000)).toBeUndefined();
await expect(store.assertAgentRunLease(ctx.tenantId, runId, 'owner-a', lease!.token)).resolves.toBeUndefined();
```

- [ ] **Step 2: Run the failing tests**

Run: `npm test -- tests/agent-run-store.test.ts`

Expected: FAIL because lifecycle and lease Store methods do not exist.

- [ ] **Step 3: Add migration and types**

Add lifecycle/usage/lease columns to `agent_runs`, create `agent_run_events`, and define:

```ts
export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required';
export interface AgentRunRecord extends AgentRunBinding { status: AgentRunStatus; currentNode?: string; /* timestamps, usage, lease */ }
export interface AgentRunEvent { id?: number; tenantId: string; runId: string; type: string; node?: string; status?: string; detail?: unknown; createdAt: Date }
```

- [ ] **Step 4: Implement MemoryStore and MysqlStore**

Use tenant-scoped queries and compare-and-set updates. Lease acquisition increments `lease_token`; fencing requires exact owner/token and unexpired lease.

- [ ] **Step 5: Verify Store tests and database suite**

Run: `npm test -- tests/agent-run-store.test.ts tests/db.test.ts`

Expected: PASS.

### Task 2: AgentRunCoordinator and fencing guard

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/run-coordinator.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/core.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/runtime.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/agent-run-coordinator.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

Test lifecycle transitions, heartbeat, cancellation, competing owner rejection, expired lease takeover, stale owner fencing, failure redaction, and recovery-required classification.

```ts
const execution = await coordinator.start(ctx, runId);
await execution.guard();
await execution.nodeStarted('model');
await execution.nodeCompleted('model', { steps: 1 });
await execution.succeed({ steps: 1, usage: zeroUsage });
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -- tests/agent-run-coordinator.test.ts`

Expected: FAIL because `AgentRunCoordinator` is absent.

- [ ] **Step 3: Implement coordinator**

Create a process owner ID, acquire lease, renew at one-third TTL, expose `guard()`, append timeline events, update lifecycle, and stop heartbeat on terminal state.

- [ ] **Step 4: Integrate AgentRuntime**

`AgentRuntime.run()` wraps the selected kernel with coordinator execution when `runId` is present. Add a lifecycle observer and fencing guard to `RunAgentOptions` without changing public SSE events.

- [ ] **Step 5: Verify coordinator and runtime tests**

Run: `npm test -- tests/agent-run-coordinator.test.ts tests/agent-runtime.test.ts`

Expected: PASS.

### Task 3: LangGraph node timeline and checkpoint recovery

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/langgraph/graph.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/langgraph/kernel.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/services/model-gateway.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/services/tool-broker.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/langgraph-run-recovery.test.ts`

- [ ] **Step 1: Write failing graph recovery tests**

Test ordered `prepare/model/tools` events, guard checks before model/tool work, waiting transitions around interrupts, failure persistence, and recovery with `graph.invoke(null, config)` using the same run ID.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -- tests/langgraph-run-recovery.test.ts`

Expected: FAIL because node observation and resume mode are absent.

- [ ] **Step 3: Instrument graph nodes**

Wrap every node with start/success/failure observation and call the fencing guard immediately before external model or tool side effects.

- [ ] **Step 4: Add resume mode**

Add `resumeFromCheckpoint?: boolean` to run options. `LangGraphAgentKernel` uses `null` initial input only for a validated recovery call; normal and interaction resume paths retain current semantics.

- [ ] **Step 5: Verify graph and parity tests**

Run: `npm test -- tests/langgraph-run-recovery.test.ts tests/agent-kernel-parity.test.ts tests/mysql-checkpointer.test.ts`

Expected: PASS, including 716 checkpointer validation cases.

### Task 4: Run Center service and REST APIs

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/run-center.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/server/http.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/runtime.ts`
- Test: `/home/opt/develop/aicoding/aiop/tests/http-agent-runs.test.ts`

- [ ] **Step 1: Write failing API tests**

Cover list/detail pagination, user/admin authorization, filter validation, not-found behavior, cancel compare-and-set, active local abort, resume state validation, lease conflicts, unsafe tool ledger rejection, and accepted background recovery.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -- tests/http-agent-runs.test.ts`

Expected: FAIL with missing routes.

- [ ] **Step 3: Implement RunCenterService**

Keep authorization, cancellation, recovery validation, and background recovery orchestration outside the large HTTP route function. Reuse the same runtime model, tools, policy, hooks, session committer, interactions, and tool ledger as normal HTTP execution.

- [ ] **Step 4: Add endpoints**

Implement:

```text
GET  /v1/agent/runs
GET  /v1/agent/runs/:runId
POST /v1/agent/runs/:runId/cancel
POST /v1/agent/runs/:runId/resume
```

- [ ] **Step 5: Verify API tests and existing HTTP behavior**

Run: `npm test -- tests/http-agent-runs.test.ts tests/http.test.ts`

Expected: PASS.

### Task 5: React Run Center page

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/web/src/types.ts`
- Modify: `/home/opt/develop/aicoding/aiop/web/src/App.tsx`
- Modify: `/home/opt/develop/aicoding/aiop/web/src/index.css`
- Test: `/home/opt/develop/aicoding/aiop/tests/web-run-center-source.test.ts`

- [ ] **Step 1: Write failing source/UI contract tests**

Assert the `runs` navigation item, API routes, filters, table columns, timeline, tool/interactions tabs, cancel/resume controls, polling, and accessible labels.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -- tests/web-run-center-source.test.ts`

Expected: FAIL because the page does not exist.

- [ ] **Step 3: Add types and navigation**

Add `runs` to `PageId`, `NavItem`, icon mapping, metadata, and page loading.

- [ ] **Step 4: Implement RunCenterPage**

Use existing Card/Table/Tabs/Badge/Button components. Poll every five seconds only while non-terminal runs are visible or a recovery action is pending.

- [ ] **Step 5: Build frontend and run UI contract tests**

Run: `npm test -- tests/web-run-center-source.test.ts && npm --prefix web run build`

Expected: PASS.

### Task 6: Full verification, review, and K8s delivery

**Files:**
- Modify if needed: `/home/opt/develop/aicoding/aiop/docs/DESIGN-langgraph-aiop-integration.md`
- Use: `/home/opt/develop/aicoding/aiop/deploy/dev-k8s/aiop-deployment.yaml`

- [ ] **Step 1: Run complete verification**

Run:

```bash
npm run typecheck
npm test
npm --prefix web run build
docker build -t aiop:dev .
docker build -f web/Dockerfile -t aiop-web:dev .
```

Expected: all commands exit zero.

- [ ] **Step 2: Review migration and security boundaries**

Confirm tenant filters, redaction, CAS transitions, lease fencing, cancellation, and no raw checkpoint/tool secrets in API responses.

- [ ] **Step 3: Deploy to K8s**

Apply `/home/opt/develop/aicoding/aiop/deploy/dev-k8s/aiop-deployment.yaml`, restart `aiop-server`, and wait for rollout.

- [ ] **Step 4: Perform end-to-end smoke validation**

Create a real LangGraph run, confirm it appears in Run Center, inspect timeline, verify health/readiness, and test a safe cancellation or recoverable failure scenario.

- [ ] **Step 5: Commit implementation**

Stage only feature-related files and use the required trailer:

```text
Co-authored-by: AIOS <noreply@bocloud.com>
```
