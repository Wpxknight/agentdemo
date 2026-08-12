# Local Review Fixes and Staging Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the seven verified regressions in the current working tree, verify the complete application, and deploy staging through one Make command while preserving settings exactly.

**Architecture:** Apply small, isolated fixes to frontend contracts, scheduler lifecycle handling, and deployment scripts. The staging workflow creates a protected run directory under `dist`, backs up only required records from the database named exactly `aiop`, rebuilds only that schema, restores and verifies settings, preserves full Kubernetes ConfigMap/Secret data, then deploys workload images and runs smoke checks.

**Tech Stack:** TypeScript 6, Vitest 4, React/Vite, Kysely/MySQL/MariaDB 10.2, Bash, GNU Make, kubectl, Docker, SSH.

## Global Constraints

- Database operations are strictly limited to the database named exactly `aiop`.
- Never enumerate, read, modify, dump, create, drop, or rebuild any other database on the MariaDB instance.
- Validate the selected database name before every destructive or write phase and fail closed unless it equals `aiop`.
- Do not use `DROP DATABASE`; rebuild only tables inside `aiop`.
- Do not expose database credentials, model keys, Sandbox keys, Secret data, or encrypted envelopes in source, command arguments, logs, reports, or tests.
- Store temporary files, browser evidence, backups, and test artifacts under `dist`; use `0700` directories, `0600` sensitive files, and `umask 077`.
- Preserve the existing user changes in the dirty working tree; make minimal incremental edits and never replace files from `HEAD`.
- Keep MariaDB 10.2 compatibility; do not introduce `SKIP LOCKED`.
- Image builds and staging deployment remain Make targets.
- Do not commit unless the user explicitly requests it.

---

## File Responsibility Map

- `packages/scheduler-runtime/src/mysql.ts`: materialize and claim persisted scheduler Fires without coupling an existing Fire to current task deletion state.
- `packages/scheduler-runtime/src/runner.ts`: enforce shared batch capacity and fairly defer active/waiting bound Fires.
- `tests/scheduler-runtime/scheduler-runtime.test.ts`: executable Scheduler lifecycle and fairness regressions.
- `web/src/types.ts`: frontend response type for Skill import.
- `web/src/App.tsx`: Skill import success handling and schedule timezone display.
- `tests/frontend.test.ts`: source-level frontend contract regression checks.
- `scripts/backup-aiop-k8s-settings.sh`: protected backup of complete Kubernetes ConfigMap/Secret `.data`.
- `scripts/backup-aiop-staging-db-settings.sh`: protected export and summary for the exact required settings from `aiop` only.
- `scripts/rebuild-aiop-staging-db.sh`: verify backup, clear tables in `aiop`, import baseline, restore settings, and verify exact hashes.
- `scripts/deploy-aiop-staging-fresh.sh`: orchestrate backup, pipeline, `aiop` rebuild, workload-only deploy, configuration comparison, rollout, and smoke.
- `scripts/test-aiop-staging-deploy-contract.sh`: offline static/fixture contract tests proving the scripts fail closed and do not target another database.
- `Makefile`: expose stable backup/rebuild/workload-only/fresh targets and pass one run-specific `dist` directory through all phases.
- `.gitignore`, `.dockerignore`: prevent fallback `.playwright-mcp/` output from entering Git or image contexts.
- `.test-scripts/release-health/chat_skills_auth_smoke.sh`: keep smoke temporary files under `dist/test-tmp`.
- `docs/design/10-deployment-observability.md`, `README.md`: describe the safe fresh staging command and strict `aiop` database scope if current text is incomplete.

---

### Task 1: Fix Skill Import and Timezone Frontend Contracts

**Files:**
- Modify: `web/src/types.ts:403-405`
- Modify: `web/src/App.tsx:3312-3329`
- Modify: `web/src/App.tsx:4116-4148`
- Test: `tests/frontend.test.ts`

**Interfaces:**
- Consumes: backend `POST /v1/skills/import` response `{ product: ToolSummary; pendingReview: boolean }`.
- Produces: `SkillsImportBody` with `product` and `pendingReview`; pending-review success message; schedule detail timezone from `selectedTask.timezone`.

- [ ] **Step 1: Add failing frontend source-contract tests**

Append tests that read `web/src/types.ts` and `web/src/App.tsx` and assert the exact intended contract:

