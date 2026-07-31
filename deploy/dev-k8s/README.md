# aiop dev k8s stack

This directory contains the real Kubernetes debug stack for finishing the remaining PLAN items.

It deploys:

- MySQL 8.4 for persistent Store verification.
- Dex as a test OIDC provider exposed on NodePort `30084`.
- aiop server Pod using local `aiop-web:dev` + `aiop:dev` images in the same Pod. The web container proxies API/SSE to backend `127.0.0.1:8081`, and the backend embeds the scheduler.
- A fixed NodePort service on `30083`.
- Example operation ServiceAccounts and RBAC.

The cluster node IP used for validation is:

```sh
NODE_IP=192.168.10.108
NODE_PORT=30083
DEX_NODE_PORT=30084
BASE_URL="http://${NODE_IP}:${NODE_PORT}"
DEX_URL="http://${NODE_IP}:${DEX_NODE_PORT}/dex"
```

Do not use port-forward for NodePort checks. Access aiop as `http://192.168.10.108:30083`.

## Build image

The manifest uses `imagePullPolicy: IfNotPresent` and images `aiop:dev` and `aiop-web:dev`.

```sh
docker build -t aiop:dev .
docker build -f web/Dockerfile -t aiop-web:dev .
```

This cluster uses Docker as the container runtime on the same node, so the locally built image is available to the kubelet.

## Deploy

```sh
kubectl apply -f deploy/dev-k8s/namespace.yaml
# Replace example secret values through your approved secret-management workflow before deploying.
kubectl apply -f deploy/dev-k8s/aiop-secret.example.yaml
kubectl apply -f deploy/dev-k8s/mysql.yaml
kubectl apply -f deploy/dev-k8s/oidc-test.yaml
kubectl apply -f deploy/dev-k8s/aiop-configmap.yaml
kubectl apply -f deploy/dev-k8s/aiop-configmap-netdiag.yaml   # optional: ops/netdiag sandbox config
kubectl apply -f deploy/dev-k8s/aiop-configmap-oidc.yaml
kubectl apply -f deploy/dev-k8s/aiop-deployment.yaml
kubectl apply -f deploy/dev-k8s/aiop-service-nodeport.yaml
kubectl apply -f deploy/dev-k8s/ops-rbac.yaml
```

If this namespace was deployed with the older standalone scheduler, remove it once:

```sh
kubectl -n aiop-dev delete deployment aiop-scheduler --ignore-not-found
```

Wait for readiness:

```sh
kubectl -n aiop-dev rollout status deploy/mysql --timeout=180s
kubectl -n aiop-dev rollout status deploy/dex --timeout=180s
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
```

## Validate HTTP through NodePort

```sh
NODE_IP=192.168.10.108
NODE_PORT=30083
BASE_URL="http://${NODE_IP}:${NODE_PORT}"

curl -fsS "${BASE_URL}/healthz"
curl -fsS "${BASE_URL}/readyz"
```

Expected response:

```json
{"ok":true}
```

## Seed local admin and validate MySQL persistence

Default config uses local auth so `seed-admin` is available.

```sh
kubectl -n aiop-dev exec deploy/aiop-server -c aiop -- npm run start seed-admin default admin 'admin-pass'

TOKEN=$(curl -fsS "${BASE_URL}/auth/login" \
  -H 'content-type: application/json' \
  -d '{"tenantId":"default","username":"admin","password":"admin-pass"}' \
  | node -pe 'JSON.parse(fs.readFileSync(0, "utf8")).token')

curl -fsS "${BASE_URL}/v1/admin/tenants" \
  -H "authorization: Bearer ${TOKEN}"
```

Restart aiop and confirm the seeded user still exists in MySQL:

```sh
kubectl -n aiop-dev rollout restart deploy/aiop-server
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s

curl -fsS "${BASE_URL}/auth/login" \
  -H 'content-type: application/json' \
  -d '{"tenantId":"default","username":"admin","password":"admin-pass"}'
```

## Test OIDC provider

Dex is deployed as a NodePort service at `http://192.168.10.108:30084/dex`. The optional OIDC config is stored in `aiop-config-oidc`.

The static Dex client is:

- client id: `aiop`
- client secret: `aiop-oidc-secret`
- redirect URI: `http://192.168.10.108:30083/auth/callback`

The static Dex user is:

- username: `admin`
- email: `admin@example.com`
- password: `password`

To switch aiop server to OIDC config for callback testing:

```sh
kubectl -n aiop-dev patch deploy aiop-server --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/volumes/0/configMap/name","value":"aiop-config-oidc"}]'
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
curl -fsS "${BASE_URL}/auth/oidc/start"
```

The response contains the Dex authorization URL at `http://192.168.10.108:30084/dex/...`. For browser-driven callback testing, open that URL from a network location that can reach both `192.168.10.108:30084` and `192.168.10.108:30083`.

Switch back to local auth:

```sh
kubectl -n aiop-dev patch deploy aiop-server --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/volumes/0/configMap/name","value":"aiop-config"}]'
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
```

