# 运维网络排查沙箱（netdiag）

给 aiop 提供一个 **特权 + 主机网络（hostNetwork）** 的运维沙箱，配合内置 skill `netdiag`
做容器/节点网络排查：pod/svc/nodeport 不通、抓包、fabric/OVS 流表、节点健康。

涉及文件：

- `skills/netdiag/SKILL.md` —— 内置 skill（排查流程；aiop 启动时自动从 `skills/` 扫描装载）。
- `deploy/opensandbox/Dockerfile.netdiag` —— 沙箱镜像（tcpdump/conntrack/dig/iptables/ovs/kubectl…）。
- `deploy/opensandbox/netdiag-sandbox.yaml` —— 专属 SA + 运维 RBAC + fabric e2e RBAC + 特权/hostNetwork 的 batchsandbox 模板。

## ⚠️ 必读：单一全局模板约束

OpenSandbox 的 batchsandbox provider **只有一个全局 PodTemplate**（ConfigMap
`opensandbox-batchsandbox-template`，见 `sandbox-sa.yaml` 注释）。aiop 侧
`SandboxSpec` 也没有 per-request 的 privileged/hostNetwork 字段。所以**无法**让同一个
OpenSandbox server 同时拉「普通沙箱」和「特权 netdiag 沙箱」。两个落地方式：

1. **（推荐）为 netdiag 单独跑一套 OpenSandbox server**：它的全局模板就是特权/hostNetwork。
   普通代码/浏览器沙箱用原来那套 server，互不影响。aiop 用一个独立 `clusters[]` 入口（各自
   `domain`）指向这套 ops server —— 与 aiop「每集群一个控制面 domain」的设计一致。
2. **整套部署就是为运维而生**：直接把全局模板换成本目录的特权模板，`sandbox.defaultImage`
   设为 netdiag 镜像。此时**该 server 的所有沙箱都是特权 + hostNetwork**，仅适合纯运维部署。

> 还要注意：shell 命令（`sbx__run_command`）跑在**默认会话沙箱**里（`sandbox.*` 配置），
> 而 `kubectl` 工具跑在**集群沙箱**里（`clusters[].template/domain`）。netdiag 的 fabric-admin /
> curl localhost:9013 / tcpdump 是 shell 命令，所以 netdiag 必须成为**默认会话沙箱**。
> 方式 1 下即「让该 ops 部署的 `sandbox.defaultImage` = netdiag 镜像 + 特权全局模板」。

运行期不要试图在普通主沙箱里 `kubectl apply` 本目录的模板来“升级”当前沙箱。聊天智能体通过
`sandbox_list_profiles` + `sandbox_ensure profile=netdiag` 拉起的 netdiag 运维沙箱与普通主沙箱是平级沙箱：
普通沙箱不满足 netdiag 前置检查时，应由聊天智能体创建新的 netdiag 运维沙箱，再在新沙箱内重新执行检查和诊断。

## 部署步骤

### 1) 构建镜像

```sh
cp "$(which kubectl)" deploy/opensandbox/kubectl          # 版本对齐集群
docker build -f deploy/opensandbox/Dockerfile.netdiag -t aiop/opensandbox-netdiag:dev .
# 推到集群可拉取的 registry
```

单节点本地 Docker runtime 场景可直接使用 `:dev` 本地镜像；不要用 `:latest` 做本地-only
镜像 tag，因为 Kubernetes 默认会按 `imagePullPolicy: Always` 尝试从远端拉取。

### 2) 创建 SA / RBAC / 特权模板 ConfigMap

```sh
kubectl apply -f deploy/opensandbox/netdiag-sandbox.yaml
```

- `opensandbox` namespace 会被标记为 `pod-security.kubernetes.io/enforce/audit/warn=privileged`，
  确保 privileged 运维沙箱 Pod 不被 Pod Security Admission 拦截；
- `aiop-netdiag`（ns `opensandbox`）+ 运维 ClusterRole：
  - `pods` / `services` / `configmaps`：用于动态创建探测 Pod、Service 和配套配置；
  - `deployments` / `daemonsets` / `statefulsets` / `replicasets`：用于 fabric e2e 或现场复现资源；
  - `jobs` / `cronjobs`：用于批处理式诊断任务；
  - `pods/exec`：用于进 `kube-system` 的 `fabric-node` / `fabric-ovs` 或 `default` 的 `x-tools` 容器；
  - `authorization.k8s.io`：用于 `kubectl auth can-i --list` 自检；
  - `rbac.authorization.k8s.io`：用于查看和 `apply` / `patch` RBAC 修复；
  - `namespaces`：用于创建 `fabric-e2e` 等诊断命名空间；
