# AIOS Dynamic Template and Browser Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AIOP load every enabled AIOS E2B template dynamically, enforce template Runtime Roles server-side, and use AIOS browser templates through AIOP’s existing browser preview and control APIs.

**Architecture:** Extend AIOS `GET /templates` with an optional `aios` metadata object while preserving the standard E2B response. AIOP loads and validates that catalog before preparing an AIOS runtime generation; each generation atomically owns the catalog fingerprint, profiles, template allowlist, provider, manager, spec resolver, and command-driven browser resolver. Role filtering is enforced in the HTTP response, profile tools, controller acquisition path, and provider allowlist.

**Tech Stack:** Go 1.25, Gin, TypeScript 6, Node.js 24, Zod 4, Vitest 4, React, Vite, Kubernetes-hosted AIOS Lifecycle REST.

## Global Constraints

- Preserve every existing standard E2B top-level template field and the top-level array response shape.
- Only accept AIOS templates with `buildStatus=ready`, valid `templateID`, and valid `aios.envType` / `aios.runtimeRole` metadata.
- `sandbox-diag` profiles are visible and usable only by `platform_admin`; frontend hiding is not an authorization boundary.
- Generic Key requests continue to include structured `placement.clusterId`; never send AIOS resource-group fields.
- Runtime Role remains template-bound; never accept ServiceAccount, RBAC, securityContext, hostNetwork, hostPID, hostPath, or arbitrary PodSpec overrides.
- Complete API Keys must never enter source, logs, errors, snapshots, API responses, frontend state, or command output.
- All authenticated AIOS requests use `redirect: 'error'`, bounded timeouts, bounded response bodies, and sanitized errors.
- AIOS mode continues to reject Sandbox volumes and user-home mounts.
- Standard E2B, OpenSandbox, and Local behavior must remain compatible.
- Existing browser HTTP routes and screenshot-refresh iframe behavior remain unchanged; do not expose noVNC, CDP, Kubernetes Service, or AIOS native-management endpoints.
- Background catalog refresh defaults to 60 seconds, uses an `unref()` timer, and is serialized with settings updates.
- A failed background refresh retains the last successful generation; a failed startup catalog load starts AIOP with Runtime status `catalog_unavailable` and no invented fallback profile.
- Do not deploy, commit, push, or publish either repository without explicit user authorization; each task records a suggested commit boundary only.
- AIOP temporary artifacts belong under `dist`; build output belongs under `bin`.

---

## File Structure

### AIOS server

- Modify `internal/e2b/dto.go` — optional E2B `aios` extension DTO.
- Modify `internal/e2b/template.go` — native Template to E2B extension mapping and default Runtime Role normalization.
- Modify `internal/e2b/template_test.go` — resolver mapping and inactive-template coverage.
- Modify `internal/e2b/controller_test.go` — HTTP contract coverage preserving official fields.

### AIOP backend

- Create `src/sandbox/aios-http.ts` — shared authenticated Lifecycle HTTP client with redirect, timeout, body-limit, and sanitized-error behavior.
- Create `src/sandbox/aios-template-catalog.ts` — Zod validation, normalization, deduplication, stable ordering, profile conversion, and fingerprinting.
- Create `src/sandbox/command-desktop.ts` — provider-neutral command-driven localhost-CDP Desktop implementation.
- Modify `src/sandbox/aios-e2b.ts` — shared HTTP client and generation-owned template allowlist.
- Modify `src/sandbox/e2b.ts` — forward AIOS allowlist and preserve official SDK path.
- Modify `src/sandbox/opensandbox-desktop.ts` — thin compatibility wrapper around `CommandDesktopProvider`.
- Modify `src/sandbox/profiles.ts` — stable profile IDs, explicit template/env/runtime-role fields, authorization helpers, and role-aware default selection.
- Modify `src/sandbox/settings.ts` — stop synthesizing a fixed AIOS code profile.
- Modify `src/config/schema.ts` — remove first-stage fixed-template/desktop restrictions while keeping AIOS mount/warm-pool safety rules.
- Modify `src/sandbox/runtime-controller.ts` — role-aware profile publication/acquisition and generation catalog metadata.
- Modify `src/tools/sandbox-profiles.ts` — caller-aware listing and stable profile IDs.
- Modify `src/runtime.ts` — catalog-first generation preparation, startup degradation, refresh queue/timer/status, and AIOS browser tool activation.
- Modify `src/server/http.ts` — role-filtered profile API and platform-admin manual refresh endpoint.

### AIOP frontend

- Modify `web/src/types.ts` — dynamic profile and catalog-status DTO fields.
- Modify `web/src/App.tsx` — template metadata cards, diagnostic/browser badges, catalog status, and refresh button.

### Tests and docs

- Create `tests/aios-template-catalog.test.ts`.
- Create `tests/command-desktop.test.ts`.
- Modify `tests/aios-e2b.test.ts`.
- Modify `tests/sandbox-settings.test.ts`.
- Modify `tests/sandbox-runtime-controller.test.ts`.
- Modify `tests/runtime-sandbox-controller.test.ts`.
- Modify `tests/http.test.ts`.
- Modify `tests/frontend.test.ts`.
- Modify `docs/DESIGN-aios-e2b-integration.md` — replace the fixed-template limitation with the dynamic-catalog contract.

---

### Task 1: Extend the AIOS E2B template contract

