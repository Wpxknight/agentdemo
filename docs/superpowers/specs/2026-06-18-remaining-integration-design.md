# Remaining Integration Design

## Goal

Finish the remaining PLAN items with real Kubernetes validation:

- Interactive approval with diff / pause / resume.
- Computer-use visual loop by carrying screenshot image content through model messages.
- In-cluster E2B sandbox template / namespace / ServiceAccount binding path.
- Real k8s integration for MySQL, OIDC, aiop server/scheduler, and OpenSandbox; E2B external integration remains a documented credential-gated check because this environment has no `E2B_API_KEY`.

All NodePort checks must use the node IP and port form. In this cluster that means `192.168.10.108:<nodePort>`.

## Architecture

The existing backend stays Node HTTP + SSE, with MySQL-backed persistence and a stateless runtime. The work adds focused extensions around existing boundaries:

- `agent/approval.ts` gains a pending approval store and an interactive `ApprovalGate`.
- `server/http.ts` emits approval requests over the existing `/v1/agent` SSE stream and accepts approval decisions through HTTP endpoints.
- `model/types.ts` adds tool-result content blocks so screenshots can be represented as text plus image data.
- OpenAI and Anthropic adapters translate image blocks into provider-specific multimodal message formats while preserving existing text-only behavior.
- `sandbox/types.ts`, `config/schema.ts`, `tools/kubectl.ts`, and `sandbox/e2b.ts` carry namespace and ServiceAccount metadata to sandbox creation.
- `deploy/dev-k8s/` owns the debug dependency stack and operation docs.

## Components

### Interactive Approval

`ApprovalRequest` will include the tool call, reason, request context, and optional diff text. A new `InMemoryApprovalStore` will keep pending approvals by `approvalId`. It is intentionally process-local because approval is tied to one live SSE connection; if a pod restarts, the SSE run fails and the user reruns the request.

`SseApprovalGate` will:

1. Create a pending approval.
2. Emit `approval_required` with `approvalId`, call, reason, and diff.
3. Wait until `/v1/approvals/{approvalId}/approve` or `/v1/approvals/{approvalId}/deny` resolves it.
4. Continue the agent loop only when approved.

The HTTP endpoints require authentication. Approval requires the `approve` RBAC permission. The pending approval must match the caller tenant.

Diff collection is best-effort and scoped to kubectl calls. For write kubectl calls, the gate will run the same tool in dry-run mode before asking for approval and include the output as `diff`. If dry-run fails, the approval request still appears with the dry-run error in the diff field.

### Visual Loop

The internal message format will support tool results with content blocks:

- `{ type: "text", text: string }`
- `{ type: "image", mimeType: "image/png", data: string }`

`ToolResult.content` remains available for backward compatibility. `browser_screenshot` will return a text summary plus an image block containing base64 PNG bytes from the desktop provider.

Adapters will map image blocks as follows:

- Anthropic: `tool_result.content` becomes an array of text and image blocks. Image data uses `source: { type: "base64", media_type, data }`.
- OpenAI: tool messages cannot carry image blocks in all compatible deployments. The adapter will emit text-only tool messages by default and place image blocks into the next user message shape when supported by the SDK types. If compatibility is uncertain, the image block is preserved in stored messages and the text fallback keeps the run usable.

The tests will cover serialization and adapter mapping using local mock inputs, not real model calls.

### In-Cluster E2B Metadata

Cluster config already has `template`, `namespace`, and `serviceAccount`. The missing path is transport into sandbox creation.

`SandboxSpec` will add:

- `namespace?: string`
- `serviceAccount?: string`
- `metadata?: Record<string, string>`

`tools/kubectl.ts` will map cluster settings into the spec. `E2bProvider.create()` will forward these values through SDK-compatible fields: template, envs, and metadata. This makes the E2B control plane able to bind a created pod to the intended namespace and ServiceAccount when the self-hosted control plane supports that convention.

OpenSandbox will keep the same image-based behavior and include the metadata in its create call for traceability.

### k8s Integration Stack

`deploy/dev-k8s/` will contain:

- Namespace and shared config.
- MySQL Deployment, PVC, Secret, and Service.
- A lightweight test OIDC provider configuration suitable for local callback validation.
- aiop ConfigMap, Secret, server Deployment, scheduler Deployment, and NodePort Service.
- RBAC samples for operation ServiceAccounts.
- A README with exact commands and expected checks.

The aiop HTTP Service will be `NodePort`. Validation must use:

```sh
NODE_IP=192.168.10.108
curl "http://${NODE_IP}:<nodePort>/healthz"
```

No validation command should rely on port-forwarding.

## Data Flow

For an approved production kubectl write:

1. The client starts `POST /v1/agent` and reads SSE.
2. The model emits a `kubectl` tool call.
3. `OpsPolicy` marks it as `needApproval`.
4. `SseApprovalGate` dry-runs the call and emits `approval_required`.
5. The client posts approve or deny to the approval endpoint.
6. On approve, `runAgent` dispatches the original tool call.
7. The tool result is appended to messages and persisted after the run.

For a visual browser step:

1. The model calls `browser_screenshot`.
2. The tool returns text plus a PNG image block.
3. The next model turn receives a multimodal tool result when the adapter supports it.
4. The stored session keeps both text and image block metadata.

## Error Handling

- Missing or expired approval IDs return 404.
- Authenticated users without approval permission get 403.
- Dry-run failures are included in the approval event rather than hiding the request.
- Denied approval returns an error tool result to the model and the agent continues normally.
- If an SSE client disconnects while waiting for approval, the pending approval is cancelled.
- Image blocks are bounded by screenshot byte size from the desktop provider; the HTTP request body limit is unchanged because images flow server-side.
- E2B external checks are skipped unless `E2B_API_KEY` is set.

## Testing

Unit and integration tests:

- Approval gate emits a pending request, blocks tool execution until approval, and denies without execution.
- HTTP approval endpoints enforce auth, tenant ownership, and RBAC.
- `browser_screenshot` returns image content blocks.
- Anthropic and OpenAI message conversion preserves image-capable tool results or text fallback.
- `kubectl` sandbox specs include template, namespace, ServiceAccount, and metadata.
- E2B provider forwards namespace / ServiceAccount metadata to SDK create options.
- OpenSandbox provider remains compatible.

Runtime verification:

- `npm run typecheck`
- `npm test`
- Build the aiop image.
- Apply `deploy/dev-k8s/` manifests.
- Wait for MySQL, test OIDC, aiop server, and scheduler pods.
- Access health and login through `http://192.168.10.108:<nodePort>`.
- Run an API request that persists data in MySQL.
- Run an OpenSandbox-backed command from aiop inside k8s.
- Record E2B external verification as skipped when `E2B_API_KEY` is absent.

## Deployment Artifact Policy

All dependency manifests and operational notes for this work live under `deploy/dev-k8s/`. Existing production-oriented examples under `deploy/k8s/` remain intact unless a small compatibility update is required.
