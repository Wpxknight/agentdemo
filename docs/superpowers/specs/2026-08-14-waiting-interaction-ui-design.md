# Waiting Interaction UI Design

## Problem

Durable Pi runs persist `question` / `plan` interactions and finish with status `waiting`, but the chat SSE response only emits `done`. The web client only renders a question card after receiving `question_required` or `change_plan_required`, and it does not restore pending interactions after refresh or session switching.

## Design

1. When a durable chat run settles as `waiting`, the HTTP SSE adapter loads the run's pending interaction and emits the existing `question_required` or `change_plan_required` event before `done`.
2. The web client loads `/v1/questions` after authentication, page refresh, session selection, and chat-run completion. Results are indexed by `sessionId` into `pendingQuestions`.
3. Sessions with a pending interaction display a visible `等待交互` badge, while the active session continues to render the existing question card above the composer.
4. Answer submission refreshes pending interactions so resolved cards and badges disappear and failed submissions are restored.

## Compatibility and Safety

- Reuses existing interaction persistence and answer APIs; no schema migration.
- Reuses existing SSE event names and `QuestionCard` UI.
- Pending interaction payload remains tenant/user scoped by `/v1/questions`.
- Existing non-waiting runs and standalone approvals are unchanged.

## Verification

- Unit tests for waiting-result SSE projection and pending-question restoration helpers.
- Frontend tests for active question card and inactive-session waiting badge.
- Online regression against run `f9a39c66-1667-4104-9a4b-03cb3f246c6b` on 166.