**Files:**
- Modify: `/home/opt/develop/aicoding/ai-sandbox/aios-sandbox-server/internal/e2b/dto.go:55-92`
- Modify: `/home/opt/develop/aicoding/ai-sandbox/aios-sandbox-server/internal/e2b/template.go:132-175`
- Test: `/home/opt/develop/aicoding/ai-sandbox/aios-sandbox-server/internal/e2b/template_test.go`
- Test: `/home/opt/develop/aicoding/ai-sandbox/aios-sandbox-server/internal/e2b/controller_test.go:299-358`

**Interfaces:**
- Consumes: `model.Template.Description`, `EnvType`, `RuntimeRole`, `Image`, and `DefaultTimeoutHours`.
- Produces:

```go
type AIOSTemplateMetadataDTO struct {
    Description         string `json:"description"`
    EnvType             string `json:"envType"`
    RuntimeRole         string `json:"runtimeRole"`
    Image               string `json:"image"`
    DefaultTimeoutHours int    `json:"defaultTimeoutHours"`
}

type TemplateDTO struct {
    // all existing fields remain unchanged
    AIOS *AIOSTemplateMetadataDTO `json:"aios,omitempty"`
}
```

- [ ] **Step 1: Write failing resolver tests for AIOS metadata and role normalization**

Add a test that stores active code, browser, diagnostic, and inactive templates, calls `resolver.List`, and verifies:

```go
if got.AIOS == nil {
    t.Fatal("expected AIOS metadata")
}
if got.AIOS.Description != "Browser sandbox" || got.AIOS.EnvType != "browser" {
    t.Fatalf("unexpected AIOS metadata: %+v", got.AIOS)
}
if got.AIOS.RuntimeRole != "sandbox-reader" {
    t.Fatalf("expected empty role to normalize to sandbox-reader: %+v", got.AIOS)
}
if got.AIOS.Image != "browser:latest" || got.AIOS.DefaultTimeoutHours != 2 {
    t.Fatalf("unexpected image/timeout metadata: %+v", got.AIOS)
}
```

Include a `sandbox-diag` template and assert its role remains `sandbox-diag`. Assert the inactive template is absent.

- [ ] **Step 2: Run the focused resolver test and verify it fails**

Run from `/home/opt/develop/aicoding/ai-sandbox/aios-sandbox-server`:

```bash
go test ./internal/e2b -run 'TestTemplateResolverList.*AIOS' -count=1
```

Expected: FAIL because `TemplateDTO` has no `AIOS` field.

- [ ] **Step 3: Add the optional DTO and mapping**

Add the DTO to `dto.go`, add `AIOS *AIOSTemplateMetadataDTO` to both `TemplateDTO` and `TemplateDetailDTO`, and map it through one helper:

```go
func aiosTemplateMetadataDTO(t *model.Template) *AIOSTemplateMetadataDTO {
    runtimeRole := t.RuntimeRole
    if runtimeRole == "" {
        runtimeRole = "sandbox-reader"
    }
    return &AIOSTemplateMetadataDTO{
        Description:         t.Description,
        EnvType:             t.EnvType,
        RuntimeRole:         runtimeRole,
        Image:               t.Image,
        DefaultTimeoutHours: t.DefaultTimeoutHours,
    }
}
```

Set `AIOS: aiosTemplateMetadataDTO(t)` in both list and detail DTO builders. Do not rename or omit any existing field.

- [ ] **Step 4: Extend the HTTP compatibility test**

Keep the existing `required` standard-field assertions, then assert:

```go
aios, ok := body[0]["aios"].(map[string]any)
if !ok {
    t.Fatalf("expected optional AIOS extension object: %+v", body[0])
}
for _, key := range []string{"description", "envType", "runtimeRole", "image", "defaultTimeoutHours"} {
    if _, ok := aios[key]; !ok {
        t.Fatalf("expected AIOS key %s: %+v", key, aios)
    }
}
```

Update `newControllerTestRouter`’s template fixture with explicit description/env type/image/timeout so the mapping is observable. Add the same extension assertion to the detail response.

- [ ] **Step 5: Run AIOS focused and package tests**

```bash
go test ./internal/e2b -run 'TestTemplateResolver|TestListTemplates|TestGetTemplate' -count=1
go test ./internal/e2b -count=1
```

Expected: PASS; existing SDK-required fields remain present and the new `aios` object is additive.

- [ ] **Step 6: Record the review checkpoint**

Run `gofmt -w internal/e2b/dto.go internal/e2b/template.go internal/e2b/template_test.go internal/e2b/controller_test.go` and `git diff --check`. Suggested commit boundary, only if later authorized: `feat: expose AIOS metadata in E2B templates`.

---

### Task 2: Build a safe AIOP AIOS HTTP client and template catalog

**Files:**
- Create: `src/sandbox/aios-http.ts`
- Create: `src/sandbox/aios-template-catalog.ts`
- Test: `tests/aios-template-catalog.test.ts`

**Interfaces:**
- Consumes: Lifecycle URL, encrypted-settings API Key after decryption, injectable `fetch`.
- Produces:

