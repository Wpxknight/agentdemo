# Waiting Interaction UI Implementation Plan

1. Add a backend helper that maps a persisted pending interaction to the existing chat SSE event contract.
2. Emit that event when `runDurableAgentSse` receives a `waiting` result.
3. Add typed `/v1/questions` loading and session-indexed pending state restoration in the web app.
4. Add a `等待交互` badge to session rows and keep the active question card behavior.
5. Add regression tests, run typecheck/build, build images with Make, deploy to 166 with Make, and verify the existing waiting run becomes visible.
