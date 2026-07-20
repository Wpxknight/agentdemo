# Chat Session Terminal Isolation and Duration Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate terminal output by chat session with bounded in-memory retention, and persist every completed AI run duration so it remains visible after history reload.

**Architecture:** Add a small pure frontend terminal-cache module that owns UTF-8 byte limits and LRU eviction, then make React route every asynchronous terminal update through a captured session ID. Extend the existing neutral `Msg` JSON payload with `durationMs`; the HTTP agent endpoint measures each run and attaches the duration to the final persisted assistant message, while the history mapper preserves it when merging assistant rounds.

**Tech Stack:** TypeScript, React 19, Vite, Node HTTP/SSE, Memory/MySQL stores, Vitest, Docker, Kubernetes (`aiop-dev`).

---

## File map

- `web/src/session-terminal.ts`: pure per-session terminal-cache operations, UTF-8 truncation, and total LRU eviction.
- `tests/session-terminal.test.ts`: focused behavioral tests for terminal isolation and size limits.
- `web/src/App.tsx`: hold terminal cache state, capture target session IDs for async operations, clear deleted-session entries, and preserve historical durations.
- `web/src/types.ts`: allow historical session messages to carry `durationMs`.
- `src/model/types.ts`: add optional persisted `durationMs` metadata to the neutral message type.
- `src/db/mysql.ts`: serialize and deserialize `durationMs` in the existing `messages.content` JSON.
- `src/server/http.ts`: time the agent request and attach duration metadata before persistence.
- `tests/db.test.ts`: prove MySQL-compatible message serialization retains duration metadata through the store contract where applicable.
- `tests/http.test.ts`: prove history responses include the persisted run duration.
- `tests/frontend.test.ts`: prove the chat page is wired to per-session terminal state and historical duration rendering.

### Task 1: Pure bounded terminal cache

**Files:**
- Create: `web/src/session-terminal.ts`
- Create: `tests/session-terminal.test.ts`

- [ ] **Step 1: Write failing cache tests**

Cover independent session outputs, append-versus-replace, UTF-8-safe 2 MiB truncation, the truncation marker, 20 MiB LRU eviction, touch ordering, and explicit removal. Use small injected limits in tests so fixtures stay compact:

```ts
const first = setSessionTerminal({}, 'a', 'alpha', 1, { perSessionBytes: 12, totalBytes: 24 });
const second = appendSessionTerminal(first, 'b', 'beta', 2, { perSessionBytes: 12, totalBytes: 24 });
expect(sessionTerminalOutput(second, 'a')).toBe('alpha');
expect(sessionTerminalOutput(second, 'b')).toBe('beta');

const truncated = setSessionTerminal({}, 'a', '一二三四五', 1, { perSessionBytes: 9, totalBytes: 30 });
expect(sessionTerminalOutput(truncated, 'a')).toContain('早期输出已省略');
expect(new TextEncoder().encode(truncated.a!.output).length).toBeLessThanOrEqual(9 + TERMINAL_TRUNCATION_NOTICE_BYTES);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- tests/session-terminal.test.ts`

Expected: FAIL because `web/src/session-terminal.ts` does not exist.

- [ ] **Step 3: Implement the cache module**

Export these constants and functions:

```ts
export const SESSION_TERMINAL_MAX_BYTES = 2 * 1024 * 1024;
export const TERMINAL_CACHE_MAX_BYTES = 20 * 1024 * 1024;
export const TERMINAL_TRUNCATION_NOTICE = '[系统] 部分早期输出已省略。\n';

export interface SessionTerminalEntry { output: string; lastAccess: number }
export type SessionTerminalCache = Record<string, SessionTerminalEntry>;

export function setSessionTerminal(cache: SessionTerminalCache, sessionId: string, output: string, now?: number, limits?: TerminalCacheLimits): SessionTerminalCache;
export function appendSessionTerminal(cache: SessionTerminalCache, sessionId: string, chunk: string, now?: number, limits?: TerminalCacheLimits): SessionTerminalCache;
export function touchSessionTerminal(cache: SessionTerminalCache, sessionId: string, now?: number): SessionTerminalCache;
export function removeSessionTerminals(cache: SessionTerminalCache, sessionIds: string[]): SessionTerminalCache;
export function sessionTerminalOutput(cache: SessionTerminalCache, sessionId: string): string;
```