```ts
export class AiosLifecycleHttpError extends Error {
  constructor(readonly status: number);
}

export interface AiosLifecycleHttpOptions {
  lifecycleUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class AiosLifecycleHttpClient {
  constructor(opts: AiosLifecycleHttpOptions);
  requestJson<T>(
    path: string,
    init?: { method?: string; body?: unknown },
    allowedStatuses?: readonly number[],
  ): Promise<{ body: T; status: number }>;
}

export type AiosTemplateEnvType = 'code' | 'browser';
export type SandboxRuntimeRole = 'sandbox-reader' | 'sandbox-diag';

export interface AiosTemplateCatalogEntry {
  templateId: string;
  name: string;
  aliases: string[];
  description: string;
  envType: AiosTemplateEnvType;
  runtimeRole: SandboxRuntimeRole;
  image: string;
  defaultTimeoutMs?: number;
}

export interface AiosTemplateCatalogSnapshot {
  templates: AiosTemplateCatalogEntry[];
  fingerprint: string;
  loadedAt: string;
}

export class AiosTemplateCatalog {
  constructor(opts: AiosLifecycleHttpOptions);
  load(): Promise<AiosTemplateCatalogSnapshot>;
}
```

- [ ] **Step 1: Write failing catalog happy-path tests**

Create a mock `/templates` response containing `browser`, `netdig`, `code-interpreter`, a duplicate `templateID`, a non-ready item, and an item without valid `aios` metadata. Verify:

```ts
expect(snapshot.templates.map((item) => item.templateId)).toEqual([
  'browser-id',
  'code-id',
  'diag-id',
]);
expect(snapshot.templates[0]).toMatchObject({
  name: 'browser',
  envType: 'browser',
  runtimeRole: 'sandbox-reader',
  defaultTimeoutMs: 7_200_000,
});
expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
```

Verify deduplication keeps the first valid entry and stable ordering uses display name then template ID.

- [ ] **Step 2: Write failing HTTP safety tests**

Cover all of these observable behaviors:

```ts
expect(init?.redirect).toBe('error');
expect(init?.signal).toBeInstanceOf(AbortSignal);
await expect(catalog.load()).rejects.toThrow('AIOS Lifecycle request failed');
expect(String(error)).not.toContain('complete-test-key');
```

Also test HTTP 401, malformed top-level JSON, a `content-length` above the configured limit, and a streamed body that exceeds the limit without a `content-length` header.

- [ ] **Step 3: Run the new test file and verify it fails**

```bash
npm test -- tests/aios-template-catalog.test.ts
```

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement `AiosLifecycleHttpClient`**

Use these defaults:

```ts
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
```

Normalize the URL by trimming trailing slashes, require a non-empty AIOS Key, create one `AbortController` per request, use an unref’ed timeout, and always clear it. Read the body through `response.body.getReader()` while counting bytes; reject before JSON parsing when the limit is exceeded. Network, abort, parsing, and size errors must use fixed messages without response bodies, headers, URLs with credentials, or the Key.

- [ ] **Step 5: Implement catalog validation and fingerprinting**

Use a permissive top-level E2B schema with strict AIOS metadata:

```ts
const TemplateSchema = z.object({
  templateID: z.string().trim().min(1),
  names: z.array(z.string()),
  aliases: z.array(z.string()),
  buildStatus: z.string(),
  aios: z.object({
    description: z.string(),
    envType: z.enum(['code', 'browser']),
    runtimeRole: z.enum(['sandbox-reader', 'sandbox-diag']),
    image: z.string(),
    defaultTimeoutHours: z.number().int().nonnegative(),
  }).strict(),
}).passthrough();
```

Validate each array item independently, log only item index/template ID and validation class, ignore invalid/non-ready entries, convert positive timeout hours to milliseconds, and compute SHA-256 over canonical normalized entries without Key or loaded time.

- [ ] **Step 6: Run catalog tests**

```bash
npm test -- tests/aios-template-catalog.test.ts
```

Expected: PASS with no complete Key in errors or test snapshots.

- [ ] **Step 7: Record the review checkpoint**

Run `npm run typecheck` and `git diff --check`. Suggested commit boundary, only if later authorized: `feat: add AIOS template catalog client`.

---

### Task 3: Introduce stable profile IDs and Runtime Role authorization

**Files:**
- Modify: `src/sandbox/profiles.ts`
- Modify: `src/sandbox/settings.ts:207-251`
- Modify: `src/config/schema.ts:32-150`
- Modify: `src/sandbox/runtime-controller.ts`
- Modify: `src/tools/sandbox-profiles.ts`
- Test: `tests/sandbox-settings.test.ts`
- Test: `tests/sandbox-runtime-controller.test.ts`

**Interfaces:**
- Consumes: `AiosTemplateCatalogEntry[]` from Task 2 and `RequestContext.role`.
- Produces:

```ts
export interface SandboxProfile {
  id: string;
  name: string;
  template?: string;
  description: string;
  envType: 'code' | 'browser';
  runtimeRole: 'sandbox-reader' | 'sandbox-diag';
  image?: string;
  domain?: string;
  namespace?: string;
  serviceAccount?: string;
  desktop: boolean;
  privileged: boolean;
  capabilities: string[];
  envs?: Record<string, string>;
  timeoutMs?: number;
}

export function canUseSandboxProfile(profile: SandboxProfile, role: Role): boolean;
export function visibleSandboxProfiles(profiles: SandboxProfile[], role: Role): SandboxProfile[];
export function findSandboxProfile(profiles: SandboxProfile[], selector?: string, role?: Role): SandboxProfile;
export function selectDefaultProfile(profiles: SandboxProfile[], role?: Role): SandboxProfile | undefined;
export function selectBrowserProfile(profiles: SandboxProfile[], role?: Role): SandboxProfile | undefined;
```

