# AIoP Agent Run Center and Recovery Design

## 1. Goal

Build a tenant-safe Run Center on top of the existing LangGraph runtime so operators can inspect every agent run, understand its node timeline, cancel active work, and safely resume recoverable work after a process or node failure.

The feature must reuse the existing `agent_runs`, LangGraph checkpoints, durable interactions, and tool execution ledger. It must not create a competing run state source or replay a completed side effect.

## 2. Scope

### Included in phase one

- Persist run lifecycle: `queued`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`, `recovery_required`.
- Persist a node/event timeline for `prepare`, `model`, `tools`, interaction waits, recovery, cancellation, and terminal outcomes.
- Record step count, token usage, current node, error summary, start/update/finish timestamps.
- Acquire and renew a database lease for each executing run.
- Fence stale owners before model calls and tool execution.
- List and filter runs through REST APIs.
- Return a run detail assembled from lifecycle, timeline, interactions, and tool ledger records.
- Request cancellation durably so another replica can observe it.
- Resume failed or recovery-required LangGraph runs from their latest checkpoint.
- Add a Run Center page to the existing React management UI.
- Preserve existing SSE chat behavior and session message persistence.

### Excluded from phase one

- Editing checkpoint state before replay.
- Forking one run into multiple alternative branches.
- Re-running a completed run with a different model or prompt.
- A visual graph editor.
- Automatic compensation of arbitrary external side effects.

Those capabilities require a separate time-travel design because they change execution semantics and can duplicate side effects.

## 3. Architecture

```text
Chat / Scheduler / Recovery API
              |
              v
       AgentRunCoordinator
       |       |        |
       |       |        +-- cancel flag / lease heartbeat
       |       +----------- lifecycle + timeline
       +------------------- fencing guard
              |
              v
         AgentRuntime
              |
              v
       LangGraphAgentKernel
      prepare -> model <-> tools
              |
      MySQL Checkpointer + Tool Ledger

Run Center REST API -> Store read model -> React Run Center
```

`AgentRunCoordinator` owns execution coordination only. LangGraph remains the graph engine; `Store` remains the durable business record; the HTTP layer remains responsible for authentication and transport.

## 4. Persistent Model

Migration `0014_agent_run_center.sql` extends `agent_runs` with:

- `status VARCHAR(32)`
- `current_node VARCHAR(64)`
- `step_count INT`
- token counters for input, output, cache read, and cache creation
- `error_message TEXT`
- `started_at`, `updated_at`, `completed_at`
- `cancel_requested_at`
- `lease_owner VARCHAR(128)`
- `lease_token BIGINT`
- `lease_expires_at DATETIME(3)`

New table `agent_run_events` contains an append-only timeline:

- tenant and run identity
- monotonic event ID
- event type
- optional node name
- status
- JSON detail without model credentials or raw secrets
- event timestamp

The existing tables retain their responsibilities:

- `langgraph_checkpoints`: executable graph state.
- `agent_interactions`: approval/question/plan state.
- `agent_tool_executions`: tool idempotency and recovery safety.
- `messages`: committed conversation history.

## 5. Lease and Fencing Rules

1. A run owner uses a process-unique owner ID and acquires a monotonically increasing lease token.
2. Acquisition succeeds when no owner exists, the previous lease expired, or the same owner renews it.
3. A heartbeat renews the lease while the run executes.
4. Before every model node and tool call, the coordinator verifies owner and token.
5. A stale owner receives `AgentRunLeaseLostError` and may not call the model or dispatch tools.
6. Terminal transitions clear the lease.
7. Cancellation is a durable timestamp, not only an in-memory `AbortController` signal.
8. The existing local active-run abort path remains for low-latency cancellation; the durable flag covers other replicas and restarts.

## 6. Lifecycle and Recovery

Normal execution transitions:

```text
queued -> running -> waiting -> running -> succeeded
                  \-> failed
                  \-> recovery_required
                  \-> cancelled
```

- LangGraph interrupts set the run to `waiting` and append an interaction event.
- Resolving an interaction moves the same run back to `running`.
- Unexpected model or node failures set `failed`.
- Tool ledger uncertainty sets `recovery_required`; it is never automatically retried.
- User cancellation sets `cancel_requested_at`; the active owner stops at the next guard and records `cancelled`.

Recovery is allowed only when:

- the run belongs to the authenticated tenant and permitted user scope;
- kernel is `langgraph` and the registered graph version still exists;
- status is `failed` or `recovery_required`;
- no unexpired lease is held by another owner;
- no tool execution remains `started` or `unknown` unless an administrator has resolved it to a safe state.

Recovery invokes the graph with the existing `thread_id` and no new initial input, causing LangGraph to continue from the latest committed checkpoint. Tool ledger reuse prevents completed tool calls from executing twice.

## 7. API

All endpoints require authentication. Platform and tenant administrators may inspect tenant runs; normal users may inspect only their own runs.

- `GET /v1/agent/runs`
  - filters: `status`, `sessionId`, `limit`, `offset`
  - returns summaries and pagination metadata.
- `GET /v1/agent/runs/:runId`
  - returns run metadata, timeline, pending interactions, and tool executions.
- `POST /v1/agent/runs/:runId/cancel`
  - records a durable cancellation request and aborts the local owner when present.
- `POST /v1/agent/runs/:runId/resume`
  - validates recovery safety, acquires a lease, and starts background checkpoint recovery.

Mutation endpoints use existing confirmation UX and return `409` for invalid state transitions or an active lease conflict.

## 8. UI

Add a `runs` management page with:

- status counters and filters;
- paginated run table;
- status, graph version, session, user, current node, steps, token usage, and duration;
- detail panel with node timeline;
- interaction and tool ledger tabs;
- cancel action for queued/running/waiting runs;
- resume action for failed/recovery-required runs;
- link back to the related chat session.

The page polls while any visible run is non-terminal. It does not require a second streaming protocol.

## 9. Error Handling and Security

- Error summaries are persisted after credential redaction and length limiting.
- Timeline payloads contain structured metadata, not raw model prompts, API keys, authorization headers, or full tool results.
- Tenant and user authorization is enforced in Store queries, not only in React.
- Resume and cancel are compare-and-set state transitions.
- A lease loss is reported explicitly and never triggers automatic duplicate execution.
- `recovery_required` requires human inspection when a tool outcome is uncertain.

## 10. Testing

- Store contract tests for lifecycle, pagination, events, lease acquisition, renewal, expiry, fencing, cancellation, and authorization.
- Agent coordinator tests with fake clocks and competing owners.
- LangGraph tests proving node events and checkpoint resume.
- HTTP tests for list/detail/cancel/resume and RBAC.
- React build plus UI behavior tests through existing frontend verification tooling.
- MySQL migration and K8s smoke tests proving a real run appears in Run Center and binds to LangGraph.

## 11. Delivery and Rollback

Implementation estimate: 3-5 developer days including backend, UI, tests, and K8s validation.

Deployment remains compatible with existing runs because migration columns have defaults and the graph version stays `aiop-agent@v1`.

Rollback procedure:

1. Stop creating new recovery requests.
2. Roll back the application image.
3. Keep migration `0014` and its data; older code ignores the additional columns and table.
4. Do not delete checkpoints, interactions, tool ledgers, or run events during rollback.

