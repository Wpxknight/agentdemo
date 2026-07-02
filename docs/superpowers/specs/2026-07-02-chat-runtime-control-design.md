# Chat Runtime Control Design

Date: 2026-07-02

## Scope

This change improves the active chat workflow:

- Retry transient LLM connection failures, up to 10 total attempts.
- Let user corrections and attachments sent during an active run join the current agent run instead of starting a second `/v1/agent` request.
- Create a new empty session immediately and show it in the session list.
- Display current session context usage as `used/max`, for example `100K/200K`.
- Relax the default prompt so the agent asks for confirmation only for destructive, modifying, irreversible, production, or otherwise high-risk work.
- Add `/goal` mode for autonomous goal completion, while still requiring confirmation for irreversible and high-risk operations.

The work stays within the existing Node HTTP + SSE backend, Store abstraction, and React/Vite frontend.

## Decisions

1. **Running-message behavior**
   During an active run, the composer submits to a new append endpoint, not `/v1/agent`. The backend queues the message and attachments into the active run. The current model stream is not interrupted. The agent consumes queued messages at safe boundaries: before each new model turn and immediately before it would otherwise finish. If a model response is already in its final stream and no further model turn occurs, the appended message is persisted with the run and becomes available to the next user action.

2. **Retry policy**
   The backend retries only when `model.stream()` fails before emitting any stream event. Once the model has produced text, thinking, tool calls, usage, or stop events, retry is disabled for that attempt to avoid duplicated output or repeated tool work. The maximum is 10 total attempts. Retries use short capped backoff and respect the run abort signal.

3. **Session creation**
   Sessions become explicit Store records. `POST /v1/sessions` creates an empty session immediately. `appendMessage` also upserts/touches the session so existing history remains compatible. `listSessions` reads from the sessions table/map and joins or derives latest message summary.

4. **Context display**
   Model configuration gains `contextWindowTokens`; default is `200000` when absent. The server exposes session context usage from two sources:
   - Actual prompt tokens from model `usage` events when available.
   - Estimated tokens from persisted messages otherwise, using a simple text-length estimate.

   The frontend displays compact values with K suffix, such as `100K/200K`, in the chat header.

5. **Goal mode**
   `/goal <task>` is a chat command parsed by the backend. It adds goal-mode instructions to the system prompt for that run and raises the agent step budget to 50. Goal mode authorizes autonomous progress for reversible or low-risk actions, but it does not bypass policy, RBAC, production approval, or confirmation requirements for destructive and irreversible operations.

## Backend Design

### Store

Add session APIs:

- `createSession(ctx, { sessionId, title? })`
- `touchSession(ctx, sessionId, summary?)`
- `getSessionContextUsage(ctx, sessionId, maxTokens)`

MySQL adds a `sessions` table with primary key `(tenant_id, session_id)`, title, created_at, updated_at. The migration backfills records from existing distinct message sessions. MemoryStore keeps a sessions map.

`deleteSession` removes both the session record and messages. `listSessions` includes empty sessions and continues to show title, lastMessage, messageCount, and updatedAt.

### Active Runs

`ActiveAgentRun` expands from `{ abort }` to include:

- `append(message: Msg): boolean`
- an internal FIFO pending queue

`POST /v1/sessions/:id/append`:

- Authenticates the request.
- Converts text and attachments into a user `Msg`.
- If an active run exists for the session, queues the message and returns `{ queued: true }`.
- If no active run exists, appends it directly to the session history and returns `{ queued: false }`.

This live queue is process-local, matching the existing interactive approval and terminate behavior. Deployments that run multiple `aiop-server` replicas need sticky routing for interactive chat requests, or should run the interactive service as one replica until a shared realtime bus is added.

### Agent Loop

`runAgent` gains optional pending-message support:

- `drainPendingMessages?: () => Msg[] | Promise<Msg[]>`
- `maxSteps` remains the hard safety cap.

