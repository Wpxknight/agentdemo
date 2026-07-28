# Pi-only Agent Runtime and Run Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Legacy and LangGraph execution/history support while keeping the existing Pi-backed Run Center operations, audit trail, and debugging views.

**Architecture:** The product runtime becomes a single Pi execution path backed by the existing Durable Runtime Store. A forward-only MySQL migration purges non-Pi Run data and removes LangGraph checkpoint tables; API and Web types become Pi-only while the Run Center continues reading Run, Attempt, Turn, Event, Interaction, and Tool Ledger records.

**Tech Stack:** TypeScript, Node.js, Vitest, Kysely/MySQL, React/Vite, Kubernetes.

---

## File map

- Create `/home/opt/develop/aicoding/aiop/src/agent/run-types.ts`: product-facing Run input/result types shared by Pi adapters, HTTP, coordinator, and tests.
- Create `/home/opt/develop/aicoding/aiop/src/agent/compaction.ts`: shared compaction retry constant that is not tied to the deleted Legacy loop.
- Delete `/home/opt/develop/aicoding/aiop/src/agent/core.ts`: Legacy model/tool loop after its shared contracts are extracted.
- Delete `/home/opt/develop/aicoding/aiop/src/agent/legacy-kernel.ts`: Legacy Kernel adapter.
- Modify `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`: single Pi selection, Pi mode validation, Pi-only bindings and durable execution.
- Modify `/home/opt/develop/aicoding/aiop/src/agent/kernel.ts`: import the extracted Run contracts.
- Modify Pi adapters, HTTP, coordinator, cost code, and tests to import `run-types.ts` or `compaction.ts`.
- Create `/home/opt/develop/aicoding/aiop/src/db/migrations/0022_pi_only_runtime.sql`: purge non-Pi Run data, drop LangGraph triggers/tables, and update defaults.
- Modify `/home/opt/develop/aicoding/aiop/src/db/schema.ts`, `/home/opt/develop/aicoding/aiop/src/db/store.ts`, `/home/opt/develop/aicoding/aiop/src/db/mysql.ts`, and `/home/opt/develop/aicoding/aiop/src/db/memory.ts`: remove LangGraph schema and make product Run records Pi-only.
- Modify `/home/opt/develop/aicoding/aiop/packages/agent-runtime-aiop/src/index.ts`: remove historical LangGraph recovery special case.
- Modify `/home/opt/develop/aicoding/aiop/web/src/types.ts`: make Run summaries Pi-only without changing Run Center component behavior.
- Modify `/home/opt/develop/aicoding/aiop/deploy/dev-k8s/aiop-deployment.yaml`: remove Kernel selection configuration.
- Modify current operational/API documentation and generated public API snapshots; leave historical design/spec/plan documents intact unless they incorrectly claim to be current operations.

### Task 1: Lock Pi-only configuration behavior with tests

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/tests/agent-runtime.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/pi-delivery-baseline.test.ts`

- [ ] **Step 1: Replace Legacy selection tests with Pi-only expectations**

Add these focused expectations:

```ts
it('defaults to Pi and rejects retired kernel configuration', () => {
  expect(createConfiguredAgentRuntime({}).kernelName).toBe('pi');
  expect(createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'pi' }).kernelName).toBe('pi');
  expect(() => createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'legacy' }))
    .toThrow('AIOP_AGENT_KERNEL is retired; only pi is supported');
  expect(() => createConfiguredAgentRuntime({ AIOP_AGENT_KERNEL: 'langgraph' }))
    .toThrow('AIOP_AGENT_KERNEL is retired; only pi is supported');
});

it('rejects disabled and unknown Pi modes', () => {
  expect(() => createConfiguredAgentRuntime({ AIOP_PI_MODE: 'disabled' }))
    .toThrow('AIOP_PI_MODE must be one of read-only, dry-run, replay, full');
  expect(() => createConfiguredAgentRuntime({ AIOP_PI_MODE: 'unknown' }))
    .toThrow('AIOP_PI_MODE must be one of read-only, dry-run, replay, full');
});
```

Update delivery assertions so the manifest contains `AIOP_PI_MODE=full` and does not contain `AIOP_AGENT_KERNEL`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run tests/agent-runtime.test.ts tests/pi-delivery-baseline.test.ts
```

Expected: FAIL because the current runtime defaults/falls back to Legacy and the manifest still declares `AIOP_AGENT_KERNEL`.

- [ ] **Step 3: Commit the red tests**