```ts
it('uses the backend product contract for pending skill imports', async () => {
  const types = await readFile('web/src/types.ts', 'utf8');
  const app = await readFile('web/src/App.tsx', 'utf8');

  expect(types).toMatch(/interface SkillsImportBody\s*{[\s\S]*product: ToolSummary;[\s\S]*pendingReview: boolean;/);
  expect(types).not.toContain('skill: ToolSummary;');
  expect(app).toContain('body.product.name');
  expect(app).toContain('等待管理员审核');
  expect(app).not.toContain('setSelectedName(body.product.name)');
});

it('shows the persisted timezone in the schedule detail summary', async () => {
  const app = await readFile('web/src/App.tsx', 'utf8');

  expect(app).toContain("{selectedTask.timezone || 'UTC'}");
  expect(app).not.toContain('{humanizeCron(selectedTask.cron)}，UTC）');
});
```

- [ ] **Step 2: Run the focused frontend tests and confirm failure**

Run:

```bash
npx vitest run tests/frontend.test.ts
```

Expected: FAIL because `SkillsImportBody` still declares `skill`, the handler dereferences `body.skill`, and the detail row hard-codes UTC.

- [ ] **Step 3: Implement the minimal frontend fixes**

Change the response type to:

```ts
export interface SkillsImportBody {
  product: ToolSummary;
  pendingReview: boolean;
}
```

Change the success branch to refresh the list without selecting a pending product:

```ts
await onImported();
setSelectedFile('SKILL.md');
setShowSkillFiles(false);
setImportStatus(
  body.pendingReview
    ? `已上传 ${toolDisplayName(body.product.name)}，等待管理员审核。`
    : `已导入 ${toolDisplayName(body.product.name)}。`,
);
```

Do not call `setSelectedName(body.product.name)` because pending products are absent from `/v1/tools`.

Change the summary row to:

```tsx
<span>执行计划</span><strong>{selectedTask.cron}（{humanizeCron(selectedTask.cron)}，{selectedTask.timezone || 'UTC'}）</strong>
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/frontend.test.ts tests/http.test.ts
```

Expected: PASS, including the existing backend `{ product, pendingReview }` assertion.

- [ ] **Step 5: Review the diff without committing**

Run:

```bash
git diff -- web/src/types.ts web/src/App.tsx tests/frontend.test.ts
```

Expected: only the contract, message, selection, timezone, and tests changed.

---

### Task 2: Keep Materialized Fires Claimable After Task Deletion

**Files:**
- Modify: `packages/scheduler-runtime/src/mysql.ts:77-86`
- Test: `tests/scheduler-runtime/scheduler-runtime.test.ts`

**Interfaces:**
- Consumes: immutable execution snapshot already stored in `scheduler_fires`.
- Produces: `MysqlSchedulerStore.claimDue()` that filters task deletion only during future Cron materialization, not pending Fire claim.

- [ ] **Step 1: Add a failing MySQL query contract test**

Add a test near the existing MariaDB query-source assertions:

```ts
it('claims materialized pending fires without filtering the current task deletion state', async () => {
  const mysqlSource = await readFile('packages/scheduler-runtime/src/mysql.ts', 'utf8');
  const claimSection = mysqlSource.slice(
    mysqlSource.indexOf("const rows = await tx.selectFrom('scheduler_fires')"),
    mysqlSource.indexOf('const claimed: ClaimedScheduledFire[]'),
  );

  expect(claimSection).not.toContain("innerJoin('scheduled_tasks'");
  expect(claimSection).not.toContain('scheduled_tasks.deleted_at');
  expect(claimSection).toContain("where('state', '=', 'pending')");
  expect(mysqlSource).not.toContain('.skipLocked()');
});
```

If this test file does not already import `readFile`, add:

```ts
import { readFile } from 'node:fs/promises';
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts -t "claims materialized pending fires"
```

Expected: FAIL because the pending Fire query joins `scheduled_tasks` and filters `deleted_at`.

- [ ] **Step 3: Remove only the invalid join/filter**

Rewrite the pending query as:

```ts
const rows = await tx.selectFrom('scheduler_fires')
  .selectAll()
  .where('state', '=', 'pending')
  .where((eb) => eb.or([
    eb('retry_at', 'is', null),
    eb('retry_at', '<=', input.now),
  ]))
  .orderBy('fire_time', 'asc').limit(input.limit).forUpdate().execute();
```

Leave the earlier `scheduled_tasks.enabled = 1` and `deleted_at IS NULL` materialization query unchanged.

- [ ] **Step 4: Run Scheduler runtime tests**

