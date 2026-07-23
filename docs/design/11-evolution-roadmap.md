# 演进路线与已知限制

## 1. 使用原则

本文件只记录从当前代码可以观察到的限制与建议方向，不把路线写成已经实现的能力。优先级需要结合生产数据、故障记录和团队资源重新确认。

## 2. 当前架构基线

已具备：

- HTTP、CLI、Scheduler 统一 Agent Runtime。
- Legacy 与 LangGraph 双 Kernel 及 binding。
- MySQL Checkpoint、Interaction、Tool Ledger、Agent Run Lease 和运行中心。
- Local/OIDC/AIOS 身份与多租户 Store。
- Skill、MCP、三种 Sandbox Provider。
- React 管理与聊天界面。
- Kubernetes 双副本清单。

## 3. P0：可靠性与生产闭环

### 3.1 Agent Run 自动接管

当前 Lease 提供 fencing，但运行接管仍需明确触发和恢复策略。建议补充：

- 扫描过期 running/waiting Run。
- 区分可安全恢复、需要人工确认和不可恢复。
- 恢复前检查 graph version、pending interaction 和 tool ledger。
- 建立恢复审计与运维手册。

### 3.2 Durable Interaction 跨副本唤醒

当前 Interaction 事实写入数据库，但 waiter 是进程内 Map。建议采用数据库短轮询、数据库通知、消息队列或专用 Run Worker，使解析请求无论落到哪个副本都能唤醒拥有执行权的 Worker，并为原进程已退出的情况触发安全恢复。

### 3.3 Tool 副作用幂等

为高价值写工具定义 idempotency capability：

- 原生幂等键。
- 可查询确认。
- 可补偿。
- 不可自动恢复。

Tool Ledger 应按 capability 决定自动复用、查询确认或 recovery_required，而不是统一策略。

### 3.4 多副本下载与本地状态

Download Store 当前可使用本地目录。双副本和 Pod 重建下需要选择共享卷、对象存储或带副本粘性的下载服务。

MCP 连接、Sandbox handle 和 generation 也是副本本地状态，需要在运维文档中明确请求漂移影响。

### 3.5 运行态设置作用域

当前模型、Sandbox 和 MCP 是进程级单实例，主要从 `default` 设置装配；LLM 热更新还可能由非 default tenant 写入触发全局替换。需要明确选择平台级设置模型或实现真正的 tenant-scoped Runtime cache，并同步修正 API 权限和存储语义。

### 3.6 可观测性

增加标准指标出口和告警：

- Agent Run 状态与 Lease 丢失。
- 模型延迟、重试、token 和成本。
- 工具失败与 recovery_required。
- Interaction 等待。
- Scheduler 延迟。
- Sandbox/MCP 健康。
- MySQL 与事件积压。

## 4. P1：模块可维护性

### 4.1 拆分 Composition Root

`src/runtime.ts` 负责大量 Provider、设置和工具装配。建议按 model、sandbox、extensions、security、persistence 建立 focused builders，保留单一顶层 composition root。

### 4.2 拆分 HTTP 路由

`src/server/http.ts` 同时处理静态资源、认证、Agent、设置、管理、Skill、MCP 和 Sandbox。建议按领域拆 handler，并共享认证、错误、JSON 和 SSE 基础设施。

### 4.3 拆分 Web App

`web/src/App.tsx` 仍包含多数页面和状态。建议按 route/page/domain 拆分：

- Chat/session。
- Run center。
- Extensions。
- Scheduler/Sandbox。
- Admin/settings。

拆分前先补关键交互测试，避免纯结构重构造成行为漂移。

### 4.4 Store 分域

`Store` 接口覆盖多个领域。可以拆为 SessionStore、RunStore、IdentityStore、SettingsStore、SchedulerStore、AuditStore，再由 Runtime 组合；迁移应保持 Memory/MySQL 合同测试。

## 5. P1：安全与治理

- 为 OIDC/AIOS claims 映射提供启动校验和样例测试工具。
- 为 Secret 轮换设计双密钥解密窗口。
- 对 Hook 增加可选 fail-closed 模式和明确的健康状态。
- 为 Skill/MCP 供应链增加来源、版本、校验和与审批记录。
- 对 privileged Sandbox Profile 增加强制审计与配额。
- 将配置中的开发默认 Secret 在生产模式升级为启动失败。

## 6. P1：数据生命周期

- 实现 Checkpoint、Agent Run Event、Tool Ledger 和 Interaction 的保留作业。
- 定义审计不可删除周期。
- 增加备份恢复演练。
- 为大消息、截图和长期会话评估对象存储。
- 为迁移增加生产前 dry-run 和兼容检查。

## 7. P2：执行能力

- 将 LangGraph 图按稳定子图拆分，例如模型循环、审批、Sandbox 作业。
- 基于工具 capability 做安全并行度控制。
- 引入全局与租户级 Agent/Sandbox 并发配额。
- 为长任务提供独立 Worker/Queue，降低 HTTP Pod 压力。
- 扩展 Agent Run 的暂停、重试节点和人工修复操作。

这些能力必须继续遵守 Agent Runtime、Policy、Store 和 Tool Ledger 边界，不能把权威权限放入图状态或模型提示词。

## 8. P2：Provider 成熟度

- 对 Local/E2B/OpenSandbox 建统一合同测试。
- 为 AIOS 模板目录建立缓存、陈旧状态和回退策略。
- 验证 Desktop、文件导出和会话删除竞态。
- 量化 Warm Pool 成本与命中率。
- 明确用户主目录挂载在各 Provider 的支持矩阵。

## 9. 暂不建议

- 一次性删除 Legacy Kernel。
- 把所有业务状态塞入 LangGraph State。
- 依赖 Checkpoint 取代 Agent Run 表。
- 自动重放所有 started 工具调用。
- 仅用提示词处理权限与审批。
- 在未解决本地状态前无约束扩展副本数。
- 为追求统一而直接暴露 Provider 原始事件给前端。

## 10. 演进验收原则

每个演进项至少回答：

1. 当前可观测问题是什么。
2. 哪个稳定接口保持不变。
3. 数据迁移和回滚方式是什么。
4. 多租户与安全边界如何验证。
5. 故障注入和兼容测试是什么。
6. 是否增加新的本地状态或运维负担。

## 11. 事实依据

- `src/runtime.ts` 和 `src/server/http.ts` 的文件规模与职责。
- `web/src/App.tsx` 的页面集中度。
- `src/db/store.ts` 的跨领域接口。
- `src/agent/runtime.ts`、`run-coordinator.ts`、`tool-ledger/store.ts` 的恢复边界。
- `deploy/k8s/deployment-server.yaml` 的双副本与本地容器形态。
- 当前 package manifests 中未包含专用队列和 metrics SDK。
