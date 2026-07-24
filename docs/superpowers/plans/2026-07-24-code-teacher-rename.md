# Code Teacher Skill Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `teaching-code` skill to `code-teacher` without leaving duplicate discovery entries or breaking the running course viewer.

**Architecture:** Treat folder name, skill frontmatter, UI metadata, tests, and documentation references as one identity contract. Move the directory once tests express the new identity, then restart the existing server from the new location.

**Tech Stack:** Codex Agent Skills, Markdown/YAML, Node.js tests and HTTP server.

## Global Constraints

- The final skill directory and frontmatter name are exactly `code-teacher`.
- No compatibility symlink or wrapper named `teaching-code` remains.
- The current teaching URL, port, key, course data, and progress remain unchanged.
- All Git commits include `Co-authored-by: AIOS <noreply@bocloud.com>`.

---

### Task 1: Establish the new identity contract

**Files:**
- Modify: `/home/lb/.codex/skills/teaching-code/tests/teaching-server.test.mjs`

- [x] Add a test asserting the skill directory basename, frontmatter name, title, and `$code-teacher` default prompt.
- [x] Run the focused test and verify it fails because the current identity is `teaching-code`.

### Task 2: Rename the skill and all durable references

**Files:**
- Move: `/home/lb/.codex/skills/teaching-code` → `/home/lb/.codex/skills/code-teacher`
- Modify: `/home/lb/.codex/skills/code-teacher/SKILL.md`
- Modify: `/home/lb/.codex/skills/code-teacher/agents/openai.yaml`
- Modify: `/home/lb/.codex/skills/code-teacher/assets/vendor/THIRD_PARTY_NOTICES.md`
- Modify: `/opt/develop/aicoding/aiop/docs/superpowers/specs/*.md`
- Modify: `/opt/develop/aicoding/aiop/docs/superpowers/plans/*.md`

- [x] Move the directory without copying or retaining an alias.
- [x] Update identity fields and every active old-name reference.
- [x] Run the focused identity test and verify it passes.

### Task 3: Validate and restart

- [x] Run `quick_validate.py /home/lb/.codex/skills/code-teacher`.
- [x] Run `node --test /home/lb/.codex/skills/code-teacher/tests/teaching-server.test.mjs`.
- [x] Validate all AIoP lessons with the renamed validator path.
- [x] Confirm the old directory is absent and scan for stale active references.
- [x] Restart port 4178 with the existing key from the renamed server script.
- [x] Verify live state reports 17 chapters and a pending chapter returns HTTP 200.
