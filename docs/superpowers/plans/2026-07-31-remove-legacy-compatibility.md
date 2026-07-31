# Remove Legacy Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every migration-era compatibility path and leave a strict, Pi-only new-project codebase that deploys from a single database baseline.

**Architecture:** `DurableRunRuntime` remains the only execution contract, current tool/profile/skill/message shapes are authoritative, and storage is created from one baseline schema. Source-level contract tests and TypeScript unused-code checks prevent the removed compatibility surfaces from returning.

**Tech Stack:** TypeScript 6, Node.js 22, Vitest, React/Vite, MySQL 8.4, Docker, Kubernetes.

---

### Task 1: Add cleanup contract tests

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/tests/integration/runtime-assembly.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/contracts/control-contracts.test.ts`
- Create: `/home/opt/develop/aicoding/aiop/tests/contracts/no-legacy-compatibility.test.ts`

- [ ] **Step 1: Write failing source contract tests**

Add assertions that production source and public package indexes do not expose `AgentRuntime`, `AgentKernel`, `AgentRunCoordinator`, `LegacyToolHandler`, `summaryBudget`, `nameLockTimeoutMs`, `CompatibleAgentMessage`, legacy seed migration markers, or legacy sandbox profile fallback functions.

```ts
it('does not expose migration-era compatibility surfaces', async () => {
  const sources = await readProductionSources();
  for (const forbidden of [
    'interface AgentRuntime', 'interface AgentKernel', 'class AgentRunCoordinator',
    'LegacyToolHandler', 'summaryBudget', 'nameLockTimeoutMs',
    'CompatibleAgentMessage', 'legacy-seed-governance-v1', 'legacyProfile(',
  ]) expect(sources).not.toContain(forbidden);
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `npx vitest run tests/contracts/no-legacy-compatibility.test.ts tests/contracts/control-contracts.test.ts tests/integration/runtime-assembly.test.ts`

Expected: FAIL on the current compatibility declarations and migration markers.

- [ ] **Step 3: Keep the failing tests for subsequent tasks**

Do not weaken the forbidden-name assertions. Later tasks make them pass by deleting the production surfaces.

### Task 2: Remove the old Agent and tool contracts

**Files:**
- Delete: `/home/opt/develop/aicoding/aiop/src/agent/kernel.ts`
- Delete: `/home/opt/develop/aicoding/aiop/src/agent/run-coordinator.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/run-types.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/tools/governance.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/llm/cost.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/tools.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/server/http.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/control-contracts/src/run.ts`
- Delete or rewrite: `/home/opt/develop/aicoding/aiop/tests/agent-run-coordinator.test.ts`
- Modify: tool tests under `/home/opt/develop/aicoding/aiop/tests`

- [ ] **Step 1: Introduce the narrow governed tool options type**

Replace `RunAgentOptions` use in governance with a local type containing only consumed fields.

```ts
export interface AIOPToolRuntimeOptions {
  tools: ToolRegistry;
  governedTools?: readonly GovernedToolDefinition[];
  policy: PolicyMiddleware;
  ctx: ToolContext;
  onEvent?: (event: StreamEvent) => void;
  approval?: ApprovalGate;
  filterToolDefs?: (definitions: ToolDef[]) => ToolDef[];
  durableInteractions?: { wait(id: string): Promise<unknown> };
  askUser?: ToolContext['askUser'];
  requestPlanApproval?: ToolContext['requestPlanApproval'];
  runGuard?: () => Promise<void>;
}
```

- [ ] **Step 2: Replace the legacy tool shape**

Make `ToolHandler` expose only `name`, `description`, `inputSchema`, `capability`, and `execute`. Update registry lookup and tests to use these fields.

```ts
export interface ToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: ToolCapability;
  execute(args: JsonValue, ctx: ToolContext): Promise<ToolResult>;
}
```

- [ ] **Step 3: Delete old Agent modules and aliases**

Remove `AgentRuntime`, `AgentKernel`, `AgentRunCoordinator`, old lifecycle types, compatibility-only run result fields, and their tests. Import `AgentRunUsage` directly in the cost module.

- [ ] **Step 4: Remove dead HTTP helpers left by the old loop**

Delete unused Goal Mode, summary model, old compaction threshold, abort-reason, payload wrapper helpers, imports, and unused recovery parameters. Preserve current durable SSE, append, cancel, and interaction replay behavior.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run tests/contracts/no-legacy-compatibility.test.ts tests/contracts/control-contracts.test.ts tests/integration/runtime-assembly.test.ts tests/http.test.ts tests/pi-runtime/tool-sources.test.ts`

Expected: PASS.

### Task 3: Remove Skill and Sandbox upgrade compatibility

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/src/skill/registry.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/config/schema.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/config.example.jsonc`
- Modify: `/home/opt/develop/aicoding/aiop/packages/sandbox-runtime/src/profiles.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/sandbox-runtime/src/settings.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/skill.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/sandbox-settings.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/sandbox-runtime/aios-features.test.ts`

- [ ] **Step 1: Delete deprecated Skill options**

Remove `summaryBudget` and `nameLockTimeoutMs` from config, runtime assembly, examples, and registry options.

- [ ] **Step 2: Delete legacy seed and tombstone migration**

Remove migration IDs, locks, candidate discovery, cached migration state, marker persistence, legacy digest hooks, and tests that construct old seed copies or tombstones. Keep current built-in catalog, governance overlays, publication journals, and current tombstones used by current deletion semantics.

- [ ] **Step 3: Require current Sandbox profiles**

Make `id`, `envType`, and `runtimeRole` required; remove the legacy default-profile conversion and old dual-purpose desktop fallback. Update fixtures to current profiles.

- [ ] **Step 4: Remove startup bootstrap compatibility**

Delete logic that converts old startup Sandbox/AIOS configuration into persisted settings. Keep the current settings API and encrypted key persistence.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/skill.test.ts tests/sandbox-settings.test.ts tests/sandbox-runtime/aios-features.test.ts tests/runtime.test.ts`

Expected: PASS with only current layouts represented.

### Task 4: Remove Pi message compatibility exports

**Files:**
- Delete: `/home/opt/develop/aicoding/aiop/packages/pi-runtime/src/pi/compatibility.ts`
- Delete: `/home/opt/develop/aicoding/aiop/packages/pi-runtime/src/pi/message-codec.ts`
- Modify: `/home/opt/develop/aicoding/aiop/packages/pi-runtime/src/index.ts`
- Delete: `/home/opt/develop/aicoding/aiop/tests/pi-runtime/message-codec.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/contracts/pi-capabilities.test.ts`

- [ ] **Step 1: Remove compatibility exports and codec tests**

Delete the types/codecs and remove their package-root exports.

- [ ] **Step 2: Verify package consumers use native Pi messages**

Run: `rg -n "CompatibleAgentMessage|CompatibleContentBlock|PiContentExtension|MessageCodec" src packages tests --glob '!**/bin/**'`

Expected: no matches.

- [ ] **Step 3: Build package declarations**

Run: `npm run build:packages`

Expected: PASS.

### Task 5: Replace migrations with one current baseline

**Files:**
- Delete: `/home/opt/develop/aicoding/aiop/src/db/migrations/0001_init.sql` through `/home/opt/develop/aicoding/aiop/src/db/migrations/0026_scheduler_run_compat.sql`
- Create: `/home/opt/develop/aicoding/aiop/src/db/migrations/0001_baseline.sql`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/mysql.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/runtime-migrations.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/db.test.ts`

- [ ] **Step 1: Create a disposable MySQL schema from all current migrations**

Apply the existing migration chain to an empty database, inspect the final tables/indexes/constraints, and dump schema-only SQL without migration history data.

- [ ] **Step 2: Normalize the schema into `0001_baseline.sql`**

Remove LangGraph tables, compatibility-only defaults, transitional `ALTER` operations, and upgrade guards. Keep only tables and indexes used by current stores.

- [ ] **Step 3: Update migration tests for the baseline**

Assert that one migration creates the current Pi sessions, runs, attempts, turns, inbox, interactions, tool ledger, scheduler, auth, settings, and skill-related tables and contains no `legacy`, `langgraph`, or `compat-v1` tokens.

- [ ] **Step 4: Run database and migration tests**

Run: `npx vitest run tests/runtime-migrations.test.ts tests/db.test.ts tests/mysql-runtime-store.test.ts tests/scheduler-runtime/scheduler-runtime.test.ts`

Expected: PASS.

### Task 6: Enable unused-code enforcement and regenerate API snapshots

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/tsconfig.json`
- Modify: `/home/opt/develop/aicoding/aiop/tsconfig.packages.json`
- Modify: `/home/opt/develop/aicoding/aiop/web/tsconfig.app.json`
- Modify: production files reported by TypeScript
- Modify: `/home/opt/develop/aicoding/aiop/docs/public-api/*.d.ts`
- Modify: active architecture and deployment documentation containing current compatibility instructions

- [ ] **Step 1: Enable strict unused checks**

```json
{
  "compilerOptions": {
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

- [ ] **Step 2: Run type checking and remove every production finding**

Run: `npm run typecheck`

Expected: initially FAIL on unused imports/variables; remove them without disabling checks.

- [ ] **Step 3: Build packages and update reviewed API snapshots**

Run: `npm run build:packages && npm run check:public-api -- --update && npm run check:public-api`

Expected: PASS.

- [ ] **Step 4: Update active docs**

Remove bootstrap compatibility instructions and describe fresh database initialization and current Sandbox settings only. Historical dated specs/plans remain unchanged.

### Task 7: Verify, review, commit, and deploy

**Files:**
- Review all changed files
- Update: `/home/opt/develop/aicoding/aiop/deploy/dev-k8s/README.md` when deployment steps change

- [ ] **Step 1: Run the full verification suite**

Run: `npm run test:runtime-refactor && npm --prefix web run build && git diff --check`

Expected: all package checks, TypeScript checks, Vitest files, tarball checks, Web TypeScript, and Vite build pass with zero failures.

- [ ] **Step 2: Request code review and address findings**

Review the diff against `/home/opt/develop/aicoding/aiop/docs/superpowers/specs/2026-07-31-remove-legacy-compatibility-design.md`. Fix all critical and important findings, then rerun Step 1.

- [ ] **Step 3: Commit implementation**

Use a commit message ending with:

```text
Co-authored-by: AIOS <noreply@bocloud.com>
```

- [ ] **Step 4: Build deployment images**

Run: `make image IMAGE=aiop:$(git rev-parse --short HEAD) WEB_IMAGE=aiop-web:$(git rev-parse --short HEAD)`

Expected: both images build and package import/Node verification succeeds.

- [ ] **Step 5: Recreate the new-project database and deploy**

Delete only the explicitly scoped `aiop-dev` MySQL PVC/database resources required for a fresh baseline, recreate them from `/home/opt/develop/aicoding/aiop/deploy/dev-k8s/mysql.yaml`, then run `make deploy-staging` with the built image tags.

- [ ] **Step 6: Verify Kubernetes readiness and HTTP health**

Run:

```sh
kubectl -n aiop-dev rollout status deployment/mysql --timeout=180s
kubectl -n aiop-dev rollout status deployment/dex --timeout=180s
kubectl -n aiop-dev rollout status deployment/aiop-server --timeout=180s
kubectl -n aiop-dev get pods -o wide
curl -fsS http://192.168.10.108:30083/healthz
curl -fsS http://192.168.10.108:30083/readyz
```

Expected: all rollouts succeed, pods are Ready, and both endpoints return `{"ok":true}`.
