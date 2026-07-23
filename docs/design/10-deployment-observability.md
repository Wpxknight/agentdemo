# 部署与可观测性设计

## 1. 部署拓扑

~~~mermaid
flowchart TB
  User[User or AIOS]
  Svc[Kubernetes Service]
  Pod1[Pod replica 1]
  Pod2[Pod replica 2]
  Web1[Web container]
  API1[AIoP container]
  Web2[Web container]
  API2[AIoP container]
  DB[(External MySQL)]
  Model[Model APIs]
  OS[OpenSandbox Service]
  MCP[MCP Servers]
  K8s[Target Clusters]

  User --> Svc
  Svc --> Web1
  Svc --> Web2
  Pod1 --- Web1
  Pod1 --- API1
  Pod2 --- Web2
  Pod2 --- API2
  API1 --> DB
  API2 --> DB
  API1 --> Model
  API2 --> Model
  API1 --> OS
  API2 --> OS
  API1 --> MCP
  API2 --> MCP
  OS --> K8s
~~~

`deploy/k8s/deployment-server.yaml` 当前配置两个副本，每个 Pod 包含 Web 和 AIoP 容器。AIoP 容器监听 8081，并设置内嵌 Scheduler；Web 容器监听 8080。

## 2. 配置与 Secret

非敏感配置由 ConfigMap 中的 JSONC 提供，`AIOP_CONFIG` 指向文件。敏感值通过 Kubernetes Secret 和环境变量注入。

生产必须显式设置：

- 模型 API Key。
- `AIOP_JWT_SECRET`。
- `AIOP_SETTINGS_SECRET`。
- MySQL 连接参数。
- OIDC/AIOS client secret 或校验配置。
- Sandbox/OpenSandbox 凭据。

数据库内的设置密文不能替代 Kubernetes Secret 中的根加密密钥。

## 3. 进程生命周期

Server 启动：

1. 加载并校验配置。
2. 创建 Store 并执行迁移。
3. 组装 Runtime 和外部连接。
4. 可选启动内嵌 Scheduler。
5. 启动 HTTP listener。

SIGINT/SIGTERM 时先停止接收请求，停止 Scheduler，释放 MCP、Sandbox、下载回收器和 Store。

独立 Scheduler 使用相同 Runtime，但不启动 HTTP。CLI 执行完成后提交会话和审计，再 dispose。

## 4. 健康与就绪

Kubernetes 对 Web 和 API 容器都配置 `/healthz` 与 `/readyz`。

- liveness 只判断进程是否需要重启。
- readiness 应反映是否能接收请求。
- 外部模型或单个 MCP 短暂不可用不宜让整个 Pod 立即失活。
- MySQL 不可用会破坏持久执行，应在 readiness 和告警中重点体现。

当前接口较轻量，后续可增强依赖状态明细，但不能在健康响应中泄露 Secret 或内部错误。

## 5. 多副本协调

- Agent Run 使用数据库 Lease 和 token fencing。
- Scheduler 使用原子 claim/`SKIP LOCKED`。
- 会话与设置使用 MySQL 共享状态。
- MCP 连接和 Sandbox handle 是进程本地状态。
- Sandbox 配置 generation 在每副本独立切换。
- 下载文件若使用 Pod 本地目录，经其他副本访问可能失败；生产应使用粘性路由或共享/对象存储，这是当前部署的重要边界。

Lease 只保证所有权校验和 fencing。当前没有后台扫描器自动发现并接管 Lease 已过期但状态仍为 running 的 Agent Run，运行中心手工 resume 也只允许 failed/recovery_required。

Durable Interaction 的 waiter 是进程内状态。解析 approval/question/plan 的请求若落到另一副本，只会更新数据库，不会唤醒原执行进程；在完善轮询或消息通知前，需要粘性路由或单副本执行交互型 Agent Run。

模型、Sandbox Controller 和 MCP Manager 也是进程级单实例，并主要由 `default` 设置装配。数据库设置带 tenant key 不代表运行态已经按 tenant 隔离。

## 6. 日志、审计与指标

`pino` 输出结构化日志。常用关联字段包括 tenantId、userId、sessionId、runId、taskId、tool、cluster、node 和 error。

审计与日志不同：

- 日志面向运行诊断，可按保留策略删除。
- audit_events 是业务安全事实，需要租户授权和长期保留。
- Agent Run events 是执行时间线。
- Tool Ledger 是恢复事实。

当前可从数据和日志派生的指标：

- Agent Run 状态、耗时、steps、token。
- 模型重试和失败率。
- Tool 成功/失败、recovery_required。
- Pending Interaction 数量与等待时长。
- Scheduler 到期、成功、失败和超时。
- Sandbox 创建延迟、数量、回收和 generation 切换。
- MCP 连接状态。
- MySQL 延迟与连接失败。

仓库未集成专用 metrics SDK；以上属于应采集口径，不应声称已有 Prometheus exporter。

## 7. 故障域与降级

| 故障域 | 影响与处理 |
| --- | --- |
| 单 Pod | Service 转移新请求；Lease 到期后可被新 owner 获取，但当前没有自动接管扫描器 |
| MySQL | 会话、调度和 durable run 不可可靠工作；不能降级到独立 Memory Store 继续生产 |
| 模型 API | 当前轮重试；超过上限失败 |
| 单 MCP Server | 标记 error，其他工具继续 |
| Sandbox Provider | Sandbox 工具失败，纯模型/MCP 能力仍可运行 |
| OpenSandbox/目标集群 | 运维工具失败并审计 |
| 本地下载目录 | 可能受副本和 Pod 重建影响 |
| ConfigMap 更新 | 需重启或通过设置 API热更新相应领域 |

## 8. 发布与回滚

- 数据库迁移向前追加；回滚应用前必须确认旧版本能忽略新列/表。
- Agent Run binding 锁定 Kernel 和图版本，发布时需保留仍有 Checkpoint 的图版本。
- LangGraph 灰度可按 tenant/user/session 环境变量选择。
- Sandbox 设置先准备新 generation，再原子切换；旧 generation drain。
- 前端与 API 应保持事件向后兼容。

## 9. 运维检查

上线前至少检查：

- typecheck、Vitest、Web build。
- MySQL 8 连接和全量迁移。
- JWT/Settings Secret 不使用开发默认值。
- OIDC/AIOS 回调和 frame ancestors。
- Sandbox Profile 与特权角色。
- 两副本 Agent Run Lease 和 Scheduler claim。
- 备份与恢复。
- 下载目录跨副本策略。
- SIGTERM 下的优雅关闭。

## 10. 源码与清单依据

- `src/index.ts`
- `src/runtime.ts`
- `src/logger.ts`
- `src/db/index.ts`
- `src/agent/run-coordinator.ts`
- `src/scheduler/`
- `deploy/k8s/`
- `deploy/dev-k8s/`
- `deploy/opensandbox/`