```bash
git add tests/agent-runtime.test.ts tests/pi-delivery-baseline.test.ts
git commit -m "test: define pi-only runtime behavior" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 2: Extract shared contracts and delete the Legacy loop

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/run-types.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/compaction.ts`
- Delete: `/home/opt/develop/aicoding/aiop/src/agent/core.ts`
- Delete: `/home/opt/develop/aicoding/aiop/src/agent/legacy-kernel.ts`
- Delete: `/home/opt/develop/aicoding/aiop/tests/agent.test.ts`
- Delete: `/home/opt/develop/aicoding/aiop/tests/enhance.test.ts`
- Delete: `/home/opt/develop/aicoding/aiop/tests/agent-behavior-v1.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/kernel.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/pi/kernel.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/pi/tool-runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/run-coordinator.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/model/cost.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/server/http.ts`
- Modify tests importing Legacy Run contracts.

- [ ] **Step 1: Move shared Run contracts without behavior changes**

Move the complete `RunAgentOptions` and `RunAgentResult` declarations currently located before `COMPACTION_RETRY_GROWTH_TOKENS` in `core.ts`, together with the `Usage` type re-export, into `run-types.ts`. Do not add, remove, rename, or retype any field. The declarations begin and end as follows, which provides an exact boundary for the move:

```ts
export interface RunAgentOptions {
  runId?: string;
  rolloutMode?: 'read-only' | 'dry-run' | 'replay' | 'full';
  comparisonRunId?: string;
  model: ChatModel;
  tools: ToolRegistry;
  policy: PolicyMiddleware;
  system?: string;
  task?: string;
  taskContentBlocks?: ToolContentBlock[];
  messages?: Msg[];
  ctx: ToolContext;
  onEvent?: (event: StreamEvent) => void;
  drainPendingMessages?: () => Msg[] | Promise<Msg[]>;
  maxSteps?: number;
  contextBudgetTokens?: number;
  keepImages?: number;
  summarize?: (stale: Msg[]) => Promise<string>;
  compactionTriggerTokens?: number;
  compactionKeepRecent?: number;
  compactionWatermarkTokens?: number;
  modelRetryDelayMs?: number;
  approval?: ApprovalGate;
  filterToolDefs?: (defs: ToolDef[]) => ToolDef[];
  hooks?: HookRunner;
  toolLedger?: DurableToolLedger;
  durableInteractions?: {
    create(input: { kind: 'approval' | 'question' | 'plan'; toolCallId: string; payload: unknown }): Promise<{ id: string }>;
    wait(id: string): Promise<unknown>;
  };
  askUser?: (questions: QuestionSpec[]) => Promise<QuestionAnswers | null>;
  requestPlanApproval?: (plan: ChangePlan) => Promise<boolean>;
  unattended?: boolean;
  signal?: AbortSignal;
  runLifecycle?: AgentRunLifecycleObserver;
  runGuard?: () => Promise<void>;
  resumeFromCheckpoint?: boolean;
  interactionResolution?: { interactionId: string; value: JsonValue };
}

export interface RunAgentResult {
  messages: Msg[];
  text: string;
  steps: number;
  usage: Usage;
  compacted: boolean;
  rollout?: {
    mode: 'dry-run' | 'replay';
    sourceRunId?: string;
    sourceUsage?: Usage;
    usageDelta?: Usage;
  };
}
```

Move the HTTP-shared constant into `compaction.ts`:

```ts
export const COMPACTION_RETRY_GROWTH_TOKENS = 4000;
```

Update imports to use these two modules.

- [ ] **Step 2: Run typecheck before deleting the Legacy files**

Run:

```bash
npm run typecheck
```

Expected: PASS, proving the contract move is behavior-neutral.

- [ ] **Step 3: Delete Legacy-only implementation and tests**

Delete `core.ts`, `legacy-kernel.ts`, `agent.test.ts`, `enhance.test.ts`, and `agent-behavior-v1.test.ts`. Confirm no production import references `runAgent` or `LegacyAgentKernel`:

```bash
rg -n "runAgent|LegacyAgentKernel|agent/core" src packages tests --glob '!dist'
```

Expected: no Legacy implementation references; frontend helper functions named `runAgent` are outside this search scope and are unrelated.

- [ ] **Step 4: Run shared service and Pi contract tests**

Run:

```bash
npx vitest run tests/model-gateway.test.ts tests/context-service.test.ts tests/tool-broker.test.ts tests/pi-contract.test.ts tests/pi-aiop-kernel.test.ts
```