- [ ] **Step 1: Write failing profile compatibility and authorization tests**

Add tests that verify configured non-AIOS profiles receive `id=name`, `template` is separate from `image`, `desktop=true` derives `envType=browser`, and the default role is `sandbox-reader`.

Add controller tests with one reader and one diagnostic profile:

```ts
expect(controller.profiles({ role: 'user' })).toEqual([
  expect.objectContaining({ id: 'reader-id' }),
]);
expect(controller.profiles({ role: 'platform_admin' })).toHaveLength(2);
await expect(controller.acquire(userCtx, 'diag-id')).rejects.toThrow(/platform_admin|无权/);
expect(provider.create).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run focused tests and verify they fail**

```bash
npm test -- tests/sandbox-settings.test.ts tests/sandbox-runtime-controller.test.ts
```

Expected: FAIL because profiles have no stable ID/runtime role and controller APIs are not role-aware.

- [ ] **Step 3: Expand profile normalization**

For legacy/config profiles, normalize with:

```ts
const desktop = profile.desktop ?? (name === 'default' ? config.desktop : false);
const template = profile.template;
const image = profile.image ?? (name === 'default' ? config.defaultImage : undefined);
return {
  id: name,
  name,
  ...(template ? { template } : {}),
  ...(image ? { image } : {}),
  description: profile.description || `${name} 沙箱模板`,
  envType: desktop ? 'browser' : 'code',
  runtimeRole: 'sandbox-reader',
  desktop,
  privileged: Boolean(profile.privileged),
  capabilities: profile.capabilities ?? [],
};
```

Update the public DTO with `id`, `template`, `envType`, and `runtimeRole`. Update `sandboxSpecForProfile()` to use `template: profile.template ?? profile.image`, `profile: profile.id`, and stable keys scoped by `profile.id`.

- [ ] **Step 4: Implement role-aware selection**

`canUseSandboxProfile` returns false only for `sandbox-diag` when the caller is not `platform_admin`. Selector lookup checks stable ID first, then a unique display name. Default code selection is:

```ts
const allowed = visibleSandboxProfiles(profiles, role).filter((p) => p.envType === 'code');
return allowed.find((p) => p.name === 'code-interpreter')
  ?? allowed.find((p) => p.name === 'code')
  ?? allowed.find((p) => p.name === 'default')
  ?? allowed[0];