- `aiop-netdiag-probe-pods` Role（ns `opensandbox`）：允许创建/删除 `dns-test` 这类临时探测 Pod；
- `fabric-node-e2e` ClusterRoleBinding：允许
  `system:serviceaccount:kube-system:fabric-node-serviceaccount` 创建/清理 e2e DaemonSet。
  `fabric-admin e2e network` 会清理并重建 `fabric-e2e` namespace，所以该权限不能放在
  `fabric-e2e` namespace 内的 RoleBinding；
- ConfigMap `opensandbox-batchsandbox-template`（ns `opensandbox-system`），含
  `serviceAccountName/hostNetwork/hostPID/privileged/imagePullPolicy: IfNotPresent` + 宿主
  `/opt/cni/bin`、`/etc/cni/net.d`、`/var/run/openvswitch`、`/run/netns`、`/lib/modules` 挂载。

### 3) 让 server 使用该模板（subPath 覆盖镜像内置默认模板）

```sh
kubectl patch deployment opensandbox-server -n opensandbox-system --type=json -p='[
  {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"batchsandbox-template","configMap":{"name":"opensandbox-batchsandbox-template"}}},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"batchsandbox-template","mountPath":"/etc/opensandbox/example.batchsandbox-template.yaml","subPath":"template.yaml","readOnly":true}}
]'
```

> `helm upgrade` 会覆盖该 patch；持久化请折进 `opensandbox-server` chart（见 `README.md`）。

如果这个挂载已经存在，`kubectl apply -f deploy/opensandbox/netdiag-sandbox.yaml` 只会更新
ConfigMap。由于 Deployment 使用 `subPath` 挂载模板文件，已运行的 server Pod 不会自动看到
ConfigMap 更新，必须重启 server 并重建旧沙箱：

```sh
kubectl rollout restart deployment/opensandbox-server -n opensandbox-system
kubectl rollout status deployment/opensandbox-server -n opensandbox-system
kubectl delete pod -n opensandbox --all
```

确认 server 读到的是 netdiag 模板：

```sh
kubectl -n opensandbox-system exec deploy/opensandbox-server -- \
  grep -E 'serviceAccountName|hostNetwork|hostPID|/opt/cni/bin|/etc/cni/net.d' \
  /etc/opensandbox/example.batchsandbox-template.yaml
```

### 4) aiop 配置：把 netdiag 设为默认会话沙箱

```jsonc
"sandbox": {
  "enabled": true,
  "provider": "opensandbox",
  "domain": "opensandbox-server.opensandbox-system.svc:80",  // 这套 ops server 的地址
  "protocol": "http",
  "defaultImage": "aiop/opensandbox-netdiag:dev"
}
```

### 5) ⚠️ 核对沙箱容器名（特权/挂载是否生效）

模板里容器级字段（`privileged` + `volumeMounts`）用了占位名 `sandbox`，须与 OpenSandbox
**实际注入的容器名**一致才会合并生效：

```sh
# 先随便拉起一个沙箱（在 aiop 里跑一条命令），再查：
POD=$(kubectl get pod -n opensandbox -o name | head -1)
kubectl get -n opensandbox $POD -o jsonpath='{.spec.containers[*].name}{"\n"}'      # 真实容器名
kubectl get -n opensandbox $POD -o jsonpath='{.spec.hostNetwork} {.spec.containers[0].securityContext.privileged}{"\n"}'
```

期望：`hostNetwork=true`、对应容器 `privileged=true`。若容器名不是 `sandbox`，把
`netdiag-sandbox.yaml` 里 `containers[].name` 改成真实名并重新 apply + 重拉沙箱。

## 验证

进沙箱（或在 aiop 里走 netdiag skill）执行：

```sh
cat /var/run/secrets/kubernetes.io/serviceaccount/namespace
command -v ip && ip r
/opt/cni/bin/fabric-admin version
/opt/cni/bin/fabric-admin health show
ls -la /etc/cni/net.d
curl -s "localhost:9013/health/"
tcpdump -ni any -c 3
kubectl get pod -A | grep -E 'fabric|ovs'
```

均有输出即就绪。之后对话里说「排查 xxx pod 网络不通 / svc 不通」会自动走 `netdiag` skill。
正式排查前，skill 会先进入每个节点的 `fabric-node`/`fabric` 容器执行
`/opt/cni/bin/fabric-admin health show`；如果配置或健康状态不符合预期，会立即执行
`/opt/cni/bin/fabric-admin health fix --all --force` 并复查。

RBAC 快速自检（从任意有管理权限的终端执行）：

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

期望全部输出 `yes`。

## 安全提示

特权 + hostNetwork + hostPID + 宿主路径挂载 = 几乎等同于节点 root。务必：

- 只在受控运维场景启用；用独立 server / 独立 `clusters[]` 入口与普通沙箱隔离；
- `netdiag` skill 已约定先做逐节点 `health show`，不符合预期时执行
  `health fix --all --force`；其他变更类操作（改流表/iptables/`dp-reload`）先确认；
- 真正的硬边界是 K8s RBAC 与本模板的挂载范围，应用层（`src/agent/policy.ts`）只是补充拦截。