Expected: PASS. These exact test files exist in the repository and cover the shared services retained after deleting the Legacy loop.

- [ ] **Step 5: Commit the contract extraction and Legacy deletion**

```bash
git add src/agent src/model/cost.ts src/server/http.ts tests
git commit -m "refactor: remove legacy agent loop" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 3: Simplify the product Runtime to Pi-only

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/kernel.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/agent-runtime.test.ts`

- [ ] **Step 1: Remove built-in Kernel selection and rollout fallback**

Make `AgentRuntime` hold one Kernel and keep injectable test kernels, but remove `kernels`, `selector`, `prepareOptions`, and `BuiltinKernelName`. The core execution decision becomes:

```ts
async run(options: RunAgentOptions): Promise<RunAgentResult> {
  const prepared = preparePiOptions(this.piMode, options);
  if (prepared.rolloutMode === 'replay') return this.replayDurablePi(prepared);
  if (this.runtimeStore && prepared.runId) return this.runDurablePi(prepared);
  if (!prepared.runId || !this.runCoordinator) return this.kernel.run(prepared);
  return this.runCoordinated(prepared);
}
```

Bindings are always written as:

```ts
{
  kernel: 'pi',
  kernelVersion: '0.82.1',
  runtimeVersion: '1',
  graphName: '',
  graphVersion: '',
}
```

Existing bindings with any other Kernel throw `Agent Kernel 不可用`.

- [ ] **Step 2: Validate retired configuration explicitly**

Implement this configuration parsing:

```ts
function assertPiKernelConfiguration(env: NodeJS.ProcessEnv): void {
  const configured = env.AIOP_AGENT_KERNEL?.trim().toLowerCase();
  if (configured && configured !== 'pi') {
    throw new Error('AIOP_AGENT_KERNEL is retired; only pi is supported');
  }
}

function resolvePiMode(value: string | undefined): PiMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'full') return 'full';
  if (normalized === 'read-only' || normalized === 'dry-run' || normalized === 'replay') return normalized;
  throw new Error('AIOP_PI_MODE must be one of read-only, dry-run, replay, full');
}
```

Remove tenant/user/session Kernel rollout selectors. Keep read-only session restrictions only if they still constrain Pi tools without selecting another Kernel.

- [ ] **Step 3: Run Runtime tests**

Run:

```bash
npx vitest run tests/agent-runtime.test.ts tests/pi-delivery-baseline.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit Pi-only Runtime**

```bash
git add src/agent/runtime.ts src/agent/kernel.ts tests/agent-runtime.test.ts tests/pi-delivery-baseline.test.ts
git commit -m "refactor: make agent runtime pi only" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 4: Add the destructive Pi-only database migration

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/db/migrations/0022_pi_only_runtime.sql`
- Modify: `/home/opt/develop/aicoding/aiop/tests/runtime-migrations.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/schema.ts`

- [ ] **Step 1: Write migration contract tests**

Add assertions that migration `0022_pi_only_runtime.sql`:

```ts
expect(source).toContain("kernel <> 'pi'");
expect(source).toContain('drop trigger if exists trg_langgraph_checkpoints_read_only_insert');
expect(source).toContain('drop table if exists langgraph_checkpoint_writes');
expect(source).toContain('drop table if exists langgraph_checkpoints');
expect(source).toContain("default '0.82.1'");
```

Also assert that migration order contains `0022_pi_only_runtime.sql` after `0021_agent_run_event_identity.sql`.

- [ ] **Step 2: Run the migration test and verify failure**

Run:

```bash
npx vitest run tests/runtime-migrations.test.ts
```

Expected: FAIL because migration `0022` does not exist.

- [ ] **Step 3: Implement the forward migration**

Use a temporary table so all dependent rows are deleted before `agent_runs`:

```sql
CREATE TEMPORARY TABLE retired_agent_runs (
  tenant_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(128) NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
);

INSERT INTO retired_agent_runs (tenant_id, run_id)
SELECT tenant_id, run_id FROM agent_runs WHERE kernel <> 'pi';