Run:

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts
```

Expected: PASS and no MariaDB 10.2 locking regression.

- [ ] **Step 5: Review the diff without committing**

Run:

```bash
git diff -- packages/scheduler-runtime/src/mysql.ts tests/scheduler-runtime/scheduler-runtime.test.ts
```

Expected: the materialization query remains deletion-aware; only the existing pending Fire query is decoupled.

---

### Task 3: Enforce Scheduler Batch Capacity and Bound-Fire Fairness

**Files:**
- Modify: `packages/scheduler-runtime/src/runner.ts:73-165`
- Test: `tests/scheduler-runtime/scheduler-runtime.test.ts`

**Interfaces:**
- Consumes: `SchedulerStore.listBound`, `SchedulerStore.deferBound`, existing `retryDelayMs`.
- Produces: every inspected bound candidate consumes batch capacity; active/waiting candidates receive an exact-token fenced deferral; `tick()` return value remains advancement/completion count.

- [ ] **Step 1: Add a failing batch-capacity test**

Create a test with an expired bound Fire and a second due task:

```ts
it('counts an active bound fire against the shared batch limit', async () => {
  const store = new MemorySchedulerStore([task, { ...task, taskId: 'task-b' }]);
  const [claimed] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1 });
  await store.bindRun({
    fireId: claimed!.fireId,
    claimToken: claimed!.claimToken,
    runId: claimed!.fireId,
    boundAt: fireTime,
  });
  const claimDue = vi.spyOn(store, 'claimDue');
  const runner = new SchedulerRunner({
    store,
    dispatcher: { startScheduledRun: vi.fn() },
    boundRecovery: activeBoundRecovery,
    workerId: 'worker-b',
    retryDelayMs: 100,
  });

  expect(await runner.tick(new Date(fireTime.getTime() + 2), 1)).toBe(0);
  expect(claimDue).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 0 }));
});
```

- [ ] **Step 2: Add a failing active/waiting deferral test**

```ts
it.each(['active', 'waiting'] as const)('defers a %s bound fire before inspecting later candidates', async (kind) => {
  const store = new MemorySchedulerStore([task]);
  const [claimed] = await store.claimDue({ now: fireTime, limit: 1, workerId: 'worker-a', leaseMs: 1 });
  await store.bindRun({ fireId: claimed!.fireId, claimToken: claimed!.claimToken, runId: claimed!.fireId, boundAt: fireTime });
  const deferBound = vi.spyOn(store, 'deferBound');
  const runner = new SchedulerRunner({
    store,
    dispatcher: { startScheduledRun: vi.fn() },
    boundRecovery: { inspect: async () => ({ kind }), resume: vi.fn() },
    workerId: 'worker-b',
    retryDelayMs: 100,
  });
  const now = new Date(fireTime.getTime() + 2);

  expect(await runner.tick(now, 1)).toBe(0);
  expect(deferBound).toHaveBeenCalledWith({
    fireId: claimed!.fireId,
    claimToken: claimed!.claimToken,
    retryAt: new Date(now.getTime() + 100),
    error: `durable Run remains ${kind}`,
  });
  expect((await store.listFires())[0]).toMatchObject({
    state: 'bound', runId: claimed!.fireId, attempts: 1,
    retryAt: new Date(now.getTime() + 100),
  });
});
```

- [ ] **Step 3: Run both new tests and confirm failure**

Run:

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts -t "shared batch limit|defers a"
```

Expected: FAIL because active/waiting Fires are continued without deferral and `remaining` uses `recovered`.

- [ ] **Step 4: Implement minimal runner changes**

After `listBound`, compute:

```ts
const boundConsumed = bound.length;
```

Replace the active/waiting branch with:

```ts
if (inspection.kind === 'active' || inspection.kind === 'waiting') {
  await this.options.store.deferBound({
    fireId: fire.fireId,
    claimToken: fire.claimToken,
    retryAt: new Date(now.getTime() + this.retryDelayMs),
    error: `durable Run remains ${inspection.kind}`,
  }).catch(() => undefined);
  continue;
}
```

Replace capacity calculation with:

```ts
const remaining = Math.max(0, limit - boundConsumed);
```

Do not increment `recovered` for active/waiting and do not change the final return expression.

- [ ] **Step 5: Add and run a fairness regression**

Add a test with two bound Fires, the older active and the later recoverable, `limit = 1`. Assert first tick defers the old Fire; second tick after the later Fire is eligible but before the old retry time inspects/resumes the later Fire.

