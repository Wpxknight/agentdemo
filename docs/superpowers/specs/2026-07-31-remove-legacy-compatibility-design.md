# Remove Legacy Compatibility Design

## Goal

Make the repository a clean, Pi-only new project with no upgrade, historical-data, old-configuration, or unpublished-package compatibility surface.

## Scope

The cleanup removes five compatibility categories:

1. The pre-durable Agent kernel, coordinator, run option types, HTTP helpers, and control-contract aliases.
2. The `def`/`run` tool shape and all adapters accepting it; tools expose only the current governed `name`/`execute` shape.
3. Skill seed/tombstone migration, deprecated skill options, markers, locks, and tests for old on-disk layouts.
4. Sandbox legacy profile normalization and startup-to-database bootstrap behavior; current profile fields become authoritative.
5. Pi message compatibility types/codecs and database migrations that exist only to upgrade earlier schemas.

Historical design and plan documents remain as records. Active guides, sample configuration, public API snapshots, tests, and deployment manifests must describe only the current architecture.

## Runtime Architecture

`DurableRunRuntime` is the only Agent execution contract. The root application assembles the durable Pi runtime, and HTTP, CLI, and Scheduler call that contract directly. There is no `AgentKernel`, `AgentRuntime`, `AgentRunCoordinator`, fallback loop, or migration-era run option object.

Product tool governance receives a narrow options object containing only the policy, registry, governed definitions, tool context, interaction hooks, event callback, and guard it consumes. Tool definitions use a single shape and are registered without legacy normalization.

## Storage

The project assumes every database is created from scratch. Existing sequential migrations are replaced by one baseline migration representing the current MySQL schema. Runtime defaults use Pi-only values and do not mention `legacy-v1` or `compat-v1`.

Skill storage assumes the current product metadata and governance overlay layouts. It does not discover, hash, migrate, lock, or delete legacy seed copies or tombstones.

Sandbox settings and profiles accept only the current schema. Startup configuration does not bootstrap obsolete database settings.

## Public Packages

The workspace packages are unpublished preview packages with no consumers. Deprecated exports are removed directly rather than retained behind shims. Generated `docs/public-api/*.d.ts` snapshots are regenerated from the reduced exports.

## Tests and Static Enforcement

Tests that assert legacy compatibility are deleted or rewritten to assert the current contract. New source-level contract tests prevent reintroduction of removed names and migration markers.

TypeScript enables `noUnusedLocals` and `noUnusedParameters`. Intentionally unused callback parameters must be omitted or explicitly consumed. Verification includes package builds, root type checking, Web build, public API checks, package tarball checks, and the full Vitest suite.

## Deployment

After verification, deploy using the repository's current Kubernetes manifests and documented namespace. Recreate database state when required by the new baseline, apply manifests, wait for rollout completion, and verify the service and pods are ready. No existing environment or data must be preserved.

## Success Criteria

- Production source contains no executable Legacy Agent path or deprecated compatibility alias.
- Skill, Sandbox, Pi message, and database upgrade compatibility code is removed.
- A fresh database is fully created by one baseline migration.
- Strict unused-code checking passes.
- Package verification, Web build, and all tests pass.
- The Kubernetes deployment completes and reports ready workloads.
