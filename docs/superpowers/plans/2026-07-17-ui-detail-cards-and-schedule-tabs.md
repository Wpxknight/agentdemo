# UI Detail Cards and Schedule Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine chat metrics and image attachments, make sandbox templates interactive cards with modal details, and reorganize scheduled-task details into shared forms and record-detail tabs.

**Architecture:** Keep the existing React/Vite single-page structure and reuse `ModalDialog`, `Tabs`, and current API data. Extract only the repeated scheduled-task form into a focused component; keep sandbox and attachment changes local to their existing renderers.

**Tech Stack:** React 19, TypeScript, Vite, shadcn/Radix Tabs, CSS, Vitest source-contract tests, Playwright deployment QA.

---

## File map

- `web/src/App.tsx`: shared scheduled-task form, scheduled-task tabs and run modal, sandbox template cards/modal, image attachment figure, title metric markup.
- `web/src/index.css`: compact metric typography, card/row/detail styles, image caption/delete layout, task form/Tab/run modal styling.
- `tests/frontend.test.ts`: source-contract tests for all requested UI behavior.

### Task 1: Smaller non-bold title metrics

**Files:**
- Modify: `web/src/index.css`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Write the failing typography test**

Assert that context and total-consumption values use a dedicated class, a smaller font size than the status text, and `font-weight: 400`:

```ts
expect(app).toContain('className="prototype-chat-metric"');
expect(css).toMatch(/\.prototype-chat-metric\s*\{[\s\S]*?font-size:\s*10px;[\s\S]*?font-weight:\s*400;/);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/frontend.test.ts -t "uses smaller regular-weight chat metrics"`

Expected: FAIL because metric values currently inherit the bold badge styling.

- [ ] **Step 3: Add metric classes and styles**

Render context and total-consumption segments as:

```tsx
<b className="prototype-chat-metric">上下文 {formatContextUsage(props.contextUsage)}</b>
<b className="prototype-chat-metric">总消耗 {formatTokenCount(props.totalTokens)}</b>
```

Set their font size to 10px and weight to 400 on desktop, with a 9px mobile override while preserving separator borders and no overflow.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `npm test -- tests/frontend.test.ts -t "uses smaller regular-weight chat metrics"`

Expected: PASS.

### Task 2: Sandbox template cards and modal details

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Write failing sandbox-card tests**

Assert that `SandboxPage` stores `selectedProfileId`, renders each profile as a button/card with one `sandbox-profile-row` per field, supports `onKeyDown`, opens `ModalDialog`, and uses a non-destructive privileged badge:

```ts
expect(app).toContain('const [selectedProfileId, setSelectedProfileId]');
expect(app).toContain('className="sandbox-profile-item"');
expect(app).toContain('className="sandbox-profile-row"');
expect(app).toContain('title="沙箱模板详情"');
expect(app).not.toContain('className="badge-privileged" variant="destructive"');
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/frontend.test.ts -t "renders interactive sandbox template cards"`

Expected: FAIL because cards are non-interactive and details are expanded inline.

- [ ] **Step 3: Implement selectable cards**

Add `selectedProfileId`, derive `selectedProfile`, and render cards as `button type="button"` elements. Each card has one row for environment type, runtime role, and Template ID; description and extended fields move to the modal.

- [ ] **Step 4: Implement modal details**

Reuse `ModalDialog` and show description plus Template ID, image, environment type, runtime role, domain, namespace, service account, desktop, privileged, capabilities, and timeout. Close by clearing `selectedProfileId`.

- [ ] **Step 5: Apply card and neutral badge styling**

Use responsive cards with visible hover/focus states. Keep `.badge-privileged` amber/neutral with no destructive red background or border.

- [ ] **Step 6: Run and confirm GREEN**

Run: `npm test -- tests/frontend.test.ts -t "renders interactive sandbox template cards"`

Expected: PASS.

### Task 3: Image attachment caption layout

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Write the failing attachment test**

Assert that images render through `attachment-image-card`/`figcaption`, the filename is under the image, image attachments are excluded from generic chips, and the optional remove button uses an overlay class.

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/frontend.test.ts -t "shows image attachment filenames below thumbnails"`

Expected: FAIL because images currently also render a duplicate generic chip.

- [ ] **Step 3: Implement image figures**

Split `attachments` into `images` and `files`. Render each image as:

```tsx
<figure className="attachment-image-card">
  <ZoomableImage src={file.data} alt={file.name} />
  <figcaption>{file.name}</figcaption>
  {onRemove ? <button className="attachment-image-remove" ...><Trash2 /></button> : null}
