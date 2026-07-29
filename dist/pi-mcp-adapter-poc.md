# Pi MCP Adapter Isolation POC

Date: 2026-07-29

## Scope

This POC evaluated whether an installed third-party adapter could replace the AIoP MCP runtime while preserving these hard constraints only:

1. official MCP SDK client/transport mode;
2. tenant isolation;
3. connection sharing within one tenant and server;
4. tenant-scoped credential resolution;
5. auditable tool execution.

No production dependency was added or changed for this POC.

## Candidate and evidence

The installed third-party surfaces are `@modelcontextprotocol/sdk@1.29.0` and the Pi `AgentTool` contract from `@earendil-works/pi-agent-core@0.82.1`. Repository and installed-package searches found no standalone MCP-to-Pi adapter implementation. The feasible third-party path is therefore a thin direct wrapper from official SDK `Client.listTools()` / `Client.callTool()` into Pi `AgentTool`.

The official SDK satisfies transport/client protocol handling for stdio, SSE, and Streamable HTTP. The Pi contract can represent a tool definition and execution callback. Neither surface owns tenant identity, connection-pool keys, credential lookup, configuration generation, reconnect policy, nor audit events.

## Constraint result

| Constraint | Result | Evidence |
| --- | --- | --- |
| Official SDK mode | PASS | `@modelcontextprotocol/sdk` exposes the official `Client` and stdio/SSE/Streamable HTTP transports used by the package runtime. |
| Multi-tenant isolation | FAIL | The SDK client and Pi tool contracts have no tenant identity or tenant-keyed cache boundary. A direct adapter can accidentally retain one tenant's client/tool closure. |
| Connection sharing | FAIL | Neither third-party surface provides a `(tenantId, server)` connection pool or configuration-generation invalidation. |
| Credential handling | FAIL | Transport headers/environment can receive credentials, but no tenant-scoped credential resolver or rotation boundary is supplied. |
| Audit | FAIL | Pi tool callbacks and the MCP SDK do not emit the required tenant/server/tool outcome audit DTO. |

## Decision

POC stopped at the first hard-constraint evaluation failure. A direct third-party adapter is not accepted for production because four mandatory controls would remain application-owned and easy to bypass. AIoP keeps the official MCP SDK for protocol compliance, while `@aiop/mcp-runtime` owns tenant-keyed connection lifecycle, credential resolution, reconnect policy, identity-bound governed tool definitions, and redacted audit events.

This conclusion does not prohibit revisiting a future adapter that natively exposes all five controls; it only rejects the currently installed direct SDK-to-Pi adapter pattern.