## AIOS Sandbox Lifecycle

The checked-in `aiop-config` deliberately starts with `sandbox.enabled: false`. AIOS Lifecycle configuration is platform-global operational data, managed only by a platform administrator and stored under the `default` tenant record: enable and configure it through **Settings → Sandbox** after the server and MySQL are ready. Once that database row exists, the saved settings are authoritative for new sandboxes; `config.jsonc` is no longer the source for AIOS lifecycle URL, placement, template, or API key.

### Configure and protect settings

1. Replace `AIOP_SETTINGS_SECRET` in `aiop-dev-secrets` with a strong, independent value through your approved secret-management workflow before production use. It protects sensitive settings persisted in the database and must not be reused as `AIOP_JWT_SECRET`.
2. Sign in with a principal that has `tenant:manage`, then save the AIOS Lifecycle endpoint, placement, template/profile, and API key on **Settings → Sandbox**.
3. The page/API stores credentials as sensitive settings. Do not put the AIOS key in `AIOS_SANDBOX_KEY`, `config.jsonc`, ConfigMaps, shell arguments, shell history, patches, logs, tickets, or command output.
4. Verify only that the deployment rolls out and the saved configuration is available to the authorized administrator. Do not use `kubectl get secret ... -o yaml`, `kubectl describe secret`, or base64 decoding to inspect credentials.

After saving settings, execute the smoke script in the AIOP container:

```sh
kubectl -n aiop-dev exec deploy/aiop-server -c aiop -- npx tsx scripts/verify-aios-e2b.ts
```

The script loads the effective saved configuration, then verifies create, readiness, commands, Python code fallback, file read, timeout and cleanup. It reports only status and sandbox IDs, never credentials. See `docs/DESIGN-aios-e2b-integration.md` for the lifecycle contract and settings authority.

Because the default model endpoint is a placeholder, calling sandbox tools through `/v1/agent` additionally requires a real model endpoint.

### Switch this dev stack to the ops/netdiag sandbox

For fabric / OVS operations, do not use the browser sandbox image or the readonly `aiop-sandbox`
template. Build the netdiag image, apply the privileged netdiag template, then switch aiop to the
netdiag ConfigMap:

```sh
cp "$(which kubectl)" deploy/opensandbox/kubectl
docker build -f deploy/opensandbox/Dockerfile.netdiag -t aiop/opensandbox-netdiag:dev .

kubectl apply -f deploy/opensandbox/netdiag-sandbox.yaml
kubectl apply -f deploy/dev-k8s/aiop-configmap-netdiag.yaml

kubectl rollout restart deployment/opensandbox-server -n opensandbox-system
kubectl rollout status deployment/opensandbox-server -n opensandbox-system
kubectl delete pod -n opensandbox --all

kubectl -n aiop-dev patch deploy aiop-server --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/volumes/0/configMap/name","value":"aiop-config-netdiag"}]'
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
```

`netdiag-sandbox.yaml` sets the sandbox container `imagePullPolicy` to `IfNotPresent`; with this
single-node Docker runtime, the locally built `aiop/opensandbox-netdiag:dev` image is used without
pulling from Docker Hub. Avoid `:latest` for local-only images because Kubernetes defaults it to
`imagePullPolicy: Always`.

Expected RBAC checks:

```sh
kubectl auth can-i create pods --subresource=exec -n kube-system \
  --as=system:serviceaccount:opensandbox:aiop-netdiag
kubectl auth can-i create pods -n opensandbox \
  --as=system:serviceaccount:opensandbox:aiop-netdiag
kubectl auth can-i create daemonsets.apps -n fabric-e2e \
  --as=system:serviceaccount:opensandbox:aiop-netdiag
kubectl auth can-i create deployments.apps -n fabric-e2e \
  --as=system:serviceaccount:opensandbox:aiop-netdiag
kubectl auth can-i create services -n fabric-e2e \
  --as=system:serviceaccount:opensandbox:aiop-netdiag
kubectl auth can-i get clusterroles \
  --as=system:serviceaccount:opensandbox:aiop-netdiag
kubectl auth can-i create daemonsets.apps -n fabric-e2e \
  --as=system:serviceaccount:kube-system:fabric-node-serviceaccount
```

Expected sandbox tools:

```sh
command -v ip
ip r
/opt/cni/bin/fabric-admin version
ls -la /etc/cni/net.d
kubectl auth can-i --list
```

## Standard E2B

External standard E2B verification is credential-gated. Enable the official E2B provider and save its connection through **Settings → Sandbox**. Provide `E2B_API_KEY` through `aiop-dev-secrets` only when the selected E2B deployment requires it. Do not send an AIOS Lifecycle key to standard E2B.

Without `E2B_API_KEY`, this dev stack verifies the standard E2B path by unit tests only:

- `tests/e2b.test.ts` locks the official SDK create/connect option shape and verifies no AIOS-only placement is sent.
- `tests/kubectl.test.ts` asserts cluster config becomes `SandboxSpec` metadata.

## Cleanup

```sh
kubectl delete namespace aiop-dev
```
