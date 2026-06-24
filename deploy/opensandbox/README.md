# 在 K8s 部署 OpenSandbox（aiop 沙箱后端）

aiop 的 `sandbox.provider: "opensandbox"` 通过 [OpenSandbox](https://github.com/alibaba/OpenSandbox)
的 Lifecycle + execd API 在 k8s 内动态拉起沙箱。本文档记录在集群中部署 OpenSandbox 的
**已验证**步骤（单节点 kubeadm 集群，cri-dockerd 运行时）。

## 组件

- **controller**：reconcile `BatchSandbox` / `Pool` CRD → 真正的 Pod（含注入的 execd）。
- **server**：Lifecycle API（创建/查询/续期/删除沙箱），创建 `BatchSandbox` CR。
- 沙箱 Pod 落在 `opensandbox` 命名空间；execd 监听 44772，`ingress.mode = direct` 时
  server 直接返回 Pod IP:44772（单节点宿主机可达；多节点需 ingress-gateway）。

镜像来自阿里云公共 registry `sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/*`。

## 安装（helm）

OpenSandbox 仓库的 helm charts 在 `kubernetes/charts/`。两个子 chart 分开装更稳
（umbrella chart 的 global 合并在 helm v3.13 下有 bug）：

```sh
cd OpenSandbox/kubernetes/charts
# helm 读 docker config 需可写目录，否则报权限错
export DOCKER_CONFIG=/tmp/dockercfg-helm && mkdir -p $DOCKER_CONFIG

kubectl create namespace opensandbox          # 沙箱 Pod 所在 ns
kubectl create namespace opensandbox-system   # controller / server 所在 ns

# controller。kubeClient.qps 在 helm v3.13 的 sprig gt(float64) 下报类型错，
# 置 null 让模板短路跳过该可选参数。
helm install opensandbox-controller ./opensandbox-controller -n opensandbox-system \
  --set-json 'controller.kubeClient=null'

# server（单副本即可；config.toml 默认 runtime=kubernetes / workload_provider=batchsandbox /
# ingress.mode=direct / api_key=""）
helm install opensandbox-server ./opensandbox-server -n opensandbox-system \
  --set server.replicaCount=1
```

> CRD 若此前用 `kubectl apply` 装过（非 helm 所有），helm 接管会因 ownership 冲突失败。
> 无 CR 实例时可先 `kubectl delete crd batchsandboxes.sandbox.opensandbox.io pools.sandbox.opensandbox.io`
> 再装，让 controller chart 重新创建并持有。

就绪检查：

```sh
kubectl get pods -n opensandbox-system   # controller-manager + server 均 1/1 Running
```

## aiop 接入

集群内（aiop 也部署在 k8s）直接走 Service：

```jsonc
"sandbox": {
  "enabled": true,
  "provider": "opensandbox",
  "domain": "opensandbox-server.opensandbox-system.svc:80",
  "protocol": "http",
  "desktop": true,
  "defaultImage": "aiop/opensandbox-browser:latest"
}
```

启用 `desktop: true` 后，aiop 的代码执行、shell 命令、浏览器导航/点击/输入/截图都会按
`sessionId` 复用同一个 OpenSandbox Pod。浏览器工具不会再创建第二个沙箱；它会在该 Pod 内
启动 headless Chrome，并通过 Pod 内 Node.js CDP 脚本操作浏览器。

用于浏览器沙箱的镜像必须包含：

- `python3`（默认代码执行语言）
- `node`，且运行时提供全局 `fetch` / `WebSocket`
- `chromium`、`chromium-browser` 或 `google-chrome`
- `bash`、`curl`、`base64`、`mkdir` 等基础工具

如果只需要代码/命令执行，可以把 `desktop` 设为 `false` 并使用普通解释器镜像。

仓库提供了一个基于 Playwright Ubuntu Noble 镜像的浏览器沙箱示例镜像：

```sh
docker build -f deploy/opensandbox/Dockerfile.browser -t aiop/opensandbox-browser:latest .
```

集群外联调用 port-forward：

```sh
kubectl port-forward -n opensandbox-system svc/opensandbox-server 8899:80
# domain 设为 127.0.0.1:8899
```

## 给沙箱 Pod 绑定专属 ServiceAccount（在 Pod 内跑 kubectl）

场景：沙箱 Pod 内用 in-cluster config 直接执行 `kubectl get pods` 等查询。需要部署阶段
就建好一个**专属 SA + RBAC**，并让沙箱 Pod 以该 SA 运行。

> ⚠️ 关键点：aiop 的 `clusters[].serviceAccount` 只会作为 OpenSandbox 的 metadata /
> `AIOP_SERVICE_ACCOUNT` 环境变量透传，**batchsandbox provider 不会据此设置 Pod 的
> `serviceAccountName`** —— 它只认服务端的 `batchsandbox_template_file`。所以专属 SA 必须
> 在这里创建，并通过模板把 `serviceAccountName` 注入 Pod。

### 1) 创建 SA / RBAC / 模板 ConfigMap

```sh
kubectl apply -f deploy/opensandbox/sandbox-sa.yaml
```

- `aiop-sandbox`（ns `opensandbox`，即沙箱 Pod 所在 ns）+ 只读 ClusterRole/Binding；
- ConfigMap `opensandbox-batchsandbox-template`（ns `opensandbox-system`）含带
  `serviceAccountName: aiop-sandbox` 的 PodTemplate。

### 2) 让 server 使用该模板

server `config.toml` 默认 `batchsandbox_template_file = /etc/opensandbox/example.batchsandbox-template.yaml`
（镜像内置）。把上面的 ConfigMap 以 subPath 覆盖到该路径即可，无需改 config.toml：

```sh
kubectl patch deployment opensandbox-server -n opensandbox-system --type=json -p='[
  {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"batchsandbox-template","configMap":{"name":"opensandbox-batchsandbox-template"}}},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"batchsandbox-template","mountPath":"/etc/opensandbox/example.batchsandbox-template.yaml","subPath":"template.yaml","readOnly":true}}
]'
```

> `helm upgrade` 会覆盖该 patch。要持久化，把这段 volume/volumeMount 折进
> `opensandbox-server` chart 的 `templates/server.yaml`（ConfigMap 加一个 `template.yaml`
> key + Deployment 加挂载），并由 chart values 暴露 `serviceAccountName`。

### 3) 沙箱镜像内置 kubectl

`defaultImage`（如 `aiop/opensandbox-browser:latest`）里要装 `kubectl`，否则 Pod 内
`command not found`。kubectl 在 Pod 内自动走 in-cluster config（无需 kubeconfig）。

验证（拉起一个沙箱后在其中执行）：

```sh
kubectl get pods -n opensandbox -o jsonpath='{.items[0].spec.serviceAccountName}'  # 应为 aiop-sandbox
# 沙箱内：kubectl get pods -A 应有输出
```

### 按集群差异化 SA（设计落差）

aiop 的 `config.example.jsonc` 想做 dev=`aiop-ops`(rw) / prod=`aiop-readonly`(ro) 不同 SA。
但单个 OpenSandbox batchsandbox server 只有一个全局模板 SA，无法按请求 metadata 切 SA。要做到：

- 每个目标集群跑一套独立 OpenSandbox server（各自模板各自 SA）—— 与 aiop「每集群一个控制面
  `domain`」的设计吻合；或
- 给 OpenSandbox 的 `batchsandbox_provider.py` 提 PR，让其从 metadata 读 `serviceAccount`
  写进 `pod_spec`（改动很小）。

注意：aiop 侧 ro/rw、namespace 白名单（`src/agent/policy.ts`）只是应用层拦截，真正硬边界是
这里的 K8s RBAC，两者需对齐（prod 的 SA 只给只读 ClusterRole）。

## 验证

`scripts/verify-opensandbox.ts` 用 aiop 的 `OpenSandboxProvider` 真跑一遍
create → renew → runCommand → runCode → kill：

```sh
kubectl port-forward -n opensandbox-system svc/opensandbox-server 8899:80 &
npx tsx scripts/verify-opensandbox.ts
# ✅ 验证通过
```

> 注：`kubectl port-forward` 会关闭空闲 keepalive 连接，集群外联调时偶发
> `UND_ERR_SOCKET`；脚本对生命周期调用做了一次重试。集群内走 Service 无此问题。
