# Smart Assistant Header Runtime Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the chat header compact, rename it to “智能助手”, and show the current session's persistent cumulative token usage plus live elapsed time while that session is running.

**Architecture:** Add a store-level session usage aggregation over existing usage audit events, expose it through an authenticated session endpoint, and combine that persisted baseline with live SSE `usage` deltas in React. Track run start timestamps per session so switching sessions preserves the correct running indicator and elapsed time.

**Tech Stack:** TypeScript, Node HTTP server, Memory/MySQL stores, React 19, Vite, Tailwind-backed CSS, Vitest, Kubernetes/Docker dev deployment.

---

## File map

- `src/db/store.ts`: define the cumulative session token usage result and store contract.
- `src/db/memory.ts`: aggregate usage audit events for the in-memory/test store.
- `src/db/mysql.ts`: aggregate usage audit events in MySQL without loading unrelated sessions.
- `src/server/http.ts`: expose `GET /v1/sessions/:id/usage` and keep existing SSE `usage` forwarding.
- `web/src/types.ts`: define the frontend cumulative usage response.
- `web/src/App.tsx`: load persisted usage, accumulate live SSE usage, track per-session start times, format elapsed time, and render the compact header state.
- `web/src/index.css`: reduce title bar, button, icon, and responsive dimensions.
- `tests/db.test.ts`: verify store aggregation and token accounting.
- `tests/http.test.ts`: verify the authenticated session usage endpoint and tenant isolation.
- `tests/frontend.test.ts`: verify UI wiring, copy, live usage handling, timer formatting, and compact CSS hooks.

### Task 1: Store-level cumulative token aggregation

**Files:**
- Modify: `src/db/store.ts`
- Modify: `src/db/memory.ts`
- Modify: `src/db/mysql.ts`
- Test: `tests/db.test.ts`

- [x] **Step 1: Write the failing store test**

Add a test that records multiple audit events across sessions and kinds, then expects only the target session's `kind: 'usage'`, `action: 'agent'` events to contribute `inputTokens + outputTokens`:

```ts
await store.record({ kind: 'usage', action: 'agent', tenantId: ctx.tenantId, sessionId: 'usage-a', detail: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 } });
await store.record({ kind: 'usage', action: 'agent', tenantId: ctx.tenantId, sessionId: 'usage-a', detail: { inputTokens: 50, outputTokens: 10 } });
await store.record({ kind: 'usage', action: 'scheduler', tenantId: ctx.tenantId, sessionId: 'usage-a', detail: { inputTokens: 999, outputTokens: 999 } });
await store.record({ kind: 'usage', action: 'agent', tenantId: ctx.tenantId, sessionId: 'usage-b', detail: { inputTokens: 500, outputTokens: 500 } });

await expect(store.getSessionTokenUsage(ctx, 'usage-a')).resolves.toEqual({ totalTokens: 185 });
```

- [x] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/db.test.ts`

Expected: FAIL because `getSessionTokenUsage` does not exist.

- [x] **Step 3: Add the store contract and implementations**

Add:

```ts
export interface SessionTokenUsage { totalTokens: number }
getSessionTokenUsage(ctx: RequestContext, sessionId: string): Promise<SessionTokenUsage>;
```

The memory implementation filters its audit array by tenant, session, `usage`, and `agent`, safely converts numeric fields, and sums `inputTokens + outputTokens`. The MySQL implementation performs a tenant/session/kind/action query and sums the JSON detail values in TypeScript so the existing Kysely schema remains portable and typed.

- [x] **Step 4: Run the focused test and confirm GREEN**

Run: `npm test -- tests/db.test.ts`

Expected: all database tests pass.

### Task 2: Authenticated session usage endpoint

**Files:**
- Modify: `src/server/http.ts`
- Test: `tests/http.test.ts`

- [x] **Step 1: Write the failing HTTP test**

Record usage events for the authenticated tenant and another tenant, request `/v1/sessions/usage-http/usage`, and expect:

```ts
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ sessionId: 'usage-http', totalTokens: 185 });
```

Also request without authorization and expect `401`.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/http.test.ts -t "session cumulative token usage"`

Expected: FAIL with a missing route response.

- [x] **Step 3: Implement the endpoint**

Add a route adjacent to the existing context endpoint:

```ts
const sessionUsageMatch = /^\/v1\/sessions\/([^/]+)\/usage$/.exec(path);
if (method === 'GET' && sessionUsageMatch) {
  const ctx = await requireAuth(rt, req);
  const sessionId = decodeURIComponent(sessionUsageMatch[1]!);
  const usage = await rt.store.getSessionTokenUsage(ctx, sessionId);
  return sendJson(res, 200, { sessionId, ...usage });
}
```

- [x] **Step 4: Run the focused test and confirm GREEN**