DELETE target FROM task_agent_runs target
JOIN retired_agent_runs retired USING (tenant_id, run_id);
DELETE target FROM agent_run_events target
JOIN retired_agent_runs retired USING (tenant_id, run_id);
DELETE target FROM agent_tool_executions target
JOIN retired_agent_runs retired USING (tenant_id, run_id);
DELETE target FROM agent_interactions target
JOIN retired_agent_runs retired USING (tenant_id, run_id);
DELETE target FROM agent_turn_commits target
JOIN retired_agent_runs retired USING (tenant_id, run_id);
DELETE target FROM agent_turn_snapshots target
JOIN retired_agent_runs retired USING (tenant_id, run_id);
DELETE target FROM agent_run_attempts target
JOIN retired_agent_runs retired USING (tenant_id, run_id);
DELETE target FROM agent_runs target
JOIN retired_agent_runs retired USING (tenant_id, run_id);

DROP TEMPORARY TABLE retired_agent_runs;

DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_insert;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_update;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_delete;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_insert;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_update;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_delete;
DROP TABLE IF EXISTS langgraph_checkpoint_writes;
DROP TABLE IF EXISTS langgraph_checkpoints;

ALTER TABLE agent_runs
  MODIFY COLUMN kernel VARCHAR(32) NOT NULL DEFAULT 'pi',
  MODIFY COLUMN kernel_version VARCHAR(64) NOT NULL DEFAULT '0.82.1';
```

- [ ] **Step 4: Remove dropped tables from the Kysely schema**

Delete `LangGraphCheckpointsTable`, `LangGraphCheckpointWritesTable`, and their `Database` properties from `schema.ts`.

- [ ] **Step 5: Run migration and type tests**

Run:

```bash
npx vitest run tests/runtime-migrations.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the migration**

```bash
git add src/db/migrations/0022_pi_only_runtime.sql src/db/schema.ts tests/runtime-migrations.test.ts
git commit -m "refactor: purge retired agent runtime data" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 5: Make Store, API, packages, and Web Pi-only

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/src/db/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/mysql.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/memory.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/agent-runtime-aiop/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/web/src/types.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/http-agent-runs.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/agent-run-store.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/agent-run-coordinator.test.ts`
- Modify: generated public API snapshots under `/home/opt/develop/aicoding/aiop/docs/public-api/`.

- [ ] **Step 1: Change product persistence types to Pi-only**

Use:

```ts
export interface AgentRunBinding {
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
  kernel: 'pi';
  kernelVersion?: string;
  runtimeVersion?: string;
  graphName: string;
  graphVersion: string;
  createdAt: Date;
}

export interface AgentRunEvent {
  id?: number;
  tenantId: string;
  runId: string;
  sequence?: number;
  type: string;
  attemptId?: string;
  turnNo?: number;
  kernel?: 'pi';
  kernelVersion?: string;
  correlationId?: string;
  node?: string;
  status?: string;
  detail?: unknown;
  createdAt: Date;
}
```

In MySQL mapping, reject inconsistent rows instead of casting:

```ts
function piKernel(value: string): 'pi' {
  if (value !== 'pi') throw new Error(`Unexpected retired Agent Kernel in database: ${value}`);
  return 'pi';
}
```

Use the helper for Run bindings and only expose event Kernel when it equals `pi`.

- [ ] **Step 2: Remove historical LangGraph recovery behavior**

Delete:

```ts
if (run.kernel === 'langgraph') return '历史 LangGraph Run 仅供查询，不能恢复执行';
```

Keep lease, uncertain tool execution, and pending Interaction recovery checks unchanged.

- [ ] **Step 3: Keep the Run Center response shape while narrowing Web types**

Change:

```ts
kernel: 'pi';
```

in `AgentRunSummary`. Do not modify list/detail rendering or action behavior; it continues showing the Kernel value and consuming `canCancel`, `canResume`, and `recoveryBlockedReason`.

- [ ] **Step 4: Replace historical fixtures with Pi fixtures**

Remove tests that require query-only LangGraph Runs. Preserve coverage that recovery is blocked by an active lease, uncertain tool execution, or pending Interaction.

- [ ] **Step 5: Run Store/API/Web checks**

Run:

```bash
npx vitest run tests/http-agent-runs.test.ts tests/agent-run-store.test.ts tests/agent-run-coordinator.test.ts
npm run typecheck
npm --prefix web run build
npm run check:public-api
```

Expected: the focused tests, typecheck, and Web build pass. After `npm run build:packages`, update intentional declaration changes with `npm run check:public-api -- --update`, inspect `docs/public-api/agent-runtime-aiop.d.ts`, and rerun `npm run check:public-api` successfully.

- [ ] **Step 6: Commit Pi-only product types**

