# Remaining Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining PLAN items and validate the result on Kubernetes with NodePort access through `192.168.10.108:<nodePort>`.

**Architecture:** Extend the existing Node HTTP/SSE backend instead of adding a new service. Approval remains tied to a live SSE connection with a process-local pending store, so the dev k8s deployment uses one server replica. Visual screenshots become typed message content blocks, and sandbox cluster metadata flows from config into provider create calls.

**Tech Stack:** TypeScript, Node.js HTTP/SSE, Vitest, MySQL/Kysely, Kubernetes manifests, OpenSandbox, E2B SDK adapter.

---

## File Structure

- Modify `src/model/types.ts`: add tool result content blocks.
- Modify `src/model/anthropic.ts`: translate image-capable tool results to Anthropic content blocks.
- Modify `src/model/openai.ts`: keep required tool text and add image user messages for OpenAI-compatible vision input.
- Modify `src/tools/browser.ts`: return screenshot image blocks.
- Modify `src/agent/approval.ts`: add pending approval store, interactive gate, cancellation, and typed events.
- Modify `src/server/http.ts`: add approval endpoints and use interactive gate in `/v1/agent`.
- Modify `src/sandbox/types.ts`: add namespace, serviceAccount, and metadata to `SandboxSpec`.
- Modify `src/tools/kubectl.ts`: carry cluster namespace and ServiceAccount into sandbox specs.
- Modify `src/sandbox/e2b.ts`: forward metadata into E2B create options.
- Modify `src/sandbox/opensandbox.ts`: preserve metadata for OpenSandbox create options.
- Modify tests in `tests/enhance.test.ts`, `tests/http.test.ts`, `tests/model.test.ts`, `tests/kubectl.test.ts`, `tests/opensandbox.test.ts`, and `tests/sandbox.test.ts`.
- Create `deploy/dev-k8s/`: real debug manifests and README for MySQL, OIDC test service, aiop, NodePort, and OpenSandbox integration.
- Modify `docs/PLAN.md`: mark the four remaining items as completed with verification notes.

---

### Task 1: Tool Result Image Blocks

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/tools/browser.ts`
- Modify: `src/model/anthropic.ts`
- Modify: `src/model/openai.ts`
- Test: `tests/enhance.test.ts`
- Test: `tests/model.test.ts`

- [ ] **Step 1: Write failing tests for screenshot image blocks**

Add to `tests/enhance.test.ts`:

```ts
it('browser_screenshot returns a PNG image block', async () => {
  const { handle } = mockDesktop();
  const tools = buildBrowserTools(async () => handle);

  const shot = await tools.find((t) => t.def.name === 'browser_screenshot')!.run({}, ctx);

  expect(shot.content).toContain('3 字节');
  expect(shot.contentBlocks).toEqual([
    { type: 'text', text: '截图已捕获（3 字节）。桌面流：https://vnc/url' },
    { type: 'image', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') },
  ]);
});
```

Add to `tests/model.test.ts`:

```ts
it('maps Anthropic tool image results to image content blocks', () => {
  const msgs = toAnthropicMessages([{
    role: 'tool',
    toolResults: [{
      id: 'c1',
      content: 'screenshot',
      contentBlocks: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', mimeType: 'image/png', data: 'AQID' },
      ],
    }],
  }]);

  expect(JSON.stringify(msgs)).toContain('"media_type":"image/png"');
  expect(JSON.stringify(msgs)).toContain('"data":"AQID"');
});

it('maps OpenAI tool image results to text tool result plus image user message', () => {
  const msgs = toOpenAIMessages('', [{
    role: 'tool',
    toolResults: [{
      id: 'c1',
      content: 'screenshot',
      contentBlocks: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', mimeType: 'image/png', data: 'AQID' },
      ],
    }],
  }]);

  expect(msgs[0]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'screenshot' });
  expect(JSON.stringify(msgs[1])).toContain('data:image/png;base64,AQID');
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```sh
npm test -- tests/enhance.test.ts tests/model.test.ts
```

Expected: fail because `contentBlocks` and image mapping do not exist.

- [ ] **Step 3: Implement content block types and mappings**

In `src/model/types.ts`, add:

```ts
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface ToolResult {
  id: string;
  content: string;
  contentBlocks?: ToolContentBlock[];
  isError?: boolean;
}
```

In `src/tools/browser.ts`, make `browser_screenshot` return text plus a base64 PNG image block.