Run:

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts
```

Expected: PASS; active/waiting Fire keeps `attempts: 1`, later recovery is no longer starved, and total bound/new capacity does not exceed the limit.

- [ ] **Step 6: Review the diff without committing**

Run:

```bash
git diff -- packages/scheduler-runtime/src/runner.ts tests/scheduler-runtime/scheduler-runtime.test.ts
```

Expected: no public interface changes and no unrelated metric/return-value changes.

---

### Task 4: Add Offline Deployment Safety Contract Tests

**Files:**
- Create: `scripts/test-aiop-staging-deploy-contract.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: deployment shell scripts as source text and temporary fixtures under `dist/test-tmp`.
- Produces: `npm run test:staging-deploy-contract` that fails if another database can be targeted, unsafe database enumeration appears, temporary output leaves `dist`, or staging workload deploy applies the static ConfigMap.

- [ ] **Step 1: Create the failing contract test script**

Create an executable Bash script with `set -euo pipefail`, `umask 077`, and a temporary directory under `dist/test-tmp`. It must assert:

```bash
grep -q "database=aiop" scripts/rebuild-aiop-staging-db.sh
! grep -Eq 'SHOW[[:space:]]+DATABASES|DROP[[:space:]]+DATABASE' scripts/*.sh
! grep -Eq 'database=\$\{|--database="?\$' scripts/rebuild-aiop-staging-db.sh
grep -q "test .*MYSQL_DATABASE.*aiop" scripts/rebuild-aiop-staging-db.sh
grep -q 'tenant_settings' scripts/backup-aiop-staging-db-settings.sh
grep -q 'setting_secrets' scripts/backup-aiop-staging-db-settings.sh
grep -q "llm.default" scripts/backup-aiop-staging-db-settings.sh
grep -q "sandbox.default" scripts/backup-aiop-staging-db-settings.sh
grep -q 'dist/' Makefile
grep -q '\.playwright-mcp/' .gitignore
grep -q '\.playwright-mcp/' .dockerignore
```

It must isolate the `deploy-aiop-staging-workload` recipe and fail if that recipe contains `configmap.yaml`.

- [ ] **Step 2: Add the npm entry and confirm failure**

Add:

```json
"test:staging-deploy-contract": "bash scripts/test-aiop-staging-deploy-contract.sh"
```

Run:

```bash
npm run test:staging-deploy-contract
```

Expected: FAIL because the DB settings backup script and workload-only Make target do not exist yet.

- [ ] **Step 3: Keep the test offline and non-destructive**

Verify the test script invokes no `kubectl`, `ssh`, `mysql`, `mariadb`, `docker`, or Make deployment target. It may only inspect source and local fixtures.

Run:

```bash
bash -n scripts/test-aiop-staging-deploy-contract.sh
```

Expected: PASS syntax check while functional assertions still fail until later tasks.

---

### Task 5: Back Up Complete Kubernetes Settings Under `dist`

**Files:**
- Modify: `scripts/backup-aiop-k8s-settings.sh`
- Test: `scripts/test-aiop-staging-deploy-contract.sh`

**Interfaces:**
- Consumes: `AIOP_NAMESPACE`, `AIOP_KUBECONFIG`, `AIOP_BACKUP_DIR`.
- Produces: `$AIOP_BACKUP_DIR/k8s/aiop-config.data.json`, `$AIOP_BACKUP_DIR/k8s/aiop-secrets.data.json`, and non-sensitive hash summary.

- [ ] **Step 1: Extend the contract test for full `.data` backup**

Require source to request complete objects and extract `.data`, not named keys:

```bash
grep -q 'get configmap aiop-config -o json' scripts/backup-aiop-k8s-settings.sh
grep -q 'get secret aiop-secrets -o json' scripts/backup-aiop-k8s-settings.sh
! grep -q 'OPENAI_API_KEY' scripts/backup-aiop-k8s-settings.sh
```

- [ ] **Step 2: Rewrite the backup outputs minimally**

Use a stable default:

```bash
backup_dir=${AIOP_BACKUP_DIR:-"$(pwd)/dist/aiop-staging-backup/manual"}
k8s_dir="$backup_dir/k8s"
umask 077
mkdir -p "$k8s_dir"
chmod 700 "$backup_dir" "$k8s_dir"
```

Capture complete resource JSON into protected temporary files inside `$k8s_dir`, then use Node to write only the `.data` object in stable key order. Do not decode Secret values. Example extractor:

