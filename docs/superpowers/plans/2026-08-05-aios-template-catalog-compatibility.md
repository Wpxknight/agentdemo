# AIOS Template Catalog Compatibility Development Plan

1. Add catalog tests for legacy entries without `aios`, asserting least-privilege defaults.
2. Add mixed-catalog coverage proving valid extensions retain browser/diagnostic semantics.
3. Add malformed-extension coverage proving present invalid metadata is rejected rather than
   downgraded.
4. Split base E2B template validation from optional AIOS extension validation and normalize legacy
   entries through a dedicated compatibility path.
5. Run the focused catalog tests, TypeScript typecheck, relevant sandbox/runtime tests, and
   `git diff --check`.
