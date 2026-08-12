# OpenSandbox all-in-one 沙箱镜像设计

## 目标

将现有浏览器沙箱 `Dockerfile.browser` 与网络诊断沙箱 `Dockerfile.netdiag` 的运行时能力合并为一个镜像：

`deploy.bocloud.k8s:40443/aios/aiop-sandbox:latest`

统一镜像同时支持：

- Python / Shell 代码与命令执行；
- Chromium + Node.js CDP 浏览器自动化；
- `aios-request` 所需 Python 包；
- kubectl in-cluster 操作；
- tcpdump、conntrack、iptables、OVS 等网络诊断。

## 范围与边界

### 纳入 all-in-one

- `Dockerfile.browser` 的 Playwright/Chromium、Node.js、Python 依赖和 kubectl；
- `Dockerfile.netdiag` 的网络诊断工具集；
- 构建期与运行期自检；
- 根 Makefile 中准备 kubectl、构建、验证、推送的一组命令。

### 不纳入 all-in-one

- `Dockerfile.server-netdiag`：它修改的是 OpenSandbox server 的 BatchSandbox 模板合并逻辑，必须继续作为控制面 server 镜像独立部署；
- `netdiag-sandbox.yaml` 中的 privileged、hostNetwork、hostPID、宿主目录挂载和 RBAC：这些是 Pod 运行权限，无法也不应固化到镜像内；
- 宿主机 `/opt/cni/bin/fabric-admin`：继续通过 hostPath 挂载。

因此，普通 code/browser 沙箱与 netdiag 沙箱可以引用同一个运行时镜像，但只有带 `profile=netdiag` 或 `privileged=true` 的请求才会由 patched server 注入高权限模板。

## 实现方案

新增 `deploy/opensandbox/Dockerfile.allinone`，以本机构建缓存已有的 `node:24-slim` 为基础镜像，并从 Debian 仓库安装 Chromium：

1. 安装 netdiag 所需 apt 工具；
2. 安装 `requests`、`PyYAML`、`cryptography`、`openpyxl`；
3. 复制构建机 kubectl 到 `/usr/local/bin/kubectl`；
4. 安装 Debian Chromium，提供 `/usr/bin/chromium`；
5. 在构建阶段验证 Python 包、浏览器、Node.js、kubectl 与网络诊断命令。

继续使用本地 kubectl 二进制可兼容离线构建，但它绑定构建机 CPU 架构。因此本次默认构建并推送当前构建机的 `linux/amd64` 镜像，不宣称多架构支持。

## Make 命令

计划增加以下目标：

- `make sandbox-prepare-kubectl`：复制当前 `kubectl` 到忽略提交的构建上下文；
- `make sandbox-image`：构建 all-in-one 镜像；
- `make sandbox-image-check`：运行容器级能力检查；
- `make sandbox-image-push`：推送目标镜像并检查远端 manifest；
- `make sandbox-pipeline`：依次准备、构建、验证、推送。

默认变量：

```make
SANDBOX_IMAGE ?= deploy.bocloud.k8s:40443/aios/aiop-sandbox:latest
SANDBOX_PLATFORM ?= linux/amd64
```

镜像名或 tag 可通过 Make 变量覆盖。用户给出的无 tag 镜像名按 Docker 语义对应 `:latest`。

## 验证标准

- `python3` 可导入四个 Python 依赖；
- Node.js 提供全局 `fetch` 和 `WebSocket`；
- Chromium 可执行并能输出版本；
- kubectl 可执行并能输出客户端版本；
- netdiag 核心命令均存在；
- 镜像成功推送，远端 manifest 可查询。

集群中的 privileged/hostNetwork/RBAC 与宿主挂载属于部署验证，不通过单纯 `docker run` 验证。

## 风险与回退

- all-in-one 镜像明显大于独立 netdiag 镜像，节点首次拉取更慢；收益是配置统一、避免 profile 切换时维护多份运行时镜像。
- 目标集群版本为 v1.32.4；Make 会从 Kubernetes 官方发布站下载并校验对应的 linux/amd64 kubectl，避免使用构建机原有的 v1.21.8 客户端。
- 推送覆盖远端 `latest` 属于外部仓库变更；回退方式是重新推送旧 digest/tag。建议后续生产使用不可变版本 tag，同时再更新 `latest`。

## 开发计划

1. 新增 all-in-one Dockerfile；
2. 在根 Makefile 增加构建、检查、推送目标；
3. 更新 OpenSandbox README，说明统一镜像和 server/权限边界；
4. 执行 `make sandbox-image` 与 `make sandbox-image-check`；
5. 执行 `make sandbox-image-push`，确认远端 manifest/digest。