```bash
node -e '
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const data = input.data ?? {};
const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(process.argv[2], JSON.stringify(sorted) + "\n", { mode: 0o600 });
' "$resource_json" "$output"
```

Write only hashes and key counts to the summary.

- [ ] **Step 3: Syntax-check and run offline contracts**

Run:

```bash
bash -n scripts/backup-aiop-k8s-settings.sh
npm run test:staging-deploy-contract
```

Expected: Kubernetes backup assertions PASS; later DB/workload assertions may still fail.

---

### Task 6: Back Up Required `aiop` Database Settings

**Files:**
- Create: `scripts/backup-aiop-staging-db-settings.sh`
- Modify: `Makefile:79-83`
- Test: `scripts/test-aiop-staging-deploy-contract.sh`

**Interfaces:**
- Consumes: live `deploy/aiop-server` environment for host/port/database, fixed SSH/container settings, `AIOP_BACKUP_DIR`.
- Produces: protected SQL/TSV backup and SHA-256 summaries for `aiop.tenant_settings` keys `llm.default`, `sandbox.default`, and `aiop.setting_secrets` key `sandbox.default.api_key`.

- [ ] **Step 1: Add a Make target and failing source assertions**

Add target name:

```make
backup-aiop-staging-db-settings:
	AIOP_KUBECONFIG=$(AIOP_KUBECONFIG) AIOP_NAMESPACE=$(AIOP_NAMESPACE) AIOP_BACKUP_DIR=$(AIOP_BACKUP_DIR) ./scripts/backup-aiop-staging-db-settings.sh
```

Extend contracts to require the target and the exact fixed database guard.

- [ ] **Step 2: Implement strict target validation**

The script must obtain `MYSQL_DATABASE` from the running AIoP deployment and enforce:

```bash
if [[ "$database" != 'aiop' ]]; then
  printf 'BLOCKED: expected exact database aiop; no database operation was performed\n' >&2
  exit 2
fi
```

The remote client command must contain literal `--database=aiop`; never interpolate the database into that flag.

Do not execute `SHOW DATABASES` or query `information_schema.schemata`.

- [ ] **Step 3: Export only the required rows without logging values**

Use fixed SELECT statements against `aiop`:

```sql
SELECT tenant_id, setting_key, HEX(config), created_at, updated_at
FROM tenant_settings
WHERE setting_key IN ('llm.default', 'sandbox.default')
ORDER BY tenant_id, setting_key;
```

```sql
SELECT tenant_id, setting_key, HEX(payload), created_at, updated_at
FROM setting_secrets
WHERE setting_key = 'sandbox.default.api_key'
ORDER BY tenant_id, setting_key;
```

Store output under `$AIOP_BACKUP_DIR/db/` with `0600` permissions. Store row counts and SHA-256 in `db-settings-summary.txt`; never print row contents.

If tables do not exist because the database was already emptied, fail closed: there is no trustworthy pre-rebuild source.

- [ ] **Step 4: Add a completion marker**

After files and hashes are verified, atomically create:

```text
$AIOP_BACKUP_DIR/db/settings-backup.complete
```

containing only database name, row counts, hashes, and timestamp. The rebuild task must require this marker.

- [ ] **Step 5: Run syntax and offline contracts**

Run:

```bash
bash -n scripts/backup-aiop-staging-db-settings.sh
npm run test:staging-deploy-contract
```

Expected: DB backup source contracts PASS without connecting to any database.

---

### Task 7: Rebuild Only Tables in `aiop`, Restore Settings, and Verify Hashes

**Files:**
- Modify: `scripts/rebuild-aiop-staging-db.sh`
- Test: `scripts/test-aiop-staging-deploy-contract.sh`

**Interfaces:**
- Consumes: `$AIOP_BACKUP_DIR/db/settings-backup.complete` and its protected data files.
- Produces: rebuilt baseline inside `aiop`, restored settings, `$AIOP_BACKUP_DIR/db/settings-restore-summary.txt`, and a verified completion marker.

- [ ] **Step 1: Add failing destructive-scope contract assertions**

Require:

```bash
grep -q 'settings-backup.complete' scripts/rebuild-aiop-staging-db.sh
! grep -Eq 'DROP[[:space:]]+DATABASE|CREATE[[:space:]]+DATABASE|SHOW[[:space:]]+DATABASES' scripts/rebuild-aiop-staging-db.sh
grep -q -- '--database=aiop' scripts/rebuild-aiop-staging-db.sh
```

Require the script to list tables only with:

```sql
SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = 'aiop'
```