Encode text with `TextEncoder`, advance a byte cut point past UTF-8 continuation bytes, and decode only a valid tail. Apply the 2 MiB limit before inserting. If total encoded bytes exceed 20 MiB, remove least-recently-accessed entries other than the active target session until within the limit.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npm test -- tests/session-terminal.test.ts`

Expected: all terminal-cache tests pass.

- [ ] **Step 5: Commit the cache unit**

```bash
git add web/src/session-terminal.ts tests/session-terminal.test.ts
git commit -m "feat(web): add bounded session terminal cache"
```

### Task 2: Wire terminal output to captured session IDs

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `tests/frontend.test.ts`

- [ ] **Step 1: Write failing frontend wiring tests**

Add source-contract assertions for `SessionTerminalCache`, `sessionTerminalOutput(terminalCache, sessionId)`, target-ID helpers, deletion cleanup, and removal of the global `useState('')` terminal value:

```ts
expect(app).toContain('const [terminalCache, setTerminalCache] = useState<SessionTerminalCache>({})');
expect(app).toContain('sessionTerminalOutput(terminalCache, sessionId)');
expect(app).toContain('appendTerminalOutput(activeSessionId');
expect(app).toContain('removeSessionTerminals(current, targetIds)');
expect(app).not.toContain("const [sandboxOutput, setSandboxOutput] = useState('')");
```

- [ ] **Step 2: Run the focused frontend test and confirm RED**

Run: `npm test -- tests/frontend.test.ts -t "isolates terminal output by session"`

Expected: FAIL on the missing cache state and session-aware update helpers.

- [ ] **Step 3: Replace global terminal state with session-aware helpers**

Import the cache module and add:

```ts
const [terminalCache, setTerminalCache] = useState<SessionTerminalCache>({});
const replaceTerminalOutput = useCallback((targetSessionId: string, output: string) => {
  setTerminalCache((current) => setSessionTerminal(current, targetSessionId, output));
}, []);
const appendTerminalOutput = useCallback((targetSessionId: string, chunk: string) => {
  setTerminalCache((current) => appendSessionTerminal(current, targetSessionId, chunk));
}, []);
```

On session activation, touch that entry. Pass `sessionTerminalOutput(terminalCache, sessionId)` into the chat shell. On account change clear the entire cache; on deletion call `removeSessionTerminals` for all deleted IDs.

- [ ] **Step 4: Capture the target session for every async terminal producer**

In `runAgent`, append streamed tool output to `activeSessionId`, including after the provisional session ID changes. In `runSandboxCode`, `openBrowserStream`, `captureBrowserScreenshot`, and `openBrowserInNewTab`, copy `const targetSessionId = sessionId` before the first `await` and use it for all initial, success, and error output updates. This prevents switching the UI session while a request is in flight from redirecting its output.

- [ ] **Step 5: Run the focused cache and frontend tests**

Run: `npm test -- tests/session-terminal.test.ts tests/frontend.test.ts`

Expected: both files pass.

- [ ] **Step 6: Commit the React integration**

```bash
git add web/src/App.tsx tests/frontend.test.ts
git commit -m "feat(web): isolate terminal output by chat session"
```

### Task 3: Persist successful AI run durations in message JSON

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/db/mysql.ts`
- Modify: `src/server/http.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Test: `tests/http.test.ts`
- Test: `tests/frontend.test.ts`

- [ ] **Step 1: Write failing HTTP and frontend history tests**

Start an authenticated `/v1/agent` request with a deterministic test model, consume the SSE response, then fetch `/v1/sessions/:id/messages` and assert the final assistant message contains a finite non-negative `durationMs`. Extend the frontend test to require `SessionMessagesBody.messages[].durationMs` and preservation during assistant-message merging:

```ts
expect(history.messages.findLast((message) => message.role === 'assistant')?.durationMs).toEqual(expect.any(Number));
expect(types).toContain('durationMs?: number;');
expect(app).toContain('prev.durationMs = message.durationMs ?? prev.durationMs');
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- tests/http.test.ts -t "persists agent duration" && npm test -- tests/frontend.test.ts -t "historical assistant duration"`

Expected: FAIL because duration metadata is not persisted or mapped.

- [ ] **Step 3: Extend the neutral message and MySQL JSON mapping**

Add `durationMs?: number` to `Msg`. Include it in `serializeMsgContent`, and restore it only when it is a finite non-negative number in `listMessages`. The memory store already retains the full `Msg` object and needs no schema migration.

- [ ] **Step 4: Measure and attach successful run duration before persistence**

In the agent HTTP handler, capture `const runStartedAt = Date.now()` immediately before `runAgent`. After it returns, compute `const durationMs = Math.max(0, Date.now() - runStartedAt)`, find the last assistant message in `result.messages` that belongs to the current run, and set its `durationMs`. Do this before either `replaceMessages` or `appendMessages`, so both compacted and normal persistence paths store the metadata.

- [ ] **Step 5: Preserve duration in frontend history mapping**

Add `durationMs?: number` to `SessionMessagesBody`. When merging consecutive assistant records, prefer the later message's duration; when creating a new `ChatMessage`, copy a finite non-negative duration. `MessageMeta` already renders final `durationMs`, so no new visual component is required.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run: `npm test -- tests/http.test.ts -t "persists agent duration" && npm test -- tests/frontend.test.ts -t "historical assistant duration"`

Expected: both focused tests pass.

- [ ] **Step 7: Commit duration persistence**

```bash
git add src/model/types.ts src/db/mysql.ts src/server/http.ts web/src/types.ts web/src/App.tsx tests/http.test.ts tests/frontend.test.ts
git commit -m "feat: persist assistant run durations"
```

### Task 4: Preserve final duration on failed or terminated runs

**Files:**
- Modify: `src/server/http.ts`
- Test: `tests/http.test.ts`

- [ ] **Step 1: Write failing failure and termination tests**

Use one model that emits partial `text_delta` then throws and another run that is aborted through `/terminate`. After SSE completion, fetch history and assert the last assistant record contains the partial text or a concise termination/failure message plus a non-negative `durationMs`.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- tests/http.test.ts -t "persists duration for failed or terminated agent runs"`