In `src/model/anthropic.ts`, convert content blocks to Anthropic `tool_result.content` arrays.

In `src/model/openai.ts`, keep the required `tool` message as text and append a follow-up `user` content array containing `image_url` data URLs for image blocks.

- [ ] **Step 4: Verify green**

Run:

```sh
npm test -- tests/enhance.test.ts tests/model.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck pass.

---

### Task 2: Interactive Approval Pause / Resume

**Files:**
- Modify: `src/agent/approval.ts`
- Modify: `src/server/http.ts`
- Test: `tests/enhance.test.ts`
- Test: `tests/http.test.ts`

- [ ] **Step 1: Write failing approval store and gate tests**

Add to `tests/enhance.test.ts`:

```ts
it('interactive approval waits until approved', async () => {
  const store = new InMemoryApprovalStore();
  const emitted: ApprovalPending[] = [];
  const gate = new InteractiveApprovalGate({ store, emit: (p) => emitted.push(p) });
  const waiting = gate.request({ call: { id: 'c1', name: 'act', args: {} }, reason: 'prod', ctx });

  expect(emitted).toHaveLength(1);
  expect(await store.approve(emitted[0]!.id, ctx.tenantId)).toBe(true);
  await expect(waiting).resolves.toBe(true);
});

it('interactive approval denies and cancels pending requests', async () => {
  const store = new InMemoryApprovalStore();
  const gate = new InteractiveApprovalGate({ store, emit: () => {} });
  const waiting = gate.request({ call: { id: 'c1', name: 'act', args: {} }, reason: 'prod', ctx });
  const pending = store.list(ctx.tenantId)[0]!;

  expect(await store.deny(pending.id, ctx.tenantId)).toBe(true);
  await expect(waiting).resolves.toBe(false);
  expect(store.get(pending.id)).toBeUndefined();
});
```

Add to `tests/http.test.ts` a model/tool/policy setup where the tool needs approval, then assert SSE emits `approval_required`, approving through `POST /v1/approvals/{id}/approve` lets the run finish, and tenant/admin RBAC is enforced.

- [ ] **Step 2: Verify tests fail**

Run:

```sh
npm test -- tests/enhance.test.ts tests/http.test.ts
```

Expected: fail because `InMemoryApprovalStore`, `InteractiveApprovalGate`, and approval routes do not exist.

- [ ] **Step 3: Implement approval store and gate**

In `src/agent/approval.ts`, add:

```ts
export interface ApprovalPending {
  id: string;
  tenantId: string;
  sessionId: string;
  userId: string;
  call: ToolCall;
  reason?: string;
  diff?: string;
  createdAt: string;
}

export class InMemoryApprovalStore {
  create(input: Omit<ApprovalPending, 'id' | 'createdAt'>): ApprovalPending;
  get(id: string): ApprovalPending | undefined;
  list(tenantId: string): ApprovalPending[];
  approve(id: string, tenantId: string): Promise<boolean>;
  deny(id: string, tenantId: string): Promise<boolean>;
  cancel(id: string): void;
}

export class InteractiveApprovalGate implements ApprovalGate {
  constructor(opts: {
    store: InMemoryApprovalStore;
    emit: (pending: ApprovalPending) => void;
    diff?: (req: ApprovalRequest) => Promise<string | undefined>;
    signal?: AbortSignal;
  });
  request(req: ApprovalRequest): Promise<boolean>;
}
```

Use `randomUUID()` for IDs and resolve pending promises on approve, deny, or abort.

- [ ] **Step 4: Add HTTP approval routes**

In `src/server/http.ts`:

- Create one `InMemoryApprovalStore` inside `createHttpServer`.
- Add `GET /v1/approvals` for authenticated users with `approve` permission.
- Add `POST /v1/approvals/{id}/approve`.
- Add `POST /v1/approvals/{id}/deny`.
- In `runAgentSse`, use `InteractiveApprovalGate` instead of `AutoDenyGate`.
- Emit `event: approval_required`.
- Use `req.on('close')` to abort pending approval waits.

For kubectl diff, if the call name is `kubectl`, dispatch a dry-run copy:

```ts
const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
  ? { ...call.args, dryRun: true }
  : call.args;
const res = await rt.tools.dispatch({ ...call, id: `${call.id}:dry-run`, args }, toolCtx);
return res.content;
```

- [ ] **Step 5: Verify green**

Run:

```sh
npm test -- tests/enhance.test.ts tests/http.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

---

### Task 3: In-Cluster Sandbox Metadata