This is table enumeration inside the allowed database scope, not database enumeration.

- [ ] **Step 2: Validate the backup before any write**

Before any CREATE/DROP TABLE operation:

- require `DB_REBUILD_MODE=initialize-in-place`;
- require `AIOP_BACKUP_DIR` under the repository `dist` directory;
- require the completion marker;
- recalculate both backup hashes and compare with the marker;
- revalidate live `MYSQL_DATABASE=aiop`;
- print no backup contents.

Expected failure behavior: nonzero exit and the message `no database write was performed`.

- [ ] **Step 3: Replace the non-empty blocker with table-only cleanup**

Read table names only from `information_schema.tables WHERE table_schema = 'aiop'`. Validate each table name against `^[A-Za-z0-9_]+$`. Generate one fixed-database cleanup statement:

```sql
SET FOREIGN_KEY_CHECKS=0;
DROP TABLE IF EXISTS `table_one`, `table_two`;
SET FOREIGN_KEY_CHECKS=1;
```

Execute it through the remote client with literal `--database=aiop`.

Never issue `DROP DATABASE`, `CREATE DATABASE`, `USE <variable>`, or any query against another schema.

- [ ] **Step 4: Import baseline and verify expected tables**

Keep the existing stdin baseline import with literal `--database=aiop`, create/update `schema_migrations`, then verify the expected table count or exact required table set. If the baseline count changes during implementation, derive the expected count from the baseline fixture test rather than weakening verification.

- [ ] **Step 5: Restore backed-up rows transactionally**

Convert the HEX fields back inside fixed INSERT statements:

```sql
START TRANSACTION;
INSERT INTO tenant_settings (tenant_id, setting_key, config, created_at, updated_at)
VALUES (..., CONVERT(UNHEX('<hex>') USING utf8mb4), ..., ...)
ON DUPLICATE KEY UPDATE config = VALUES(config), created_at = VALUES(created_at), updated_at = VALUES(updated_at);
INSERT INTO setting_secrets (tenant_id, setting_key, payload, created_at, updated_at)
VALUES (..., CONVERT(UNHEX('<hex>') USING utf8mb4), ..., ...)
ON DUPLICATE KEY UPDATE payload = VALUES(payload), created_at = VALUES(created_at), updated_at = VALUES(updated_at);
COMMIT;
```

Generate SQL locally without printing it. Quote tenant/key/timestamp fields with a dedicated shell escaping function or generate the SQL through Node to avoid malformed input.

- [ ] **Step 6: Re-export and compare exact hashes**

Run the same ordered SELECTs used by the backup script into protected restore-verification files. Compare row counts and SHA-256. On mismatch, exit nonzero, retain evidence, and do not continue deployment.

Create `settings-restore.complete` only after exact comparison succeeds.

- [ ] **Step 7: Run syntax and offline contracts**

Run:

```bash
bash -n scripts/rebuild-aiop-staging-db.sh
npm run test:staging-deploy-contract
```

Expected: PASS. Confirm manually from the source diff that every database client invocation contains literal `--database=aiop`.

---

### Task 8: Add Workload-Only Staging Deployment and Orchestrate the Safe Fresh Flow

**Files:**
- Modify: `Makefile:79-96`
- Modify: `scripts/deploy-aiop-staging-fresh.sh`
- Test: `scripts/test-aiop-staging-deploy-contract.sh`

**Interfaces:**
- Consumes: backup/rebuild targets from Tasks 5-7 and `IMAGE_TAG`.
- Produces: one `make deploy-aiop-staging-fresh IMAGE_TAG=<tag>` workflow; workload-only deploy that never applies static ConfigMap/Secret.

- [ ] **Step 1: Add the workload-only Make target**

Create:

```make
deploy-aiop-staging-workload:
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get configmap aiop-config -o name >/dev/null
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) get secret aiop-secrets -o name >/dev/null
	$(AIOP_KUBECTL) apply -f deploy/aiop/pvc-skills.yaml
	$(AIOP_KUBECTL) apply -f deploy/aiop/service-nodeport.yaml
	$(AIOP_KUBECTL) set image -f deploy/aiop/deployment.yaml aiop=$(PUBLISH_IMAGE) aiop-web=$(PUBLISH_WEB_IMAGE) --local -o yaml | $(AIOP_KUBECTL) apply -f -
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) set env deployment/aiop-server AIOP_DEPLOY_IMAGE=$(PUBLISH_IMAGE) AIOP_DEPLOY_WEB_IMAGE=$(PUBLISH_WEB_IMAGE)
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) patch deployment aiop-server --type=strategic --patch='{"spec":{"template":{"spec":{"containers":[{"name":"aiop","imagePullPolicy":"$(AIOP_IMAGE_PULL_POLICY)"},{"name":"aiop-web","imagePullPolicy":"$(AIOP_IMAGE_PULL_POLICY)"}]}}}}'
	$(AIOP_KUBECTL) -n $(AIOP_NAMESPACE) rollout status deployment/aiop-server --timeout=300s
```

