# Sandbox 与运维设计

## 1. 分层结构

~~~mermaid
flowchart TB
  Tools[Sandbox Browser kubectl Tools]
  Controller[SandboxRuntimeController]
  Manager[SandboxManager]
  Profiles[Sandbox Profiles]
  Local[Local Provider]
  E2B[E2B Provider]
  OS[OpenSandbox Provider]
  AIOS[AIOS Lifecycle and Catalog]
  Desktop[Desktop Providers]
  Cluster[Kubernetes Clusters]

  Tools --> Controller
  Controller --> Manager
  Controller --> Profiles
  Manager --> Local
  Manager --> E2B
  Manager --> OS
  E2B --> AIOS
  Controller --> Desktop
  Tools --> Cluster
~~~

平台配置中的 Provider 只有 `local`、`e2b`、`opensandbox`。AIOS 是 E2B 兼容路径上的 Lifecycle 和模板目录集成，不是第四种 Provider。

## 2. 核心抽象

- `SandboxProvider`：create、connect、kill 等生命周期。
- `SandboxManager`：按隔离 key 懒创建、复用、使用计数、空闲回收。
- `SandboxRuntimeController`：管理当前 generation、旧 generation draining、Profile、Desktop 和热切换。
- `SandboxProfile`：模板、镜像、环境类型、runtime role、capability、namespace、service account 等。
- `DesktopProvider`：浏览器桌面能力，与代码 Sandbox 生命周期解耦。
- `SandboxAcquisition`：一次受 generation pin 保护的 handle 获取。

隔离 key 纳入 tenant、user、session 和可选 profile/cluster，避免同名会话跨租户共享环境。

## 3. Provider

### 3.1 Local

本地 Provider 用于开发和测试。它在宿主机启动受控进程，但隔离强度不等同于容器或远端 Sandbox，不能作为生产多租户安全边界。

### 3.2 E2B

E2B Provider 使用 Code Interpreter API 创建/连接 Sandbox；Desktop Provider 使用 E2B Desktop。API Key 通过设置密文或启动配置提供，不进入公开设置响应。

### 3.3 OpenSandbox

OpenSandbox Provider 通过服务地址和模板创建 Kubernetes Sandbox。仓库提供 browser/netdiag 镜像、ServiceAccount 与安全上下文示例。

### 3.4 AIOS 集成

`AiosTemplateCatalog` 从 Lifecycle 服务获取模板目录，按构建状态、runtime role 和字段规则归一化为 Profile。目录刷新产生指纹；指纹变化时准备新 generation 并原子切换。

AIOS 路径当前不支持手工 privileged profile、warm pool 和用户主目录挂载；权限来自可信模板目录中的 runtime role。

## 4. Generation 热切换

~~~mermaid
stateDiagram-v2
  [*] --> Prepared
  Prepared --> Current: commit
  Current --> Draining: settings or catalog changed
  Draining --> Disposed: operations zero and handles drained
  Prepared --> Disposed: prepare failed or abandoned
~~~

Controller 在操作开始时 pin 当前 generation。配置切换后：

1. 新操作进入新 generation。
2. 已 pin 的旧操作继续完成。
3. 旧 generation 停止接收新 acquisition。
4. operation 归零后开始 drain warm pool、Desktop 和 Manager。
5. 全部资源释放后 disposed。

该设计避免热更新直接杀死正在执行的会话。

## 5. Profile 与权限

Profile 区分 code/browser 环境、capability、desktop、privileged 和 runtime role。`sandbox-diag` 等特权 Profile 只对 platform_admin 可见和可用。

模型通过公开 Profile 摘要选择环境；服务端仍在 acquisition 时再次校验角色，不能相信模型提供的 profile 名称。

## 6. 生命周期与回收

~~~mermaid
sequenceDiagram
  participant T as Tool
  participant C as Controller
  participant M as Manager
  participant P as Provider
  participant H as Sandbox Handle

  T->>C: acquire(context, profile)
  C->>C: pin generation and validate role
  C->>M: get(spec)
  alt existing
    M-->>C: reused handle
  else missing
    M->>P: create or connect
    P-->>M: handle
  end
  C-->>T: acquisition
  T->>H: run command or code
  T-->>C: operation finished
  C->>C: unpin generation
~~~

Manager 维护 lastUsed 和 active use count。回收不会杀死正在使用的 handle；会话删除/终止可按 tenant/user/session 键回收全部关联 Sandbox。

## 7. Warm Pool 与用户主目录

Warm Pool 预创建 handle，降低首次执行延迟；关闭时等待 refill/drain，但设置超时避免进程无限阻塞。

用户主目录挂载由平台允许根路径和 Sandbox 内 mount path 双重约束。用户记录只保存相对或受校验路径，不能任意挂载宿主路径。AIOS 第一阶段禁止该能力。

## 8. Desktop、Browser 与文件导出

Desktop handle 支持截图和交互。Controller 单独缓存 Desktop，并与 session epoch 绑定；会话已销毁时，即使异步创建稍后返回也会立即 kill。

`DownloadStore` 接收 Export Tool 产物，限制大小、目录和 TTL，并生成能力 URL。下载接口验证签名/令牌，过期文件由回收器删除。

## 9. kubectl 运维

`ClusterRegistry` 保存目标集群访问方式、读写属性、生产标记、租户 ACL 和 namespace 白名单。凭据不直接写入模型上下文。

kubectl Tool 的执行位置可以是 Sandbox，目标则由 cluster 配置决定。策略在执行前检查：

- verb 与危险性。
- 角色是否有 cluster:write。
- 集群是否只读。
- 租户与 namespace。
- 生产审批。
- dry-run 和审计字段。

特权诊断环境必须由受信模板和平台管理员共同约束，不能仅依靠容器内权限。

## 10. 失败边界

| 场景 | 处理 |
| --- | --- |
| Provider 创建失败 | acquisition 失败，不缓存无效 handle |
| 异步创建后会话已删除 | 立即 kill，新结果不进入缓存 |
| 新 generation prepare 失败 | 保留当前 generation |
| 旧 generation 有活动操作 | 延迟 drain |
| 模板目录不可用 | 启动或刷新记录错误；不伪造新目录 |
| Desktop 不支持 | 不注册或拒绝 Browser 工具 |
| 导出超限或过期 | 拒绝或回收 |
| kubectl 越权 | Policy block 并审计 |

## 11. 源码依据

- `src/sandbox/types.ts`
- `src/sandbox/lifecycle.ts`
- `src/sandbox/runtime-controller.ts`
- `src/sandbox/profiles.ts`
- `src/sandbox/e2b.ts`
- `src/sandbox/opensandbox.ts`
- `src/sandbox/local.ts`
- `src/sandbox/aios-template-catalog.ts`
- `src/sandbox/aios-e2b.ts`
- `src/tools/kubectl.ts`
- `src/server/downloads.ts`
- `deploy/opensandbox/`
