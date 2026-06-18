# aiop dev k8s stack

This directory contains the real Kubernetes debug stack for finishing the remaining PLAN items.

It deploys:

- MySQL 8.4 for persistent Store verification.
- Dex as a test OIDC provider exposed on NodePort `30084`.
- aiop server and scheduler using the local `aiop:dev` image.
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

The manifest uses `imagePullPolicy: IfNotPresent` and image `aiop:dev`.

```sh
docker build -t aiop:dev .
```

This cluster uses Docker as the container runtime on the same node, so the locally built image is available to the kubelet.

## Deploy

```sh
kubectl apply -f deploy/dev-k8s/namespace.yaml
kubectl apply -f deploy/dev-k8s/aiop-secret.example.yaml
kubectl apply -f deploy/dev-k8s/mysql.yaml
kubectl apply -f deploy/dev-k8s/oidc-test.yaml
kubectl apply -f deploy/dev-k8s/aiop-configmap.yaml
kubectl apply -f deploy/dev-k8s/aiop-configmap-oidc.yaml
kubectl apply -f deploy/dev-k8s/aiop-deployment.yaml
kubectl apply -f deploy/dev-k8s/aiop-service-nodeport.yaml
kubectl apply -f deploy/dev-k8s/ops-rbac.yaml
```

Wait for readiness:

```sh
kubectl -n aiop-dev rollout status deploy/mysql --timeout=180s
kubectl -n aiop-dev rollout status deploy/dex --timeout=180s
kubectl -n aiop-dev rollout status deploy/aiop-server --timeout=180s
kubectl -n aiop-dev rollout status deploy/aiop-scheduler --timeout=180s
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
kubectl -n aiop-dev exec deploy/aiop-server -- npm run start seed-admin default admin 'admin-pass'

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

## OpenSandbox

The aiop config uses the existing in-cluster OpenSandbox service:

```json
"domain": "opensandbox-server.opensandbox-system.svc:80"
```

Check that OpenSandbox is ready:

```sh
kubectl -n opensandbox-system get pods
kubectl -n opensandbox-system get svc opensandbox-server
```

Because the default aiop config uses a placeholder model endpoint, agent-driven sandbox tool calls require a real model endpoint before they can be exercised through `/v1/agent`. The OpenSandbox provider itself is verified by the repository tests and by the existing `deploy/opensandbox/README.md` procedure.

## E2B

External E2B verification is credential-gated. If `E2B_API_KEY` is available, set it in `aiop-dev-secrets`, switch `sandbox.provider` to `e2b`, and redeploy aiop.

Without `E2B_API_KEY`, this dev stack verifies the implemented E2B path by unit tests only:

- `tests/e2b.test.ts` asserts template / namespace / ServiceAccount metadata is forwarded to `Sandbox.create`.
- `tests/kubectl.test.ts` asserts cluster config becomes `SandboxSpec` metadata.

## Cleanup

```sh
kubectl delete namespace aiop-dev
```