Do not change general `deploy-aiop`; only the safe fresh flow uses this target.

- [ ] **Step 2: Generate one protected run directory in the fresh script**

Use:

```bash
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
run_root=${AIOP_BACKUP_DIR:-"$repo_root/dist/aiop-staging-backup/$(date -u +%Y%m%dT%H%M%SZ)-$$"}
case "$run_root" in "$repo_root"/dist/*) ;; *) printf 'BLOCKED: backup directory must be under dist\n' >&2; exit 2;; esac
export AIOP_BACKUP_DIR="$run_root"
umask 077
mkdir -p "$run_root"
chmod 700 "$run_root"
```

Pass this exact directory to every child Make target.

- [ ] **Step 3: Orchestrate in the approved order**

The script sequence must be:

```text
validate targets
backup Kubernetes settings
backup aiop database settings
pipeline/image publish
rebuild only aiop and restore settings
deploy staging workload only
compare complete Kubernetes .data hashes
health/ready/rollout checks
```

Use:

```bash
make backup-aiop-staging-k8s-settings AIOP_BACKUP_DIR="$run_root"
make backup-aiop-staging-db-settings AIOP_BACKUP_DIR="$run_root"
make pipeline IMAGE_TAG="$IMAGE_TAG"
make rebuild-aiop-staging-db DB_REBUILD_MODE=initialize-in-place AIOP_BACKUP_DIR="$run_root"
make deploy-aiop-staging-workload IMAGE_TAG="$IMAGE_TAG"
```

- [ ] **Step 4: Compare complete K8s `.data` without decoding Secrets**

Fetch current complete `.data` into protected files under `$run_root/k8s/verify`, stable-sort keys with Node, and compare SHA-256 with backups. Never decode Secret values.

Require `$run_root/db/settings-restore.complete` before workload deployment.

- [ ] **Step 5: Update Make target defaults**

Remove the dated `dist/aios-team/scheduler-todos-20260806/backup` path. Let the fresh script generate the run directory. Ensure the three subtargets accept and forward `AIOP_BACKUP_DIR`.

- [ ] **Step 6: Run syntax and offline contracts**

Run:

```bash
bash -n scripts/deploy-aiop-staging-fresh.sh
make -n deploy-aiop-staging-workload IMAGE_TAG=contract-test
make -n deploy-aiop-staging-fresh IMAGE_TAG=contract-test
npm run test:staging-deploy-contract
```

Expected: PASS; dry-run output contains no `deploy/aiop/configmap.yaml` in the workload-only recipe.

---

### Task 9: Move Temporary Test Artifacts Under `dist`

**Files:**
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `.test-scripts/release-health/chat_skills_auth_smoke.sh:9-18`
- Move/delete local temporary directory: `.playwright-mcp/` to `dist/playwright-mcp/`
- Test: `scripts/test-aiop-staging-deploy-contract.sh`

**Interfaces:**
- Consumes: repository `dist` convention.
- Produces: no root Playwright artifacts in Git/Docker contexts; smoke test temporary files under `dist/test-tmp`.

- [ ] **Step 1: Add defensive ignore entries**

Add `.playwright-mcp/` to both ignore files. Keep the existing `dist` ignore.

- [ ] **Step 2: Change the smoke test temporary directory**

Replace bare `mktemp -d` with:

```bash
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$REPO_ROOT/dist/test-tmp"
umask 077
TMP_DIR="$(mktemp -d "$REPO_ROOT/dist/test-tmp/chat-skills-auth.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
```

- [ ] **Step 3: Relocate existing untracked evidence**

If `.playwright-mcp/` exists, create `dist/playwright-mcp/` and move its files there. Do not delete user-authored files; verify the directory contains only generated console/page artifacts before moving.

- [ ] **Step 4: Verify status and contracts**

Run:

```bash
bash -n .test-scripts/release-health/chat_skills_auth_smoke.sh
npm run test:staging-deploy-contract
git status --short
```