</figure>
```

Only map `files` into `.attachment-chip`.

- [ ] **Step 4: Style caption and overlay**

Use a compact image container, small muted caption with ellipsis, and a top-right circular remove button that does not cover the caption.

- [ ] **Step 5: Run and confirm GREEN**

Run: `npm test -- tests/frontend.test.ts -t "shows image attachment filenames below thumbnails"`

Expected: PASS.

### Task 4: Shared scheduled-task form

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Write failing shared-form tests**

Assert that `ScheduleTaskForm` exists, is used in both create and edit views, receives title/task/cron/preApproved values, and renders `schedule-preapproved` after cron fields.

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/frontend.test.ts -t "shares scheduled task create and edit form layout"`

Expected: FAIL because create and edit forms are duplicated and edit omits pre-approval.

- [ ] **Step 3: Add edit pre-approval state and payload**

Add `editPreApproved`, initialize it in `startEdit`, and include `preApproved: editPreApproved` in the PATCH body so edit matches create fields.

- [ ] **Step 4: Extract `ScheduleTaskForm`**

Create a controlled component accepting title, task, cron, preApproved, busy, submit/cancel callbacks, and labels. It renders identical field order and cron presets for create and edit.

- [ ] **Step 5: Fix pre-approval layout**

Style `.schedule-preapproved` as a full-width horizontal row with a fixed-size checkbox, wrapping label text, no `white-space: nowrap`, and consistent vertical alignment.

- [ ] **Step 6: Run and confirm GREEN**

Run: `npm test -- tests/frontend.test.ts -t "shares scheduled task create and edit form layout"`

Expected: PASS.

### Task 5: Scheduled-task tabs and run detail modal

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Write failing Tab/modal tests**

Assert that detail view renders Tabs with `任务详情` and `执行记录`, record rows open `ModalDialog`, inline `.schedule-run-detail` is removed, and modal includes time/status/steps/detail.

- [ ] **Step 2: Run and confirm RED**

Run: `npm test -- tests/frontend.test.ts -t "uses task detail and execution record tabs"`

Expected: FAIL because records and output are currently inline below task details.

- [ ] **Step 3: Split detail content into Tabs**

Keep action buttons/edit form inside `TabsContent value="task"`; move paginated record table into `TabsContent value="runs"`. Reset page and selected run when switching tasks.

- [ ] **Step 4: Open run detail modal from the record row**

Use `selectedRunId` only for the modal selection. Clicking a record sets the ID; closing clears it. Render time, formatted status, steps, and `<pre>` output in `ModalDialog`.

- [ ] **Step 5: Style Tabs and clickable rows**

Reuse existing sandbox tab visual language, add row hover/focus treatment, and size the result `<pre>` for readable scrolling.

- [ ] **Step 6: Run and confirm GREEN**

Run: `npm test -- tests/frontend.test.ts -t "uses task detail and execution record tabs"`

Expected: PASS.

### Task 6: Full verification and deployment

**Files:**
- No source changes expected beyond verification fixes.

- [ ] **Step 1: Run typecheck and full tests**

Run: `npm run typecheck && npm test`

Expected: exit code 0, zero failed tests.

- [ ] **Step 2: Build frontend after tests**

Run: `npm run build --prefix web && test "$(wc -c < web/dist/assets/app.js)" -gt 100000`

Expected: Vite build succeeds and the final asset is not the test placeholder.

- [ ] **Step 3: Rebuild the offline frontend development image**

Run: `docker build -f /tmp/aiop-web-offline.Dockerfile -t aiop-web:dev .`

Expected: image build succeeds without Docker Hub access.

- [ ] **Step 4: Deploy**

Run: `kubectl -n aiop-dev rollout restart deploy/aiop-server && kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s`

Expected: rollout succeeds with 1/1 ready.

- [ ] **Step 5: Playwright QA**

Verify title metric typography, sandbox template card/modal, non-red privileged badge, image caption position, task Tabs, execution-record modal, create/edit form alignment, pre-approval checkbox, desktop/mobile overflow, console health, and screenshots.

- [ ] **Step 6: Confirm uncommitted state**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; all implementation remains uncommitted.
