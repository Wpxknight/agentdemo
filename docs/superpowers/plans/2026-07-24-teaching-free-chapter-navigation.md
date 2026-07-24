# Teaching Free Chapter Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to open every generated teaching chapter while keeping browsing independent from confirmed learning progress.

**Architecture:** Keep `outline.md` statuses as presentation and progress metadata. Remove the server-side pending-state authorization check and the viewer-side disabled-button behavior; retain `state.current` as the terminal-controlled learning position.

**Tech Stack:** Node.js HTTP server, browser JavaScript/CSS, Node test runner, Markdown skill documentation.

## Global Constraints

- All generated chapters are readable regardless of `[x]`, `[>]`, or `[ ]` status.
- Clicking a chapter never changes course progress or `state.current`.
- Invalid, unknown, or missing chapter resources retain 400/404 behavior.
- Existing viewer accessibility, SSE refresh, mobile layout, previews, and copy controls remain intact.
- Temporary runtime data remains under `dist`; skill source remains under `/home/lb/.codex/skills/code-teacher`.

---

### Task 1: Make every generated chapter readable

**Files:**
- Modify: `/home/lb/.codex/skills/code-teacher/tests/teaching-server.test.mjs`
- Modify: `/home/lb/.codex/skills/code-teacher/scripts/teaching-server.mjs`

**Interfaces:**
- Consumes: `GET /api/chapters/:id`, parsed chapters from `outline.md`.
- Produces: Markdown response for every known chapter whose file exists.

- [x] **Step 1: Change the existing authorization test to require pending chapter access**

Rename the test to `serves every outlined chapter and blocks traversal`, assert `1.3` returns 200, and assert its body contains `# 1.3 下一章节`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern='serves every outlined chapter' /home/lb/.codex/skills/code-teacher/tests/teaching-server.test.mjs`

Expected: FAIL because `/api/chapters/1.3` returns 403.

- [x] **Step 3: Remove progress-based authorization**

Delete this branch from `teaching-server.mjs`:

```js
if (chapter.status === 'pending') return text(res, 403, 'Chapter not available');
```

- [x] **Step 4: Re-run the focused test and verify GREEN**

Run the Step 2 command.

Expected: PASS.

### Task 2: Make every directory entry selectable and document the contract

**Files:**
- Modify: `/home/lb/.codex/skills/code-teacher/tests/teaching-server.test.mjs`
- Modify: `/home/lb/.codex/skills/code-teacher/assets/teaching.js`
- Modify: `/home/lb/.codex/skills/code-teacher/assets/teaching.css`
- Modify: `/home/lb/.codex/skills/code-teacher/references/viewer-contract.md`
- Modify: `/home/lb/.codex/skills/code-teacher/SKILL.md`
- Modify: `/opt/develop/aicoding/aiop/dist/code-teaching-outline.md`
- Modify: `/opt/develop/aicoding/aiop/dist/code-teaching/outline.md`

**Interfaces:**
- Consumes: `state.chapters[]` with `id`, `title`, and `status`.
- Produces: clickable chapter buttons for all statuses; progress remains terminal-controlled.

- [x] **Step 1: Add failing viewer and skill contract assertions**

Add a test that requires:

```js
assert.doesNotMatch(js, /button\.disabled\s*=\s*chapter\.status\s*===\s*'pending'/);
assert.match(js, /button\.addEventListener\('click', \(\) => void selectChapter\(chapter\.id\)\)/);
assert.doesNotMatch(js, /chapter\.id === selectedId && chapter\.status !== 'pending'/);
assert.match(viewerContract, /all generated chapters.*freely accessible/is);
assert.match(skill, /browse any generated chapter/i);
assert.match(skill, /browsing.*does not.*advance.*progress/is);
```

- [x] **Step 2: Run the contract test and verify RED**

Run: `node --test --test-name-pattern='all generated chapters selectable' /home/lb/.codex/skills/code-teacher/tests/teaching-server.test.mjs`

Expected: FAIL because pending buttons are disabled and the skill promises access restrictions.

- [x] **Step 3: Implement minimal viewer changes**

In `renderDirectory()`, remove `button.disabled`, always register the click handler, and preserve status classes/markers. In `loadState()`, consider a selected chapter valid whenever its ID remains in `state.chapters`. Remove disabled-only CSS rules while preserving pending colors.

- [x] **Step 4: Update the durable skill contract**

State in `SKILL.md` that the browser may display and navigate to any generated chapter, browsing never confirms understanding, and only explicit terminal confirmation advances progress. Replace `chapter access restrictions` in `viewer-contract.md` with the free-navigation invariant. Update both AIoP outline copies so their teaching-mode description no longer claims pending chapters are hidden.

- [x] **Step 5: Run the focused contract test and verify GREEN**

Run the Step 2 command.

Expected: PASS.

### Task 3: Verify the complete skill and existing AIoP course

**Files:**
- Verify: `/home/lb/.codex/skills/code-teacher/tests/teaching-server.test.mjs`
- Verify: `/opt/develop/aicoding/aiop/dist/code-teaching/chapters/*.md`

**Interfaces:**
- Consumes: final skill source and all 17 generated lessons.
- Produces: passing test suite and validated Markdown lessons.

- [x] **Step 1: Run the complete skill test suite**

Run: `node --test /home/lb/.codex/skills/code-teacher/tests/teaching-server.test.mjs`

Expected: all tests pass with zero failures.

- [x] **Step 2: Validate every AIoP lesson**

Run:

```bash
for lesson in dist/code-teaching/chapters/*.md; do
  node /home/lb/.codex/skills/code-teacher/scripts/validate-lesson.mjs "$lesson"
done
```

Expected: every lesson reports success; command exits 0.

- [x] **Step 3: Inspect final differences**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the plan and any intentionally tracked course metadata appear in the AIoP repository. Personal skill changes are verified directly because that directory is not a Git repository.