Expected: `.playwright-mcp/` no longer appears as untracked, and its artifacts exist only under ignored `dist/playwright-mcp`.

---

### Task 10: Run Focused and Complete Local Verification

**Files:**
- Modify only if tests reveal a confirmed regression in the planned scope.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: locally verified code and deployment commands ready for external staging execution.

- [ ] **Step 1: Run shell syntax and deployment contracts**

```bash
bash -n scripts/backup-aiop-k8s-settings.sh
bash -n scripts/backup-aiop-staging-db-settings.sh
bash -n scripts/rebuild-aiop-staging-db.sh
bash -n scripts/deploy-aiop-staging-fresh.sh
bash -n scripts/test-aiop-staging-deploy-contract.sh
bash -n .test-scripts/release-health/chat_skills_auth_smoke.sh
npm run test:staging-deploy-contract
```

Expected: PASS.

- [ ] **Step 2: Run focused tests**

```bash
npx vitest run tests/scheduler-runtime/scheduler-runtime.test.ts tests/frontend.test.ts tests/http.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck and package build**

```bash
npm run typecheck
npm run build:packages
npm --prefix web run build
```

Expected: PASS; compiled outputs remain under configured `bin`/ignored frontend build directories.

- [ ] **Step 4: Run the complete project verification**

```bash
npm run test:runtime-refactor
```

Expected: PASS.

- [ ] **Step 5: Run simplification and final review skills**

Invoke the configured `simplify` skill for changed code quality only, then `superpowers:requesting-code-review` for an independent final bug review. Apply only verified in-scope fixes and rerun affected tests.

- [ ] **Step 6: Confirm working-tree boundaries**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; no temporary artifacts outside `dist`; original unrelated user changes remain present and untouched.

---

### Task 11: Execute the Safe Staging Deployment

**Files:**
- No source changes unless the external deployment exposes an in-scope, reproducible defect.
- Evidence: `dist/aiop-staging-backup/<run>/`

**Interfaces:**
- Consumes: locally verified Make targets and access to the staging cluster/MariaDB host.
- Produces: deployed images, rebuilt `aiop` schema, restored exact settings, preserved Kubernetes data, passing health and Scheduler checks.

- [ ] **Step 1: Inspect the dry-run command**

```bash
make -n deploy-aiop-staging-fresh IMAGE_TAG="$(git rev-parse --short HEAD)-review-fixes"
```

Expected: one fresh orchestration script; no database name other than literal `aiop`; no static ConfigMap application in workload deployment.

- [ ] **Step 2: Run the approved Make deployment**

```bash
make deploy-aiop-staging-fresh IMAGE_TAG="$(git rev-parse --short HEAD)-review-fixes"
```

Expected sequence:

- protected Kubernetes backup succeeds;
- protected `aiop` settings backup succeeds;
- image pipeline succeeds;
- only `aiop` tables are rebuilt;
- settings restore hashes match;
- workload rollout succeeds without replacing ConfigMap/Secret;
- `/healthz` and `/readyz` pass.

If permission/authentication requires an interactive local command, ask the user to run it with the `! <command>` prompt convention; do not embed credentials.

- [ ] **Step 3: Verify remote rollout and evidence summaries**

Use the project Make/kubectl settings to verify:

```bash
$(make -s print-aiop-staging-status 2>/dev/null || true)
```

If no status target exists, use the exact `AIOP_KUBECTL` configuration from Makefile to inspect only namespace `aios-system`:

```bash
kubectl --kubeconfig /home/lb/.kube/config-10.241.0.166 -n aios-system rollout status deployment/aiop-server --timeout=300s
kubectl --kubeconfig /home/lb/.kube/config-10.241.0.166 -n aios-system get deployment aiop-server
```

Read only non-sensitive summary files under the generated backup directory. Do not print backup data files.

- [ ] **Step 4: Run Scheduler platform smoke**

Use the existing project Scheduler platform test or `.test-scripts/scheduler/` smoke through a Make target if present. Verify creation, due execution, bound observation, history, and cleanup without exposing credentials.

- [ ] **Step 5: Report exact outcome**

Report:

- local tests/builds executed and their pass/fail status;
- deployment image tag;
- namespace `aios-system`;
- confirmation that only database `aiop` was operated on;
- non-sensitive settings backup/restore row counts and hash-match status;
- ConfigMap/Secret hash-match status;
- rollout/health/Scheduler status;
- any skipped step or failure verbatim.

Do not claim success if any restore, hash, rollout, health, or Scheduler verification failed.