```bash
git add src/db packages/agent-runtime-aiop web/src/types.ts tests docs/public-api
git commit -m "refactor: make run center records pi only" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 6: Remove retired deployment configuration and current documentation

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/deploy/dev-k8s/aiop-deployment.yaml`
- Modify: `/home/opt/develop/aicoding/aiop/README.md`
- Modify: `/home/opt/develop/aicoding/aiop/docs/pi-agent-platform-operations.md`
- Modify: `/home/opt/develop/aicoding/aiop/docs/pi-agent-platform-completion-evidence.md`
- Modify: `/home/opt/develop/aicoding/aiop/docs/guide/code-walkthrough.md` only to keep its existing historical banner accurate; do not rewrite its archived walkthrough body.

- [ ] **Step 1: Remove Kernel selection from the K8s manifest**

Delete:

```yaml
- name: AIOP_AGENT_KERNEL
  value: pi
```

Keep:

```yaml
- name: AIOP_PI_MODE
  value: full
```

- [ ] **Step 2: Update current operational documentation**

Document that AIoP executes only Pi, `AIOP_AGENT_KERNEL` is retired, `AIOP_PI_MODE` supports `read-only`, `dry-run`, `replay`, and `full`, and migration `0022` permanently removes retired data.

Do not rewrite historical design/spec/plan files that intentionally describe the migration history. Add a historical banner only where a current guide would otherwise direct operators to nonexistent code or configuration.

- [ ] **Step 3: Check executable/configuration residue**

Run:

```bash
rg -n "LegacyAgentKernel|AIOP_AGENT_KERNEL|tenant-rule|AIOP_PI_MODE=disabled|@langchain/langgraph" \
  src packages deploy README.md docs/pi-agent-platform-operations.md docs/guide package.json package-lock.json
```

Expected: no executable Legacy/LangGraph dependency or active deployment instruction. Historical documentation references may remain only when explicitly marked historical.

- [ ] **Step 4: Run delivery tests and commit**

Run:

```bash
npx vitest run tests/pi-delivery-baseline.test.ts tests/agent-platform-packages.test.ts
git diff --check
```

Expected: PASS.

```bash
git add deploy/dev-k8s/aiop-deployment.yaml README.md docs tests/pi-delivery-baseline.test.ts
git commit -m "docs: document pi-only agent operations" -m "Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 7: Full verification and local Kubernetes rollout

**Files:**
- Verify all modified files.
- Update plan checkboxes as tasks complete.

- [ ] **Step 1: Run repository verification**

Run:

```bash
make verify-node
npm run typecheck
npm test
npm run verify:packages
npm --prefix web run build
git diff --check
```

Expected: all commands exit 0. Existing documented non-failing Vite chunk-size or moderate dependency warnings may remain, but no test/type/build failure is accepted.

- [ ] **Step 2: Build the application image**

Run the repository image target:

```bash
make image
```

Expected: image build exits 0 and produces the image/tag referenced by the development manifest.

- [ ] **Step 3: Back up retired local data before applying the destructive migration**

Create a dated SQL dump outside the repository using the MySQL deployment's configured credentials. Do not print credentials. Record the absolute backup path in the final handoff.

- [ ] **Step 4: Deploy to local Kubernetes**

Apply the development manifest and wait for rollout:

```bash
kubectl apply -f /home/opt/develop/aicoding/aiop/deploy/dev-k8s/aiop-deployment.yaml
kubectl -n aiop-dev rollout status deployment/aiop-server --timeout=180s
```

Expected: rollout completes successfully.

- [ ] **Step 5: Verify the destructive migration and Pi execution**

Using read-only SQL after rollout, verify:

```sql
SELECT kernel, COUNT(*) FROM agent_runs GROUP BY kernel;
SHOW TABLES LIKE 'langgraph_checkpoint%';
```

Expected: only `pi` Run rows remain and the table query returns no rows. Verify the deployment has `AIOP_PI_MODE=full` and no `AIOP_AGENT_KERNEL` variable.

Trigger or inspect a new local Run and confirm the Run Center list/detail loads its Pi Run, Attempt, Turn, Timeline, and tool records; confirm cancel/resume controls are still derived from the API response.

- [ ] **Step 6: Review and create the final implementation commit if needed**

Run:

```bash
git status --short
git log -6 --format='%h %s%n%b'
```

Ensure every implementation commit contains exactly one `Co-authored-by: AIOS <noreply@bocloud.com>` trailer. Commit any final verification-only source correction with the same trailer; do not create an empty commit.