**Files:**
- Modify: `src/sandbox/types.ts`
- Modify: `src/tools/kubectl.ts`
- Modify: `src/sandbox/e2b.ts`
- Modify: `src/sandbox/opensandbox.ts`
- Test: `tests/kubectl.test.ts`
- Test: `tests/sandbox.test.ts`
- Test: `tests/opensandbox.test.ts`

- [ ] **Step 1: Write failing metadata tests**

Add to `tests/kubectl.test.ts`:

```ts
it('passes cluster namespace and serviceAccount into sandbox spec', async () => {
  const specs: unknown[] = [];
  const handle = {
    sandboxId: 'sb',
    runCode: vi.fn(async () => ({ stdout: '', stderr: '' })),
    runCommand: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
    setTimeout: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
  } satisfies SandboxHandle;
  const provider: SandboxProvider = {
    create: vi.fn(async (spec) => { specs.push(spec); return handle; }),
    connect: vi.fn(async () => handle),
  };
  const clusters = new ClusterRegistry({
    dev: {
      access: 'rw',
      production: false,
      template: 'kubectl:latest',
      namespace: 'aiop',
      serviceAccount: 'aiop-ops',
      e2bControl: 'e2b.aiop.svc:80',
    },
  });
  const tool = buildKubectlTool({ clusters, sandboxes: new SandboxManager({ provider }) });

  await tool.run({ cluster: 'dev', args: ['get', 'pods', '-n', 'aiop'] }, ctx);

  expect(specs[0]).toMatchObject({
    template: 'kubectl:latest',
    namespace: 'aiop',
    serviceAccount: 'aiop-ops',
    domain: 'e2b.aiop.svc:80',
    metadata: { cluster: 'dev', namespace: 'aiop', serviceAccount: 'aiop-ops' },
  });
});
```

Add provider-specific assertions that E2B and OpenSandbox create options include metadata.

- [ ] **Step 2: Verify tests fail**

Run:

```sh
npm test -- tests/kubectl.test.ts tests/sandbox.test.ts tests/opensandbox.test.ts
```

Expected: fail because metadata fields are missing.

- [ ] **Step 3: Implement metadata transport**

In `src/sandbox/types.ts`, add fields to `SandboxSpec`:

```ts
namespace?: string;
serviceAccount?: string;
metadata?: Record<string, string>;
```

In `src/tools/kubectl.ts`, include cluster metadata in `specFor`.

In `src/sandbox/e2b.ts`, pass metadata to `Sandbox.create`:

```ts
metadata: {
  ...spec.metadata,
  namespace: spec.namespace,
  serviceAccount: spec.serviceAccount,
}
```

In `src/sandbox/opensandbox.ts`, merge the metadata into the existing `metadata` create option.

- [ ] **Step 4: Verify green**

Run:

```sh
npm test -- tests/kubectl.test.ts tests/sandbox.test.ts tests/opensandbox.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

---

### Task 4: dev-k8s Deployment Stack

**Files:**
- Create: `deploy/dev-k8s/namespace.yaml`
- Create: `deploy/dev-k8s/mysql.yaml`
- Create: `deploy/dev-k8s/oidc-test.yaml`
- Create: `deploy/dev-k8s/aiop-configmap.yaml`
- Create: `deploy/dev-k8s/aiop-secret.example.yaml`
- Create: `deploy/dev-k8s/aiop-deployment.yaml`
- Create: `deploy/dev-k8s/aiop-service-nodeport.yaml`
- Create: `deploy/dev-k8s/ops-rbac.yaml`
- Create: `deploy/dev-k8s/README.md`

- [ ] **Step 1: Create manifests**

Use one namespace, `aiop-dev`.

MySQL:

- Image `mysql:8.4`.
- PVC using default storage class.
- Service `mysql.aiop-dev.svc.cluster.local:3306`.
- Database `ai_ops`, user `ai_ops`, password secret.

OIDC test service:

- Use a lightweight static OIDC-compatible test deployment only for callback URL and discovery validation, or document that OIDC callback route is validated by app-level tests if no IdP image is available.
- Expose it only as ClusterIP.

aiop:

- Server deployment replica count `1` so process-local approvals work through NodePort.
- Scheduler deployment replica count `1`.
- ConfigMap sets sandbox provider `opensandbox` with domain `opensandbox-server.opensandbox-system.svc:80`.
- Service type `NodePort`, fixed port in the 30000-32767 range if available.

- [ ] **Step 2: Write operation docs**

In `deploy/dev-k8s/README.md`, include:

```sh
kubectl apply -f deploy/dev-k8s/namespace.yaml
kubectl apply -f deploy/dev-k8s/mysql.yaml
kubectl apply -f deploy/dev-k8s/oidc-test.yaml
kubectl apply -f deploy/dev-k8s/aiop-secret.example.yaml
kubectl apply -f deploy/dev-k8s/aiop-configmap.yaml
kubectl apply -f deploy/dev-k8s/aiop-deployment.yaml
kubectl apply -f deploy/dev-k8s/aiop-service-nodeport.yaml
kubectl apply -f deploy/dev-k8s/ops-rbac.yaml
kubectl -n aiop-dev rollout status deploy/mysql
kubectl -n aiop-dev rollout status deploy/aiop-server
kubectl -n aiop-dev rollout status deploy/aiop-scheduler
NODE_IP=192.168.10.108
NODE_PORT=$(kubectl -n aiop-dev get svc aiop-server-nodeport -o jsonpath='{.spec.ports[0].nodePort}')
curl "http://${NODE_IP}:${NODE_PORT}/healthz"
```

Document that no port-forward command is used for NodePort validation.

- [ ] **Step 3: Verify manifests locally**

Run:

```sh
kubectl apply --dry-run=client -f deploy/dev-k8s/
```

Expected: all manifests validate client-side.

---

### Task 5: Full Verification and PLAN Update

**Files:**
- Modify: `docs/PLAN.md`
- Use: `deploy/dev-k8s/README.md`

- [ ] **Step 1: Run full local verification**

Run:

```sh
npm run typecheck
npm test
```

Expected: all tests pass except existing environment-gated skips.

- [ ] **Step 2: Build the aiop image**

Run:

```sh
docker build -t aiop:dev .
```

Expected: image builds successfully.

- [ ] **Step 3: Deploy to k8s**

Run:

```sh
kubectl apply -f deploy/dev-k8s/
kubectl -n aiop-dev rollout status deploy/mysql --timeout=180s
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
kubectl -n aiop-dev rollout status deploy/aiop-scheduler --timeout=180s
```

Expected: all deployments ready.

- [ ] **Step 4: Validate NodePort by node IP**

Run:

```sh
NODE_IP=192.168.10.108
NODE_PORT=$(kubectl -n aiop-dev get svc aiop-server-nodeport -o jsonpath='{.spec.ports[0].nodePort}')
curl -fsS "http://${NODE_IP}:${NODE_PORT}/healthz"
curl -fsS "http://${NODE_IP}:${NODE_PORT}/readyz"
```

Expected: both return `{"ok":true}`.

- [ ] **Step 5: Validate MySQL-backed auth and persistence**

Run:

```sh
kubectl -n aiop-dev exec deploy/aiop-server -- npm run start seed-admin default admin 'admin-pass'
TOKEN=$(curl -fsS "http://${NODE_IP}:${NODE_PORT}/auth/login" \
  -H 'content-type: application/json' \
  -d '{"tenantId":"default","username":"admin","password":"admin-pass"}' | node -pe 'JSON.parse(fs.readFileSync(0,"utf8")).token')
curl -fsS "http://${NODE_IP}:${NODE_PORT}/v1/admin/tenants" -H "authorization: Bearer ${TOKEN}"
```

Expected: login succeeds and tenant list is returned through NodePort.

- [ ] **Step 6: Validate OpenSandbox-backed runtime**

Run an aiop request that uses sandbox tools when a real model key is available. If model keys are absent, run a direct in-cluster provider verification from a pod using the already validated OpenSandbox service and record the limitation.

Expected: OpenSandbox remains reachable from inside k8s. E2B external verification is skipped unless `E2B_API_KEY` is provided.

- [ ] **Step 7: Update PLAN**

In `docs/PLAN.md`, replace the remaining-items note with a completion note that includes:

- Interactive approval implemented and tested.
- Screenshot image blocks implemented and tested.
- E2B namespace/ServiceAccount metadata path implemented and tested.
- k8s dev integration manifests and docs archived under `deploy/dev-k8s/`.
- k8s NodePort validation completed through `192.168.10.108:<nodePort>`.
- External E2B credential validation skipped if `E2B_API_KEY` is absent.

- [ ] **Step 8: Final verification**

Run:

```sh
git status --short
npm run typecheck
npm test
```

Expected: only intended files changed, typecheck passes, tests pass.
