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

集群外联调用 port-forward：

```sh
kubectl port-forward -n opensandbox-system svc/opensandbox-server 8899:80
# domain 设为 127.0.0.1:8899
```

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