Run: `npm test -- tests/http.test.ts -t "session cumulative token usage"`

Expected: the endpoint test passes.

### Task 3: Frontend cumulative usage and elapsed-time state

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Test: `tests/frontend.test.ts`

- [x] **Step 1: Write failing frontend source-contract tests**

Assert that the frontend defines `SessionTokenUsageBody`, requests `/usage`, handles `event?.event === 'usage'`, stores run start timestamps by session ID, formats elapsed time, renders `智能助手`, and no longer renders the header's context/cost labels.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/frontend.test.ts -t "current session cumulative token usage"`

Expected: FAIL on the missing type, request, event handler, timer, and new copy.

- [x] **Step 3: Add types and formatting helpers**

Add:

```ts
export interface SessionTokenUsageBody {
  sessionId: string;
  totalTokens: number;
}

function formatElapsedTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
```

- [x] **Step 4: Add persisted usage loading and live SSE accumulation**

Keep `Record<string, number>` maps for `sessionTokenUsage` and `runStartedAt`. On session entry call `GET /v1/sessions/:id/usage`. On `usage` SSE events add valid `inputTokens + outputTokens` to the active session. When a server `session` event replaces a provisional session ID, migrate the start timestamp and usage state to the final ID. In `finally`, clear timestamps for both provisional and final IDs and reload the server aggregate.

- [x] **Step 5: Add a one-second elapsed clock only while needed**

In the header component, use an effect keyed by the current session's optional start timestamp to update a `now` state once per second. Derive elapsed text during render; do not subscribe the whole app to a global timer.

- [x] **Step 6: Render the new header contract**

Pass `totalTokens` and `runStartedAt` into `PrototypeChatHeader`. Render:

```tsx
<h1>智能助手</h1>
<span>
  <i />
  {props.runStartedAt ? `运行中 ${formatElapsedTime(now - props.runStartedAt)}` : '就绪'}
  <b>累计 Token {formatTokenCount(props.totalTokens)}</b>
</span>
```

Remove header-only `contextUsage` and `sessionCostUsd` props and labels while leaving existing context loading available for its runtime safeguards.

- [x] **Step 7: Run the focused test and confirm GREEN**

Run: `npm test -- tests/frontend.test.ts -t "current session cumulative token usage"`

Expected: the frontend contract test passes.

### Task 4: Compact responsive header styling

**Files:**
- Modify: `web/src/index.css`
- Test: `tests/frontend.test.ts`

- [x] **Step 1: Extend the failing frontend test with CSS expectations**

Extract the desktop and mobile `.prototype-chat-header` and `.prototype-chat-actions button` rules and assert the compact targets: desktop minimum height `50px`, button height `30px`, smaller gaps/padding, and mobile dimensions no larger than the desktop controls.

- [x] **Step 2: Run the focused CSS test and confirm RED**

Run: `npm test -- tests/frontend.test.ts -t "compact smart assistant header"`

Expected: FAIL because current values are 62/66px and 36px buttons.

- [x] **Step 3: Apply compact styles**

Set the desktop header near `min-height: 50px; padding: 8px 14px`, title around `16px`, badge padding around `3px 8px`, action gap around `6px`, buttons to `height: 30px; min-width: 30px; padding: 0 9px`, and icons around `15px`. Update the mobile media rule to keep a single compact row where possible and retain the icon-only stop button behavior.

- [x] **Step 4: Run the focused CSS test and confirm GREEN**

Run: `npm test -- tests/frontend.test.ts -t "compact smart assistant header"`

Expected: the compact style test passes.

### Task 5: Full verification and deployment

**Files:**
- No source files expected beyond fixes found by verification.

- [x] **Step 1: Run backend typecheck and full tests**

Run: `npm run typecheck && npm test`

Expected: exit code 0 and zero failed tests.

- [x] **Step 2: Build the frontend**

Run: `npm run build --prefix web`

Expected: TypeScript and Vite build exit code 0.

- [x] **Step 3: Build development container images**

Run:

```bash
docker build -t aiop:dev .
docker build -f web/Dockerfile -t aiop-web:dev .
```

Expected: both images build successfully.

- [x] **Step 4: Restart the existing development deployment**

Run:

```bash
kubectl -n aiop-dev rollout restart deploy/aiop-server
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
```

Expected: deployment successfully rolls out with both containers ready.

- [x] **Step 5: Verify health and rendered UI**

Check `http://192.168.10.108:30083/healthz` and `readyz`, then use a browser/headless browser at desktop and mobile widths to verify the “智能助手” title, compact header/buttons, current-session cumulative token, running timer, no clipping, and healthy console.

- [x] **Step 6: Preserve the uncommitted working tree**

Run: `git status --short`

Expected: implementation, test, spec, and plan changes remain uncommitted as requested.