Expected: FAIL because the outer handler currently has no persisted assistant record when `runAgent` throws.

- [ ] **Step 3: Track streamed assistant content in the HTTP event bridge**

Maintain `streamedText` and `streamedThinking` beside the run timer. In `onEvent`, append `text_delta` and `thinking_delta`; on `model_retry`, remove the discarded suffix lengths so failed attempts are not duplicated. In the catch path, append one assistant message containing the retained partial content, or fallback text `运行已终止。` / `运行失败：<message>`, and attach `durationMs` before emitting the terminal SSE event.

- [ ] **Step 4: Avoid duplicate persistence**

Only use the catch-path append when normal result persistence did not complete. Keep queued leftover user-message flushing unchanged. Ensure the persisted failure text is not injected into the live SSE stream a second time; it is for historical replay consistency.

- [ ] **Step 5: Run focused and full HTTP tests**

Run: `npm test -- tests/http.test.ts`

Expected: all HTTP tests pass, including termination, append, compaction, and duration cases.

- [ ] **Step 6: Commit failure-path persistence**

```bash
git add src/server/http.ts tests/http.test.ts
git commit -m "fix: retain duration for interrupted agent runs"
```

### Task 5: Full verification and `aiop-dev` deployment

**Files:**
- Modify only files required by verification fixes.

- [ ] **Step 1: Run backend typecheck and full test suite**

Run: `npm run typecheck && npm test`

Expected: exit code 0 with zero failed tests.

- [ ] **Step 2: Build the frontend**

Run: `npm run build --prefix web`

Expected: TypeScript and Vite build complete successfully.

- [ ] **Step 3: Inspect the existing development deployment images**

Run:

```bash
kubectl -n aiop-dev get deploy aiop-server -o jsonpath='{range .spec.template.spec.containers[*]}{.name}={.image}{"\n"}{end}'
```

Expected: identify the backend and web image tags currently consumed by the existing deployment before building replacements.

- [ ] **Step 4: Build replacement images using the deployment's existing tags**

Run `docker build` for the backend Dockerfile and `docker build -f web/Dockerfile` for the web image, using exactly the tags discovered in Step 3. If the cluster runtime requires an explicit image import, use the same established import path as the current `aiop-dev` environment.

Expected: both images build successfully and are visible to the Kubernetes nodes.

- [ ] **Step 5: Restart and wait for the development rollout**

Run:

```bash
kubectl -n aiop-dev rollout restart deploy/aiop-server
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
kubectl -n aiop-dev get pods -l app=aiop -o wide
```

Expected: rollout succeeds and all `aiop-server` containers are ready.

- [ ] **Step 6: Verify service health and behavior**

Resolve the existing NodePort or ingress, check `/healthz` and `/readyz`, then verify through the deployed API/UI that two sessions retain separate terminal output and that a completed AI reply still displays its duration after reloading the session history.

- [ ] **Step 7: Run completion review**

Run `git status --short`, inspect the final diff and recent commits, and confirm unrelated pre-existing changes (`package.json`, `package-lock.json`, `.superpowers/`, and unrelated docs) were not included in implementation commits.
