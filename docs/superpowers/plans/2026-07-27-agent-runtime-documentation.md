# Agent Runtime Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update AIoP architecture documentation so Agent Runtime, Kernel, Agent Loop, Agent Core, open-source mechanisms, and self-developed platform capabilities have explicit and consistent ownership labels.

**Architecture:** Treat `docs/design/02-agent-runtime.md` as the authoritative detailed description. Keep the system overview and adjacent design documents concise, link them to the authoritative document, and synchronize terminology with the code walkthrough.

**Tech Stack:** Markdown, Mermaid, TypeScript source references, Git link and whitespace checks.

## Global Constraints

- Source and tests override existing documentation.
- Use exactly three ownership labels: `开源引用`、`自研`、`混合封装`.
- Do not describe LangGraph as the provider of the full AIoP Agent Runtime.
- Do not modify runtime code, dependencies, configuration, or database schema.
- Preserve the current Chinese documentation style and relative links.

---

### Task 1: Rebuild the Agent Runtime design document

**Files:**
- Modify: `docs/design/02-agent-runtime.md`

**Interfaces:**
- Consumes: `AgentRuntime`, `AgentKernel`, `RunAgentOptions`, `runAgent`, `LangGraphAgentKernel`, `createAgentGraph`, `AgentRunCoordinator`, `MysqlCheckpointSaver`.
- Produces: the authoritative ownership and control-flow description referenced by adjacent design documents.

- [x] **Step 1: Add a terminology and ownership matrix**

Document Runtime, Kernel, Agent Loop, Agent Core services, Checkpoint, Run Store, Interaction, and Tool Ledger with exact ownership labels and source paths.

- [x] **Step 2: Document the complete Legacy execution path**

Describe `AgentRuntime.run()` → `LegacyAgentKernel.run()` → `runAgent()` → Model Gateway → Tool Broker, including pending messages, compaction, retry, tool-result feedback, termination, and result assembly.

- [x] **Step 3: Document the complete LangGraph execution path**

Separate LangGraph-provided primitives from AIoP-defined graph state, nodes, routing, durable interaction bridge, lifecycle observation, and MySQL persistence.

- [x] **Step 4: Clarify persistence responsibilities**

Compare Agent Run binding, Run lease/events, LangGraph Checkpoint, durable interaction, session messages, and Tool Ledger in one table.

- [x] **Step 5: Add migration and alternative guidance**

Record where prebuilt agents, official Checkpointers, workflow engines, policy engines, and observability systems can reduce custom work without claiming drop-in replacement.

### Task 2: Synchronize adjacent architecture documents

**Files:**
- Modify: `docs/design/01-system-overview.md`
- Modify: `docs/design/03-model-and-context.md`
- Modify: `docs/design/04-tools-skills-mcp.md`

**Interfaces:**
- Consumes: the ownership terms and boundaries defined by Task 1.
- Produces: consistent system-level, model-level, and tool-level summaries.

- [x] **Step 1: Update the system overview ownership matrix**

Show LangGraph as an open-source Kernel mechanism while retaining `AgentRuntime`, graph definition, Run coordination, Tool Broker, and Store as self-developed or hybrid components.

- [x] **Step 2: Update model and context ownership**

Distinguish open-source model SDKs and LangChain types from AIoP message types, adapters, Model Gateway, context compaction, prompt, retry, and usage aggregation.

- [x] **Step 3: Update tool execution ownership**

State that both Legacy and LangGraph paths call the same self-developed Tool Broker and cannot bypass Policy, Approval, Hook, Ledger, or registry dispatch.

### Task 3: Synchronize the code walkthrough

**Files:**
- Modify: `docs/guide/code-walkthrough.md`

**Interfaces:**
- Consumes: the authoritative concepts from Task 1.
- Produces: a beginner-friendly reading path with the same ownership language.

- [x] **Step 1: Add an ownership legend near the Agent Runtime walkthrough**

Explain `开源引用`、`自研`、`混合封装` before the dual-Kernel section.

- [x] **Step 2: Rewrite Legacy and LangGraph descriptions**

Call `core.ts` the self-developed Legacy Agent Loop and shared service contract source, and identify LangGraph graph execution as hybrid rather than fully external.

- [x] **Step 3: Add a practical comparison table**

Show which files to modify for loop behavior, graph topology, model invocation, tool security, Run lifecycle, and persistence.

### Task 4: Verify documentation integrity

**Files:**
- Verify: `docs/design/01-system-overview.md`
- Verify: `docs/design/02-agent-runtime.md`
- Verify: `docs/design/03-model-and-context.md`
- Verify: `docs/design/04-tools-skills-mcp.md`
- Verify: `docs/guide/code-walkthrough.md`

**Interfaces:**
- Consumes: all updated documentation.
- Produces: evidence that the documentation is internally consistent and grounded in the current source tree.

- [x] **Step 1: Scan terminology and ownership labels**

Run:

```bash
rg -n "Agent Runtime|AgentKernel|Agent Loop|Agent Core|LangGraph|Legacy|开源引用|自研|混合封装" docs/design docs/guide/code-walkthrough.md
```

- [x] **Step 2: Check source references and relative links**

Run a local script that extracts Markdown links from the five changed files and verifies relative filesystem targets exist.

- [x] **Step 3: Check placeholders and whitespace**

Run:

```bash
rg -n "TBD|TODO|待补充|待完善" docs/design docs/guide/code-walkthrough.md
git diff --check
```

- [x] **Step 4: Review final diff against the approved design**

Confirm every explicit scope item in `docs/superpowers/specs/2026-07-27-agent-runtime-documentation-design.md` has corresponding text in the changed documents.