```

Browser selection uses authorized `envType=browser`, preferring display name `browser`, and never falls back to a code profile.

- [ ] **Step 5: Remove the fixed AIOS profile from settings conversion**

Change `sandboxSettingsToConfig()` AIOS output to connection-only configuration:

```ts
return {
  enabled: settings.enabled,
  provider: 'e2b',
  ...(apiKey ? { apiKey } : {}),
  aios: { lifecycleUrl: settings.lifecycleUrl, placement: { ...settings.placement } },
  desktop: false,
  userHomeMountPath: '/home/user/host',
};
```

Update the existing settings test to assert there is no `profiles` key.

- [ ] **Step 6: Relax only obsolete AIOS schema restrictions**

Remove checks requiring `desktop=false`, exactly one `code` profile, no desktop profile, and `code-interpreter` only. Keep `provider=e2b`, no warm pool, and no user-home override. Reject manually configured privileged AIOS profiles if startup config still supplies `profiles`; runtime catalog mapping is the only source allowed to mark diagnostics.

- [ ] **Step 7: Enforce authorization in the controller and profile tool**

Make `profileDefinitions` and `profiles` accept `Pick<RequestContext, 'role'>`. In `acquire`, authorize both the explicit selector before resolver execution and the resolved `spec.profile` before `manager.get`. Make `buildSandboxProfileTools` accept a caller-aware accessor:

```ts
export type SandboxProfilesAccessor = (ctx: ToolContext) => SandboxProfile[];
```

Use `run(_args, ctx)` for `sandbox_list_profiles`; return only authorized public profiles.

- [ ] **Step 8: Run focused tests**

```bash
npm test -- tests/sandbox-settings.test.ts tests/sandbox-runtime-controller.test.ts
npm run typecheck
```

Expected: PASS; direct diagnostic acquisition is rejected before provider creation.

- [ ] **Step 9: Record the review checkpoint**

Run `git diff --check`. Suggested commit boundary, only if later authorized: `feat: authorize dynamic sandbox profiles`.

---

### Task 4: Apply the generation-owned template allowlist

**Files:**
- Modify: `src/sandbox/aios-e2b.ts`
- Modify: `src/sandbox/e2b.ts`
- Test: `tests/aios-e2b.test.ts`

**Interfaces:**
- Consumes: Task 2’s `AiosLifecycleHttpClient` and the generation catalog’s `ReadonlySet<string>`.
- Produces:

```ts
export interface AiosE2bProviderOptions extends AiosLifecycleHttpOptions {
  placement: AiosSandboxPlacement;
  allowedTemplateIds: ReadonlySet<string>;
  readinessAttempts?: number;
  readinessDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
```

- [ ] **Step 1: Rewrite the fixed-template test as an allowlist test**

Construct the provider with `new Set(['code-id', 'browser-id', 'diag-id'])`. Verify `browser-id` is sent in create, while `unknown-id`, missing template, and volumes fail before any fetch call:

```ts
await expect(p.create({ key: 'session:unknown', template: 'unknown-id' }))
  .rejects.toThrow(/not present in the current AIOS template catalog/);
```

Add the same rejection for `connect` when its spec names an out-of-catalog template.

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test -- tests/aios-e2b.test.ts
```

Expected: FAIL because the provider still requires `code-interpreter`.

- [ ] **Step 3: Replace private HTTP code with the shared client**

Delete the local `LifecycleHttpError` and private `fetchJson`, hold one `AiosLifecycleHttpClient`, and preserve special HTTP 408 command parsing through `allowedStatuses: [408]`. Keep readiness, file decoding, timeout conversion, delete-404 idempotence, fixed placement, volume rejection, and metadata behavior unchanged.

- [ ] **Step 4: Enforce the allowlist**

Add one helper used by create and connect:

```ts
private assertTemplateAllowed(spec: SandboxSpec): string {
  const template = spec.template;
  if (!template || !this.opts.allowedTemplateIds.has(template)) {
    throw new Error('AIOS template is not present in the current AIOS template catalog');
  }
  return template;
}
```

Only send that validated template ID. Never derive templates from display names or client metadata.

- [ ] **Step 5: Run AIOS and standard E2B tests**

```bash
npm test -- tests/aios-e2b.test.ts tests/e2b.test.ts
npm run typecheck
```

Expected: PASS; standard E2B SDK argument-shape assertions remain unchanged.

- [ ] **Step 6: Record the review checkpoint**

Run `git diff --check`. Suggested commit boundary, only if later authorized: `feat: bind AIOS provider to catalog templates`.

---

### Task 5: Extract the command-driven Desktop provider for AIOS browser templates

**Files:**
- Create: `src/sandbox/command-desktop.ts`
- Modify: `src/sandbox/opensandbox-desktop.ts`
- Test: `tests/command-desktop.test.ts`
- Modify: `tests/enhance.test.ts` only if imports or exact error text change.

**Interfaces:**
- Consumes: any generation-owned `SandboxManagerLike` whose handle implements `runCommand`.
- Produces:

```ts
export class CommandDesktopProvider implements DesktopProvider {
  constructor(manager: SandboxManagerLike);
  create(spec: DesktopSpec): Promise<DesktopHandle>;
  connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle>;
}

export class OpenSandboxDesktopProvider extends CommandDesktopProvider {}
```

- [ ] **Step 1: Write failing command Desktop tests**

Use a fake `SandboxHandle.runCommand` that records commands and returns marker output. Verify:

- `startStream()` checks/starts localhost Chrome.
- `launch(..., url)` invokes `Page.navigate` with the encoded URL.
- `leftClick` invokes CDP mouse actions.
- `write('hello\n')` invokes text insertion plus Enter key events.
- `currentUrl()` parses `__AIOP_URL__https://example.test`.
- `screenshot()` decodes `__AIOP_SCREENSHOT__<base64>` and updates `streamUrl()`.
- all commands refer only to `127.0.0.1:9222` and never contain a remote CDP/noVNC endpoint.

- [ ] **Step 2: Run the new test and verify it fails**

```bash
npm test -- tests/command-desktop.test.ts
```

Expected: FAIL because `CommandDesktopProvider` does not exist.

- [ ] **Step 3: Move provider-neutral implementation**

Move the CDP script, Chrome/Xvfb bootstrap, preview HTML, handle, and provider into `command-desktop.ts`. Rename user-visible errors from `OpenSandbox browser ...` to `sandbox browser ...`; keep the JPEG screenshot format and fixed 1280×850 CDP viewport.

`kill()` continues to terminate only Chrome/Xvfb processes started by this handle; Sandbox lifetime remains owned by the generation’s `SandboxManager`.

- [ ] **Step 4: Preserve OpenSandbox compatibility**

Replace `opensandbox-desktop.ts` with a compatibility export/subclass:

```ts
import { CommandDesktopProvider } from './command-desktop.js';
export class OpenSandboxDesktopProvider extends CommandDesktopProvider {}
```

Do not change callers outside Runtime assembly.

- [ ] **Step 5: Run Desktop and browser-tool tests**

```bash
npm test -- tests/command-desktop.test.ts tests/enhance.test.ts
npm run typecheck
```

Expected: PASS; existing browser tools still emit the same screenshot content blocks and preview URL behavior.

- [ ] **Step 6: Record the review checkpoint**

Run `git diff --check`. Suggested commit boundary, only if later authorized: `refactor: share command driven browser desktop`.

---

### Task 6: Prepare AIOS generations from the catalog and refresh them safely

**Files:**
- Modify: `src/sandbox/runtime-controller.ts`
- Modify: `src/runtime.ts`
- Test: `tests/runtime-sandbox-controller.test.ts`
- Test: `tests/sandbox-runtime-controller.test.ts`

**Interfaces:**
- Consumes: catalog snapshot, profile helpers, allowlisted provider, and `CommandDesktopProvider`.
- Produces:

```ts
export interface SandboxCatalogGenerationInfo {
  fingerprint: string;
  templateCount: number;
  loadedAt: string;
}

export interface SandboxTemplateRefreshResult {
  changed: boolean;
  templateCount: number;
  state: SandboxSettingsState;
}

// Runtime additions
sandboxProfilesFor?(ctx: RequestContext): PublicSandboxProfile[];
refreshSandboxTemplates?(): Promise<SandboxTemplateRefreshResult>;

// Controller additions
profiles(ctx: Pick<RequestContext, 'role'>): PublicSandboxProfile[];
profileDefinitions(ctx: Pick<RequestContext, 'role'>): SandboxProfile[];
desktopEnabled(): boolean;
catalogInfo(): SandboxCatalogGenerationInfo | undefined;
```

- [ ] **Step 1: Write failing runtime preparation tests**

Mock global fetch before switching to AIOS settings. Return three templates and verify:

```ts
expect(rt.sandboxProfilesFor?.(platformAdmin)).toHaveLength(3);
expect(rt.sandboxProfilesFor?.(ordinaryUser).map((p) => p.id)).toEqual(['browser-id', 'code-id']);
expect(rt.tools.has('browser_navigate')).toBe(true);
```

Assert browser creation sends `template: 'browser-id'` and the saved structured placement. Assert settings conversion itself still has no synthetic profiles.

- [ ] **Step 2: Write failing startup-degradation and refresh tests**

Cover these deterministic cases with injected/mock fetch and fake timers:

1. Persisted AIOS settings + catalog failure: `buildRuntime()` resolves, Sandbox tools are absent, status is `catalog_unavailable`.
2. Manual refresh after recovery installs a generation and returns `changed=true`, count 3.
3. Same fingerprint returns `changed=false` and does not replace the manager/generation.
4. Changed catalog replaces the generation exactly once.
5. Failed refresh retains the old profiles and provider.
6. A refresh blocked in fetch and a concurrent settings update serialize without profile/provider mismatch.
7. Dispose clears the refresh timer; timer is unref’ed.

- [ ] **Step 3: Run focused runtime tests and verify they fail**

```bash
npm test -- tests/runtime-sandbox-controller.test.ts tests/sandbox-runtime-controller.test.ts
```

Expected: FAIL because generation preparation is still local-config-only and there is no refresh API/status.

- [ ] **Step 4: Add generation catalog metadata and Desktop capability**

Store cloned `catalog` info on `SandboxGeneration`. `catalogInfo()` returns the current generation’s non-secret metadata. `desktopEnabled()` returns whether the current generation owns a Desktop resolver. Keep existing generation pin/drain/cleanup behavior unchanged.

- [ ] **Step 5: Convert catalog entries to profiles during AIOS preparation**

In `aios-template-catalog.ts`, export:

```ts
export function sandboxProfilesFromAiosCatalog(
  entries: readonly AiosTemplateCatalogEntry[],
): SandboxProfile[];
```

Map capabilities exactly as follows:

```ts
const capabilities = entry.envType === 'browser'
  ? ['shell', 'browser', 'screenshot', 'navigate', 'click', 'type']
  : ['python', 'node', 'shell'];
if (entry.runtimeRole === 'sandbox-diag') capabilities.push('diagnostics');
```

Set `id/template=templateId`, `name`, description, image, `desktop=envType==='browser'`, and `privileged=runtimeRole==='sandbox-diag'`.

- [ ] **Step 6: Make `prepareGeneration()` catalog-first for AIOS**

For `cfg.aios`:

```text
AiosTemplateCatalog.load()
→ sandboxProfilesFromAiosCatalog(snapshot.templates)
→ new Set(snapshot.templates.map(t => t.templateId))
→ E2bProvider with AIOS allowedTemplateIds
→ SandboxManager
→ role-aware spec resolver
→ CommandDesktopProvider when any browser profile exists
→ SandboxGenerationInput.catalog
```

For non-AIOS modes, keep `resolveSandboxProfiles`, official E2B/OpenSandbox/Local providers, user-home behavior, and current Desktop providers.

The spec resolver must select profiles using `ctx.role`. Browser resolver must call `selectBrowserProfile(profiles, ctx.role)` and throw `当前身份没有可用的浏览器沙箱模板` instead of falling back to code.

- [ ] **Step 7: Add startup degradation and public catalog state**

Catch catalog preparation failure only for enabled persisted/bootstrap AIOS configuration. Preserve settings and Key-set state, do not commit a generation, and publish:

```ts
runtime: {
  enabled: false,
  mode: 'aios_lifecycle',
  status: 'catalog_unavailable',
  templateCount: 0,
}
```

Do not swallow preparation failures during a page settings update: those must still abort before persistence and keep the previous generation.

- [ ] **Step 8: Add serialized manual/background refresh**

Implement one internal refresh function that runs inside `serializeSandboxUpdate`. It re-checks current settings after acquiring the queue, prepares an AIOS generation, compares fingerprints, disposes an unchanged candidate, commits only on change, and updates `lastSuccessfulRefreshAt/templateCount` after success.

Start a 60-second interval only while enabled AIOS settings are current. Call `unref()`, clear it on mode switch/disable/dispose, and send background failures only to sanitized logs while retaining the active generation.

- [ ] **Step 9: Register tools from generation capability**

Change `syncSandboxTools()` to:

```ts
for (const tool of buildSandboxProfileTools(
  sandboxController,
  (ctx) => sandboxController.profileDefinitions(ctx),
)) tools.register(tool);

if (sandboxController.desktopEnabled()) {
  for (const tool of buildBrowserTools((ctx) => sandboxController.desktop(ctx))) tools.register(tool);
}
```

Do not use `sandboxCfg.desktop` to decide whether an AIOS browser catalog is available.

- [ ] **Step 10: Run runtime tests**

```bash
npm test -- tests/runtime-sandbox-controller.test.ts tests/sandbox-runtime-controller.test.ts tests/aios-e2b.test.ts
npm run typecheck
```

Expected: PASS; startup survives catalog failure, refresh is atomic, and browser tools appear for valid browser templates.

- [ ] **Step 11: Record the review checkpoint**

Run `git diff --check`. Suggested commit boundary, only if later authorized: `feat: refresh AIOS template generations`.

---

### Task 7: Expose role-filtered profiles and manual refresh over HTTP

**Files:**
- Modify: `src/server/http.ts:206-250,1083-1086,1220-1262`
- Test: `tests/http.test.ts`

**Interfaces:**
- Consumes: `Runtime.sandboxProfilesFor(ctx)` and `Runtime.refreshSandboxTemplates()`.
- Produces:

```text
GET  /v1/sandboxes
POST /v1/settings/sandbox/refresh-templates
```

The refresh response extends the normal settings body with:

```json
{
  "refresh": {
    "changed": true,
    "template_count": 3
  }
}
```

- [ ] **Step 1: Write failing role-filtering tests**

Create reader and diagnostic profiles in the runtime fixture. Authenticate as `user`, `tenant_admin`, and `platform_admin`; assert only the platform administrator receives the diagnostic profile from `GET /v1/sandboxes`.

Also call `/v1/sandbox/run-command` with `profile: 'diag-id'` as a normal user and assert the request fails without invoking the provider/tool backend.

- [ ] **Step 2: Write failing refresh endpoint tests**

Verify:

- unauthenticated request returns 401;
- `user` and `tenant_admin` return 403;
- `platform_admin` calls `refreshSandboxTemplates` once and receives `changed/template_count`;
- unavailable Runtime returns 503;
- catalog failure returns a sanitized 502/500 response that does not include Key, response body, or authentication header;
- audit detail contains only mode, result, changed flag, and count.

- [ ] **Step 3: Run focused HTTP tests and verify they fail**

```bash
npm test -- tests/http.test.ts -t 'sandbox profiles|refresh templates'
```

Expected: FAIL because the routes do not use caller-aware profiles and refresh does not exist.

- [ ] **Step 4: Return caller-aware profiles**

Change the Sandbox route to:

```ts
profiles: rt.sandboxProfilesFor?.(ctx) ?? rt.sandboxProfiles ?? [],
```

Do not expose the platform-admin fallback from any role-aware runtime implementation.

- [ ] **Step 5: Add catalog fields to settings DTO**

Extend Runtime/HTTP `runtime` state with optional `templateCount` and `lastSuccessfulRefreshAt`. Serialize them as `template_count` and `last_successful_refresh_at`; never serialize fingerprint, Key, request headers, or raw catalog payload.

- [ ] **Step 6: Add the platform-admin refresh route**

After authentication, require `tenant:manage` and explicitly require `ctx.role === 'platform_admin'`. Call Runtime refresh and return the settings body plus refresh result. Convert unsupported mode/disabled runtime to 409 and remote catalog failure to a sanitized 502 message such as `AIOS 模板目录刷新失败`.

Record an audit event:

```ts
{
  kind: 'sandbox',
  action: 'sandbox-templates-refreshed',
  tenantId: 'default',
  detail: { mode: 'aios_lifecycle', changed, templateCount },
}
```

- [ ] **Step 7: Run HTTP tests**

```bash
npm test -- tests/http.test.ts
npm run typecheck
```

Expected: PASS; ordinary users cannot discover or invoke diagnostic templates.

- [ ] **Step 8: Record the review checkpoint**

Run `git diff --check`. Suggested commit boundary, only if later authorized: `feat: expose authorized sandbox catalog APIs`.

---

### Task 8: Render dynamic template and catalog metadata in React

**Files:**
- Modify: `web/src/types.ts:145-156,313-342`
- Modify: `web/src/App.tsx:4345-4413,4601-4794`
- Test: `tests/frontend.test.ts`

**Interfaces:**
- Consumes:

```ts
export interface SandboxProfileSummary {
  id: string;
  name: string;
  template?: string;
  description: string;
  envType: 'code' | 'browser';
  runtimeRole: 'sandbox-reader' | 'sandbox-diag';
  image?: string;
  desktop: boolean;
  privileged: boolean;
  capabilities: string[];
  timeoutMs?: number;
}
```

- Produces: template cards keyed by `id`, catalog status text, and a platform-admin refresh action.

- [ ] **Step 1: Write failing frontend source-contract tests**

Add assertions that `App.tsx`:

```ts
expect(app).toContain('key={profile.id}');
expect(app).toContain('profile.template');
expect(app).toContain('profile.envType');
expect(app).toContain('profile.runtimeRole');
expect(app).toContain('特权诊断');
expect(app).toContain("'/v1/settings/sandbox/refresh-templates'");
```

Keep existing assertions that browser preview uses `/v1/browser/stream` and `/v1/browser/screenshot`, and does not add noVNC controls.

- [ ] **Step 2: Run the focused frontend test and verify it fails**

```bash
npm test -- tests/frontend.test.ts -t 'sandbox|browser preview'
```

Expected: FAIL because cards use `name` and settings have no catalog refresh action.

- [ ] **Step 3: Extend frontend DTO types**

Add the profile fields above. Extend Sandbox settings runtime with:

```ts
status?: 'disabled' | 'active' | 'catalog_unavailable' | 'refreshing' | string;
template_count?: number;
last_successful_refresh_at?: string;
```

- [ ] **Step 4: Render all profile metadata safely**

Use `profile.id` as the React key. Show name, description, template ID, image, env type, Runtime Role, and capabilities as normal React text nodes. Use labels:

- browser: `浏览器`;
- diagnostic: `特权诊断`;
- code: `代码`.

Do not use `dangerouslySetInnerHTML`.

- [ ] **Step 5: Update the AIOS settings help and catalog status**

Replace the fixed-code hint with: `模板由 AIOS 目录动态加载；browser 模板接入现有截图预览，sandbox-diag 仅平台管理员可见可用。`

Store the returned `runtime` object alongside settings info. Render status, template count, and last successful refresh time. For `catalog_unavailable`, show a clear warning without remote error bodies.

- [ ] **Step 6: Add manual refresh UI**

When mode is enabled `aios_lifecycle`, show `刷新模板` next to save. POST an empty object to `/v1/settings/sandbox/refresh-templates`, disable the button while busy, update runtime state from the response, and report whether the catalog changed.

- [ ] **Step 7: Run frontend tests and build**

```bash
npm test -- tests/frontend.test.ts
npm --prefix web run build
```

Expected: PASS; the existing screenshot-refresh iframe remains the browser preview implementation.

- [ ] **Step 8: Record the review checkpoint**

Run `git diff --check`. Suggested commit boundary, only if later authorized: `feat: show AIOS sandbox templates in UI`.

---

### Task 9: Update documentation and run full regression verification

**Files:**
- Modify: `docs/DESIGN-aios-e2b-integration.md:21-31,95-110`
- Verify both repositories.

**Interfaces:**
- Consumes: completed implementation from Tasks 1-8.
- Produces: updated operator contract and a recorded verification result without credentials.

- [ ] **Step 1: Update the integration document**

Replace statements that AIOS is fixed to `code-interpreter` and has no Desktop support. Document:

- same-key `GET /templates` catalog discovery;
- optional E2B `aios` extension;
- reader/diagnostic visibility rules;
- generation-owned allowlist and fingerprint;
- 60-second refresh plus manual refresh endpoint;
- command-driven localhost CDP and screenshot-refresh preview;
- startup `catalog_unavailable` behavior;
- no native platform Token/noVNC/CDP exposure.

- [ ] **Step 2: Run AIOS full tests**

From `/home/opt/develop/aicoding/ai-sandbox/aios-sandbox-server`:

```bash
go test ./... -count=1
```

Expected: PASS. If unrelated packages require unavailable external infrastructure, record the exact package/error and still require `go test ./internal/e2b -count=1` to pass.

- [ ] **Step 3: Run AIOP focused Sandbox regressions**

From `/home/opt/develop/aicoding/aiop`:

```bash
npm test -- tests/aios-template-catalog.test.ts tests/aios-e2b.test.ts tests/e2b.test.ts tests/command-desktop.test.ts tests/sandbox-settings.test.ts tests/sandbox-runtime-controller.test.ts tests/runtime-sandbox-controller.test.ts tests/http.test.ts tests/frontend.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run AIOP full static and test verification**

```bash
npm run typecheck
npm test
npm --prefix web run build
git diff --check
```

Expected: all commands PASS. Do not interpret a skipped test as executed coverage; report it separately.

- [ ] **Step 5: Scan changed content for credential leakage**

Inspect only changed/staged text and verify it contains no complete Key, `X-API-KEY` value, secret payload, or previously exposed unrelated LLM credential. Do not query or print database secrets.

- [ ] **Step 6: Review cross-repository compatibility**

Confirm from diffs and runtime tests:

1. AIOS standard E2B fields and top-level shapes are unchanged.
2. Standard E2B SDK calls receive no AIOS placement or catalog metadata.
3. AIOS create uses only a catalog `templateID` plus saved structured placement.
4. normal users cannot list/use `sandbox-diag`.
5. browser actions stay inside Lifecycle `/commands` and localhost CDP.
6. catalog refresh never persists catalog data or mutates credential targets.

- [ ] **Step 7: Prepare runtime verification without deploying**

Document the outward-facing verification sequence, but do not execute deployment without fresh authorization:

```text
AIOS /templates returns browser + code-interpreter + netdig with aios metadata
→ AIOP platform_admin sees 3 profiles
→ ordinary user sees reader profiles only
→ code template executes command/code/file operations
→ browser template opens screenshot preview and supports navigate/click/type/url/screenshot
→ ordinary user diagnostic request is rejected
→ platform_admin diagnostic request succeeds when explicitly selected
→ every temporary sandbox is deleted
```

Never print the complete Key during this verification.

- [ ] **Step 8: Final review checkpoint**

Report modified files, exact test/build results, any skipped live deployment verification, and suggested separate commits for AIOS and AIOP. Do not commit or push until explicitly requested.
