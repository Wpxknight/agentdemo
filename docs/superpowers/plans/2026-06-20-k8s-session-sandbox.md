# K8s Session Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenSandbox code execution and browser operations reuse one Kubernetes sandbox per AIOP session.

**Architecture:** Add an OpenSandbox desktop provider that depends on the existing `SandboxManager` instead of creating its own sandbox. Runtime wires this provider only for `sandbox.provider = "opensandbox"` and `sandbox.desktop = true`.

**Tech Stack:** TypeScript, Vitest, OpenSandbox SDK, existing AIOP `SandboxManager`, existing browser tool HTTP endpoints.

---

### Task 1: Document The Shared Session Sandbox Design

**Files:**
- Create: `docs/superpowers/specs/2026-06-20-k8s-session-sandbox-design.md`
- Create: `docs/superpowers/plans/2026-06-20-k8s-session-sandbox.md`

- [ ] **Step 1: Write the design spec**

Create `docs/superpowers/specs/2026-06-20-k8s-session-sandbox-design.md` with sections for goal, scope, architecture, data flow, runtime behavior, deployment, and testing.

- [ ] **Step 2: Write this implementation plan**

Create `docs/superpowers/plans/2026-06-20-k8s-session-sandbox.md` with concrete TDD tasks for tests, implementation, runtime wiring, deployment docs, and verification.

- [ ] **Step 3: Commit the docs**

Run:

```bash
git add docs/superpowers/specs/2026-06-20-k8s-session-sandbox-design.md docs/superpowers/plans/2026-06-20-k8s-session-sandbox.md
git commit -m "docs: design k8s session sandbox browser support"
```

### Task 2: Prove OpenSandbox Browser Tools Reuse The Session Sandbox

**Files:**
- Modify: `tests/sandbox.test.ts`
- Create: `src/sandbox/opensandbox-desktop.ts`

- [ ] **Step 1: Write the failing provider reuse test**

Add a test that creates a mock `SandboxProvider`, wraps it in `SandboxManager`, runs `sbx__run_code`, creates an OpenSandbox desktop handle for the same key, runs `launch`, and expects the provider `create` method to have been called once.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/sandbox.test.ts
```

Expected: fail because `../src/sandbox/opensandbox-desktop.js` does not exist.

- [ ] **Step 3: Implement the OpenSandbox desktop provider**

Create `src/sandbox/opensandbox-desktop.ts` implementing `DesktopProvider` and `DesktopHandle`. The provider stores a `SandboxManager`, resolves handles with `manager.get({ key: spec.key, timeoutMs: spec.timeoutMs })`, starts Chrome inside the sandbox with `runCommand`, and runs sandbox-local CDP helper scripts for browser actions.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test -- tests/sandbox.test.ts
```

Expected: pass.

### Task 3: Wire OpenSandbox Browser Tools In Runtime

**Files:**
- Modify: `tests/auth.test.ts`
- Modify: `src/runtime.ts`

- [ ] **Step 1: Write the failing runtime registration test**

Add a test that parses config with `sandbox.enabled = true`, `sandbox.provider = "opensandbox"`, and `sandbox.desktop = true`, builds runtime, and expects `desktop_stream_url`, `browser_navigate`, and `browser_screenshot` to be registered.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/auth.test.ts
```

Expected: fail because runtime currently skips OpenSandbox desktop/browser tools.

- [ ] **Step 3: Update runtime wiring**

Import `OpenSandboxDesktopProvider` in `src/runtime.ts`. When `config.sandbox.desktop` is true and provider is `opensandbox`, instantiate it with the existing `SandboxManager`. Keep local and E2B paths unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test -- tests/auth.test.ts
```

Expected: pass.

### Task 4: Update Deployment Documentation

**Files:**
- Modify: `config.example.jsonc`
- Modify: `deploy/opensandbox/README.md`
- Modify: `deploy/k8s/configmap.yaml`

- [ ] **Step 1: Update the example config**

Document that OpenSandbox browser mode needs `desktop: true` and a browser-capable image such as `aiop/opensandbox-browser:latest`.

- [ ] **Step 2: Update OpenSandbox deployment docs**

Add a browser section explaining that the configured image must include Node.js and Chromium, and that code plus browser operations share the same session sandbox.

- [ ] **Step 3: Update the k8s ConfigMap example**

Set the sample sandbox config to an enabled OpenSandbox configuration with `desktop: true` and in-cluster OpenSandbox service domain.

### Task 5: Full Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run all tests**

Run:

```bash
npm test
```

Expected: all test files pass.

- [ ] **Step 3: Review git diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files changed.

- [ ] **Step 4: Commit implementation**

Run:

```bash
git add src/sandbox/opensandbox-desktop.ts src/runtime.ts tests/sandbox.test.ts tests/auth.test.ts config.example.jsonc deploy/opensandbox/README.md deploy/k8s/configmap.yaml
git commit -m "feat: run opensandbox browser tools in session sandbox"
```
