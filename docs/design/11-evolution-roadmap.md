# 演进路线与已知限制

## 1. 使用原则

本文件只记录从当前代码可以观察到的限制与建议方向，不把路线写成已经实现的能力。优先级需要结合生产数据、故障记录和团队资源重新确认。

## 2. 当前架构基线

已具备：

- HTTP、CLI、Scheduler 统一 Agent Runtime。
- 单一 Durable Pi Runtime；旧 Kernel、LangGraph 和 compatibility surface 已删除。
- MySQL Pi Session、Interaction、Tool Ledger、Agent Run Lease、Inbox、Event 和运行中心。
- Local/OIDC/AIOS 身份与多租户 Store。
- Skill、MCP、三种 Sandbox Provider。
- React 管理与聊天界面。
- 单副本 staging 清单与双副本通用部署模板。

### 2.1 如何判断路线项仍未实现

路线项只有同时满足“源码入口、持久化语义、测试、部署/运维入口”才可移入当前能力。例如存在接口或表字段但没有 supervisor 和故障测试，不能写成已经具备自动接管。

| 能力 | 当前已有证据 | 仍缺什么 |
| --- | --- | --- |
| Durable Run | manager、lease/fencing、Memory/MySQL tests | 通用过期 Run 自动扫描接管 |
| Durable Interaction | 表、replay、resume tests | 全部交互类型的跨副本通知/协调 |
| Scheduler recovery | bound Fire inspection/resume tests | 与独立 Worker 部署的生产验证 |
| 多副本部署 | 通用 2-replica manifest | 本地下载、连接、handle 与直接交互协调 |
| 可观测性 | pino、audit、run events、ledger | metrics exporter、告警和容量基线 |
| 数据升级 | 单一 baseline 与 migration tests | 历史数据库转换/dry-run/回滚工具 |

## 3. P0：可靠性与生产闭环

### 3.1 Agent Run 自动接管

当前 HTTP Run 可显式 resume，Scheduler 可恢复 bound fire，但尚无通用的过期 Run 自动扫描 supervisor。建议补充：

- 扫描过期 running/waiting Run。
- 区分可安全恢复、需要人工确认和不可恢复。
- 恢复前检查 committed Pi leaf、pending interaction、inbox 和 tool ledger。
- 建立恢复审计与运维手册。

### 3.2 Durable Interaction 跨副本唤醒

Agent Interaction 事实已写入数据库，但 live Attempt 与部分直接 Tool approval/question 仍有进程内协调。建议采用数据库通知、消息队列或专用 Run Worker，使解析请求无论落到哪个副本都能唤醒拥有执行权的 Worker，并为原进程已退出的情况触发安全恢复。

### 3.3 Tool 副作用幂等

为高价值写工具定义 idempotency capability：

- 原生幂等键。
- 可查询确认。
- 可补偿。
- 不可自动恢复。

当前已有 `read/retryable_write/non_idempotent_write` capability 和 `recovery_required`；后续应为关键外部系统补齐原生幂等键、结果查询与补偿 adapter，减少人工判定。

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

## 6. P1：数据生命周期与升级

- 实现 Pi Session Entry、Agent Run Event、Tool Ledger 和 Interaction 的保留作业。
- 定义审计不可删除周期。
- 增加备份恢复演练。
- 为大消息、截图和长期会话评估对象存储。
- 为 `src/db/migrations/0001_baseline.sql` 之外的存量环境提供显式 schema 转换、dry-run 和兼容检查。

## 7. P2：执行能力

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

- 重新引入第二套通用 Agent loop 或 Kernel 选择器。
- 依赖 Pi Session 取代 Agent Run、Interaction 或 Tool Ledger。
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

建议每个路线项在合并前补一段“删除了什么旧假设”。例如引入专用 Worker 后，应明确 HTTP Pod 是否仍可本地持有活跃 Attempt；否则新旧模型会长期并存。

## 11. 事实依据

- `src/runtime.ts` 和 `src/server/http.ts` 的文件规模与职责。
- `web/src/App.tsx` 的页面集中度。
- `src/db/store.ts` 的跨领域接口。
- `packages/pi-runtime/src/run/`、`packages/pi-runtime/src/tools/` 与 `src/agent/run-center.ts` 的恢复边界。
- `deploy/k8s/deployment-server.yaml` 的双副本与本地容器形态。
- 当前 package manifests 中未包含专用队列和 metrics SDK。