At loop boundaries, `runAgent` drains pending user messages and appends them to the in-memory message context. If pending messages arrive just as the model would finish, the agent performs another model turn instead of ending, subject to `maxSteps`.

The final `RunAgentResult.messages` includes the original task, injected user messages, assistant messages, and tool results. The caller persists these once when the run completes.

### LLM Retry

`runAgent` wraps each model turn in retry logic:

- Attempts: 10 total.
- Retry condition: thrown error before any stream event.
- No retry after any event has been emitted.
- Abort signal cancels backoff and further attempts.
- SSE emits `model_retry` for each retry attempt, but the UI does not depend on it for correctness.

### Prompt And `/goal`

Default guardrails change from "ask before any side effect" to:

- Read-only inspection, analysis, summarization, diagnostics, and reversible low-risk operations can proceed without confirmation.
- Ask before modifying, deleting, destroying, restarting, deploying, scaling, writing configuration, changing production resources, exposing secrets, or performing irreversible/high-risk operations.
- Verify after changes and report concise results.

`/goal` adds a goal-mode prompt block:

- Continue autonomously until the stated goal is complete or blocked.
- Choose reasonable next steps without asking for every low-risk action.
- Still ask before irreversible, destructive, production, privileged, or ambiguous high-risk operations.
- Stop and report when blocked by missing credentials, policy denial, repeated tool failures, or user input requirements.

## Frontend Design

### Sending While Running

`sendComposer()` checks whether the selected session has an active run. If yes:

- Render the user message immediately in the chat.
- Clear composer and attachments.
- POST to `/v1/sessions/:id/append`.
- Do not call `/v1/agent`.

The assistant bubble keeps streaming from the original SSE. If the append succeeds, the UI shows a small "已加入当前轮次" status on the user message. If it fails, the message shows an inline error and remains visible.

### New Session

`startNewSession()` calls `POST /v1/sessions` immediately. The new session becomes selected and is inserted at the top of the session list before any message is sent.

### Context Usage

Add chat-header display near run status:

`上下文 100K/200K`

The frontend updates it from:

- `GET /v1/sessions/:id/context` on session select/new session.
- SSE `usage` or `done` data after agent turns.
- Fallback estimate returned by the context endpoint.

Formatting rounds to whole K for values >= 1000 and shows `0/200K` for empty sessions.

## API Summary

New endpoints:

- `POST /v1/sessions`
  - Body: `{ sessionId?: string, title?: string }`
  - Response: `{ session: SessionSummary }`

- `POST /v1/sessions/:id/append`
  - Body: `{ task?: string, attachments?: Attachment[] }`
  - Response: `{ ok: true, queued: boolean, sessionId: string }`

- `GET /v1/sessions/:id/context`
  - Response: `{ usedTokens: number, maxTokens: number, estimated: boolean }`

Existing endpoint changes:

- `POST /v1/agent` recognizes `/goal`.
- SSE may include `model_retry` and context usage fields in `usage` or `done`.
- `GET /v1/settings/llm` includes `context_window_tokens`.

## Testing

Backend tests:

- LLM connection retries up to 10 attempts when no events were emitted.
- No retry after a partial stream event.
- Pending user messages are consumed in the same run and persisted once.
- Append endpoint queues during an active run and falls back to direct persistence when idle.
- Empty sessions appear in `listSessions`.
- Context usage endpoint returns configured max and estimated used tokens.
- `/goal` adds goal-mode prompt without bypassing policy.

Frontend tests:

- New session immediately appears in the session list.
- Sending during a run calls append endpoint, not `/v1/agent`.
- Context display renders `used/max` and updates from SSE usage.
- `/goal` remains visible as the user message and reaches the backend unchanged.

Verification:

- `npm run typecheck`
- `npm test`
- `cd web && npm run build`

## Rollout Notes

This design preserves the existing `/v1/agent` path for normal messages and adds append/session/context APIs alongside it. Existing stored messages remain valid. A MySQL migration creates explicit session records and backfills current history. Multi-replica deployments need sticky routing for active chat append behavior because active runs are currently process-local.
