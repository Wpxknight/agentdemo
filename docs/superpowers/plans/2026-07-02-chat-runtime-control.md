# Chat Runtime Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build resilient chat runtime behavior: 10-attempt LLM connection retry, in-run message append, immediate empty sessions, context usage display, relaxed confirmation prompt, and `/goal` mode.

**Architecture:** Extend the existing Store abstraction with explicit sessions and context usage. Keep `/v1/agent` as the normal SSE run path, add append/session/context endpoints, and let active runs hold a process-local pending message queue. Update the React chat composer to append while the selected session is running and display context usage in the existing chat header.

**Tech Stack:** TypeScript, Node `http`, Vitest, Kysely/MySQL migrations, React 19 + Vite.

---

### Task 1: Agent Retry And Pending Message Boundaries

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/agent/core.ts`
- Test: `tests/agent.test.ts`

- [ ] **Step 1: Write failing retry and pending-message tests**

Add tests that prove:

```ts
it('retries model connection failures before any stream event up to success', async () => {
  let attempts = 0;
  const events: StreamEvent[] = [];
  const model: ChatModel = {
    id: 'flaky',
    async *stream(): AsyncIterable<StreamEvent> {
      attempts++;
      if (attempts < 3) throw new Error(`connect ${attempts}`);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'stop', reason: 'end_turn' };
    },
  };
  const result = await runAgent({
    model,
    tools: new ToolRegistry(),
    policy: new AllowAllPolicy(),
    ctx: { sessionId: 's1' },
    task: 'go',
    modelRetryDelayMs: 0,
    onEvent: (event) => events.push(event),
  });
  expect(attempts).toBe(3);
  expect(events.filter((event) => event.type === 'model_retry')).toHaveLength(2);
  expect(result.text).toBe('ok');
});
```

Also add tests for no retry after partial output and for `drainPendingMessages` forcing one more model turn before completion.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/agent.test.ts`

Expected: TypeScript/test failures because `model_retry`, `modelRetryDelayMs`, and `drainPendingMessages` do not exist.

- [ ] **Step 3: Implement minimal agent changes**

Add `model_retry` to `StreamEvent`. Add `drainPendingMessages?: () => Msg[] | Promise<Msg[]>` and `modelRetryDelayMs?: number` to `RunAgentOptions`. Wrap each model turn in retry logic that retries only before any stream event is seen and emits `model_retry` events. Drain pending messages before each turn and before breaking on no tool calls.

- [ ] **Step 4: Run agent tests**

Run: `npm test -- tests/agent.test.ts`

Expected: all agent tests pass.

### Task 2: Explicit Sessions And Context Usage

**Files:**
- Modify: `src/db/store.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/mysql.ts`
- Create: `src/db/migrations/0004_sessions.sql`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write failing Store tests**

Add tests that create an empty session and verify it appears in `listSessions`, then append messages and verify the same session gets `messageCount`, `lastMessage`, title, and context usage:

```ts
const created = await s.createSession(ctxA, { sessionId: 'empty-1', title: '新会话' });
expect(created).toMatchObject({ sessionId: 'empty-1', title: '新会话', messageCount: 0 });
expect(await s.listSessions(ctxA)).toContainEqual(expect.objectContaining({ sessionId: 'empty-1' }));
await s.appendMessage(ctxA, 'empty-1', { role: 'user', text: '请巡检集群' });
expect(await s.getSessionContextUsage(ctxA, 'empty-1', 200000)).toMatchObject({
  maxTokens: 200000,
  estimated: true,
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/db.test.ts`

Expected: Store API methods and migration are missing.

- [ ] **Step 3: Implement Store API and migration**

Add `createSession`, `touchSession`, and `getSessionContextUsage` to `Store`. MemoryStore stores session summaries in a map. MysqlStore creates/upserts a `sessions` row and reads sessions from that table. Migration `0004_sessions.sql` creates the table and backfills from `messages`.

- [ ] **Step 4: Run DB tests**

Run: `npm test -- tests/db.test.ts`

Expected: DB tests pass.

### Task 3: HTTP Session, Append, Context, And `/goal`

**Files:**
- Modify: `src/server/http.ts`
- Modify: `src/runtime.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/model/factory.ts`
- Test: `tests/http.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

Add tests for:

```ts
POST /v1/sessions -> creates an empty session visible in GET /v1/sessions
POST /v1/sessions/:id/append while active -> queued true and no second model run starts
POST /v1/sessions/:id/append while idle -> persisted user message
GET /v1/sessions/:id/context -> returns usedTokens/maxTokens/estimated
POST /v1/agent with "/goal ..." -> model receives goal-mode system prompt and maxSteps allows more than 20 steps
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/http.test.ts`

Expected: endpoints and context fields are missing.

- [ ] **Step 3: Implement HTTP changes**

Extend `ActiveAgentRun` with `append(message)`. Add `POST /v1/sessions`, `POST /v1/sessions/:id/append`, and `GET /v1/sessions/:id/context`. Reuse existing `attachmentPrompt()` to build appended user text. Parse `/goal` in `/v1/agent`, add a goal prompt block, and use `maxSteps: 50`. Emit `model_retry`; include context usage in `usage` and `done`.

- [ ] **Step 4: Add context window config plumbing**

Add optional `contextWindowTokens` to config/model settings and expose it as `context_window_tokens` in HTTP responses. Default to `200000` when absent.

- [ ] **Step 5: Run HTTP tests**

Run: `npm test -- tests/http.test.ts`

Expected: HTTP tests pass.

### Task 4: Frontend Chat Runtime UI

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/app-data.ts`
- Modify: `web/src/App.tsx`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Write failing frontend tests**

Add tests that render the app with mocked HTTP responses and verify:

```ts
clicking "新建会话" calls POST /v1/sessions and immediately renders the new session row
submitting while an assistant message is running calls /v1/sessions/:id/append, not /v1/agent
the chat header displays "上下文 100K/200K"
```

- [ ] **Step 2: Run frontend tests and verify failure**

Run: `npm test -- tests/frontend.test.ts`

Expected: UI does not call new endpoints or render context usage yet.

- [ ] **Step 3: Implement frontend behavior**

Add `ContextUsageBody` and `context_window_tokens` types. Track `activeRunSessionIds` and `contextUsage`. Change `startNewSession()` to call `POST /v1/sessions` and optimistically update the sessions array. Change `sendComposer()` so active-session submissions call append and set a small message status. Parse SSE `usage`, `model_retry`, and `done` context fields. Render `上下文 {used}/{max}` in `PrototypeChatHeader`.

- [ ] **Step 4: Run frontend tests**

Run: `npm test -- tests/frontend.test.ts`

Expected: frontend tests pass.

### Task 5: Verification And Build

**Files:**
- Verify all changed source and tests.

- [ ] **Step 1: Run focused tests**

Run:

```sh
npm test -- tests/agent.test.ts tests/db.test.ts tests/http.test.ts tests/frontend.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: TypeScript passes.

- [ ] **Step 3: Run full test suite**

Run: `npm test`

Expected: all tests pass with the existing skipped test count.

- [ ] **Step 4: Build frontend**

Run: `cd web && npm run build`

Expected: Vite build succeeds.

- [ ] **Step 5: Review diff**

Run: `git diff --check` and `git status --short`

Expected: no whitespace errors; only intended files are changed.
