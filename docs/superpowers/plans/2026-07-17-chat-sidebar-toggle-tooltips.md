# Chat Sidebar Toggle Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add state-aware hover and keyboard-focus descriptions to the smart-assistant header buttons that toggle the left session sidebar and right sandbox sidebar.

**Architecture:** Pass the existing `historyOpen` and `previewOpen` layout state into `PrototypeChatHeader`, and reuse the shadcn/Radix Tooltip primitives already imported by `App.tsx`. Compute each button label from those booleans, then use the same string for Tooltip content and `aria-label`.

**Tech Stack:** React 19, TypeScript, shadcn/Radix Tooltip, Vitest source-contract tests, Playwright deployment QA.

---

### Task 1: State-aware sidebar toggle tooltips

**Files:**
- Modify: `web/src/App.tsx`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Write the failing source-contract test**

Add a test asserting that `PrototypeChatHeader` defines left/right state-aware labels, wraps both toggle buttons in `Tooltip`, uses `TooltipTrigger asChild`, renders `TooltipContent`, and applies the same labels to `aria-label`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/frontend.test.ts -t "shows state-aware sidebar toggle help"`

Expected: FAIL because both buttons currently have fixed `aria-label` values and no header Tooltip content.

- [ ] **Step 3: Implement the minimal tooltip behavior**

Inside `PrototypeChatHeader`, define:

```tsx
const historyToggleLabel = props.historyOpen ? '收起左侧会话栏' : '展开左侧会话栏';
const previewToggleLabel = props.previewOpen ? '收起右侧沙箱栏' : '展开右侧沙箱栏';
```

Add `historyOpen` and `previewOpen` to the component props and pass them from `PrototypeChatLayout`.

Wrap each button with the existing Tooltip primitives:

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <button type="button" onClick={...} aria-label={historyToggleLabel}>...</button>
  </TooltipTrigger>
  <TooltipContent side="bottom">{historyToggleLabel}</TooltipContent>
</Tooltip>
```

Use the equivalent `previewToggleLabel` for the right sidebar button.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/frontend.test.ts -t "shows state-aware sidebar toggle help"`

Expected: PASS.

### Task 2: Eight-session history pages

**Files:**
- Modify: `web/src/App.tsx`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Change the existing pagination contract test to require `const SESSION_PAGE_SIZE = 8;` and run it to verify RED.**
- [ ] **Step 2: Change `SESSION_PAGE_SIZE` from 10 to 8 so API limits, offsets, page numbers, and page counts all use eight records.**
- [ ] **Step 3: Run the focused pagination test and verify GREEN.**

### Task 3: Full verification and deployment

**Files:**
- No additional source files expected.

- [ ] **Step 1: Run typecheck and full tests**

Run: `npm run typecheck && npm test`

Expected: exit code 0 with zero failed tests.

- [ ] **Step 2: Build the frontend after tests**

Run: `npm run build --prefix web && test "$(wc -c < web/dist/assets/app.js)" -gt 100000`

Expected: Vite build succeeds and `app.js` is not the test placeholder.

- [ ] **Step 3: Build and deploy the development image**

Run:

```bash
docker build -f /tmp/aiop-web-offline.Dockerfile -t aiop-web:dev .
kubectl -n aiop-dev rollout restart deploy/aiop-server
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
```

Expected: the deployment reaches 1/1 ready.

- [ ] **Step 4: Run Playwright interaction QA**

Verify at `http://192.168.10.108:30083` that hovering and focusing each button shows its current state-aware description, clicking changes the description, desktop/mobile layouts do not overflow, and the console has no errors.

- [ ] **Step 5: Confirm the work remains uncommitted**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and all changes remain uncommitted as requested.
