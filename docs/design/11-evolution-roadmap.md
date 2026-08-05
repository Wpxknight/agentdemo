# 演进路线与已知限制

> 状态：当前设计
> 验证基线：`b5425a0d2ae3ddc23ada4d3184d4a95e3a717bae`
> 最后核对：2026-08-03
> 适用范围：`pi-agent-platform-integration` 当前实现

本文登记当前实现限制与可验证的演进方向，不代表路线项已经立项，也不承诺 Owner、排期或完成日期。是否实施应在复估节点结合生产数据、故障记录、安全要求和团队容量决策。

## 1. 演进原则

- 先补可观测事实与故障测试，再提高自动化程度。
- 保持 Durable Run、Interaction、Tool Ledger、Scheduler Fire 和 Store 的权威边界，不用进程内状态替代持久化事实。
- 数据变更必须同时定义前向转换、兼容窗口、备份恢复和应用回滚边界。
- 多租户配置、指标标签、日志与追踪均不得泄露 Credential 或形成无界高基数。
- 模块拆分以稳定接口和合同测试为前提，避免一次性重写。

## 2. 通用 Run recovery

**当前事实**

Durable Run 已有 lease/fencing、显式 resume、恢复安全检查与 recovery 事件；Scheduler 也能检查和恢复自身绑定的过期 Run。仓库没有扫描所有过期 Run 并自动分类、接管的通用 lease scanner / recovery supervisor。

**影响**

HTTP、CLI 或非 Scheduler 路径的 Worker 异常退出后，Run 可能停留在 running、waiting 或 recovery_required，需要 Run Center 或运维人员判断，恢复时延依赖人工发现。

**目标方向**

建立基于 Store 的通用恢复监督器，区分可自动恢复、需要可信 Interaction resolution、工具结果未知需人工确认和不可恢复四类；恢复必须沿用原 runId，并由新 lease token fencing 旧 Attempt。

**验收条件**

- 故障注入覆盖进程崩溃、lease 过期、心跳竞争、pending inbox、pending Interaction 和未知工具副作用。
- 同一 Run 同时只有一个有效恢复 Attempt，陈旧 Attempt 不能提交 Turn 或终态。
- 每次扫描、跳过、接管和人工阻塞均有可查询事件与审计证据。

**依赖与复估节点**

依赖 Run 状态分类、Tool capability/idempotency 约定、扫描并发控制和恢复告警。出现人工恢复积压、租约过期 Run 持续增长或独立 Worker 需求时复估。

## 3. 多副本与进程本地状态

**当前事实**

通用 Kubernetes 清单声明 2 replicas，共享 MySQL 与 RWX skills PVC；MCP 连接、Sandbox handle、下载内容、live SSE 和部分交互协调仍位于单个进程。dev/staging 因此保持单副本。

**影响**

请求漂移、Pod 重建或扩容可能使调用落到不持有本地资源的副本。2 replicas 不能单独保证交互连续性、下载可达性或端到端高可用。

**目标方向**

逐类消除或显式路由本地状态：下载迁移到共享卷或对象存储；MCP/Sandbox 以持久 ID 重连或经专用服务代理；Interaction 通过持久通知唤醒 lease owner；live SSE 保持可分离并以 durable replay 补偿。

**验收条件**

- 两副本滚动重启、请求跨副本、单 Pod 驱逐场景下，已提交 Run 事实不丢失且不会重复执行未知副作用。
- 下载、Interaction resolution、MCP 与 Sandbox 行为有明确的跨副本合同测试和失败响应。
- 运维文档标明仍需粘性会话的路径及其降级结果。

**依赖与复估节点**

依赖共享存储或对象存储、跨副本通知机制、Provider 重连语义和通用 recovery。计划增加副本、引入 HPA 或观察到 Pod 漂移故障时复估。

## 4. tenant runtime settings

**当前事实**

LLM settings API 按请求 tenant 读写 Store；但进程启动时只解析 `default` tenant 的设置，并以该 model/provider/Credential 组装一次 Durable Pi Runtime。设置更新后的 `updateModel()` 只替换 `Runtime` 暴露的 `model` 与 `modelConfig`，不会重建已捕获模型和凭据的 Durable assembly。`/v1/settings/llm/test` 使用请求 tenant 的设置或当前暴露模型，因此设置读取、连接测试与后续 Durable Run 实际使用的模型可能不一致；当前也没有按每次 Run identity 解析 tenant 模型的机制。Sandbox 主要加载 `default` tenant 设置并由单个进程级 controller 管理；MCP 配置按 tenant 读取，但连接仍属于进程实例。

**影响**

租户可保存并成功测试一组 LLM 设置，而 Durable Run 仍使用进程启动时的 default tenant provider/model/Credential，形成控制面显示与执行面事实分叉。不同 tenant 的 Durable Run 也缺少 tenant-scoped model resolution；多副本重启时间不同还会扩大配置版本差异。

**目标方向**

先明确 LLM 设置是平台级还是 tenant 级。平台级方案应统一 Store key、API 权限和所有执行入口；tenant 级方案可在每次 Run/Attempt 开始时通过 identity 解析版本化 model/provider/Credential，或对 tenant runtime assembly 做原子版本化重建与安全切换。两种方案都要定义进行中 Attempt 的配置固定规则、旧 Credential 释放和多副本失效传播。Sandbox 与 MCP 作用域另按相同原则对齐持久化和运行时语义。

**验收条件**

平台级方案：

- Store 只有一个平台权威设置 key，tenant 不能保存或读取彼此不同的模型设置。
- HTTP、CLI、Scheduler 与 Durable Run 使用同一平台配置版本。
- 只有平台管理员可变更设置，权限拒绝与设置变更审计边界均通过验证。

Tenant 级方案：

- 至少两个 tenant 配置不同 provider、model 与 Credential，分别执行真实 Durable Run，并验证 Attempt 实际调用与各自保存设置一致，不能只验证 settings test endpoint。
- Store key、API 权限、审计字段、Run identity 和运行时解析使用同一 tenant 语义。

共享验收：

- 设置更新后，新 Run 使用新版本；进行中 Attempt 固定原版本，不在一次 Attempt 内混用两套配置或 Credential。
- 失败更新保持原子，不留下部分重建；多副本在规定时间内传播并收敛到同一目标版本。
- 不再引用的 Provider 资源和旧 Credential 按可控顺序释放。

**依赖与复估节点**

依赖产品对平台级/tenant 级设置的决策、Durable assembly 的 per-run resolver 或原子重建接口、Credential 加密作用域、配置版本/失效通道和 Provider 生命周期合同。开放 tenant 自助 LLM 设置、依赖 settings test 作为上线门禁或部署多副本前复估。

## 5. metrics 与 tracing

**当前事实**

当前只有 Pino structured logs、Store audit events、Run Center 持久事实和浅层健康端点；没有 Prometheus metrics endpoint、OpenTelemetry tracing/exporter、ServiceMonitor 或 PodMonitor。

**影响**

无法直接建立 Run 成功率、lease loss、模型延迟、token/cost、工具失败、Interaction 等待、Scheduler 延迟和外部依赖健康的统一 SLI、容量基线与主动告警；跨 HTTP、Run、Tool 和 Provider 的因果定位依赖人工关联字段。

**目标方向**

先定义低基数指标和 trace context 传播，再接入 Prometheus 与 OpenTelemetry。tenantId、runId、sessionId 等高基数或敏感值保留在受控日志/trace 属性中，不作为默认指标 label。

**验收条件**

- 指标覆盖请求、Run/Attempt、lease、Interaction、Scheduler、模型、工具、MCP、Sandbox 和 Store 的关键速率、错误与延迟。
- trace 能从 HTTP 或 Scheduler 触发关联到 Attempt、模型和工具调用，并对 Credential、prompt 与工具结果执行脱敏策略。
- 提供 dashboard、告警规则、基数预算和 exporter 故障不阻塞业务的测试。

**依赖与复估节点**

依赖 SLI/SLO 定义、数据保留与访问控制、Collector/Prometheus 基础设施和容量预算。接入生产流量、发生难以定位的跨组件故障或需要容量规划时复估。

## 6. dependency readiness

**当前事实**

`/healthz` 与 `/readyz` 都固定返回 `{ ok: true }`。应用 readiness 不检查 MySQL、Model、MCP、Sandbox、Scheduler 或共享存储；dev MySQL 只有自己的 Pod probe。

**影响**

Pod 可在关键依赖不可用时继续接流量，rollout status 只能证明进程可响应，不能证明核心请求可以完成。若把所有可选依赖都设为硬门禁，又可能扩大外部故障影响面。

**目标方向**

把 liveness、启动完成与流量 readiness 分开；只将启动和核心持久化所需依赖纳入硬 readiness，对 Model、MCP、Sandbox 等按能力暴露降级状态与告警。

**验收条件**

- migration 未完成、Store 不可用或进程进入关闭阶段时 readiness 失败。
- 可选 Provider 故障不会导致无关能力整体摘流，但能通过能力状态、日志和指标观察。
- 探测具有超时、缓存或并发保护，且不输出 Secret、不放大依赖故障。

**依赖与复估节点**

依赖核心/可选依赖分级、启动状态机、指标出口和 Kubernetes rollout 策略。首次生产发布或出现“Pod Ready 但业务不可用”事件时复估。

## 7. fresh baseline 转换

**当前事实**

仓库只有 `src/db/migrations/0001_baseline.sql`；测试明确要求它是无 legacy/ALTER/DROP 的 fresh database baseline。迁移执行器能顺序应用版本文件，但仓库没有把任意历史 schema 转换到该 baseline 的脚本、dry-run 或兼容矩阵。

**影响**

空库可初始化，已有历史库不能据此宣称可原地升级。应用 Deployment rollback 也不会撤销数据库变化，旧应用可能与新 schema 不兼容。

**目标方向**

按已知来源版本提供显式 inventory、转换和校验路径；优先采用可前向兼容的 expand/contract，并把数据备份恢复作为独立于应用 rollout 的操作。

**验收条件**

- 每个受支持来源版本都有 dry-run、行数/约束校验、耗时评估和失败恢复演练。
- 应用前后版本兼容窗口、禁止回滚条件和前向修复路径可执行。
- 未识别 schema 默认停止部署，不尝试猜测式自动转换。

**依赖与复估节点**

依赖真实存量库版本清单、数据量、允许停机窗口、备份系统与兼容策略。接入首个非空历史环境或增加第二个 migration 前复估。

## 8. 代码集中度

**当前事实**

`src/runtime.ts` 集中模型、工具、策略、持久化、Skill、MCP、Sandbox 与设置装配；`src/server/http.ts` 集中多数 HTTP/SSE 路由；`web/src/App.tsx` 集中多数页面与状态；`Store` 接口覆盖多个业务域。现有测试大量直接验证这些入口，说明它们同时承担稳定集成边界。

**影响**

局部修改的影响面较大，review、测试定位和并行开发成本上升；直接按文件拆分又可能破坏初始化顺序、认证/错误语义和 Memory/MySQL 合同。

**目标方向**

保留单一 composition root，渐进提取 focused builders、领域 handlers、Web page/domain modules 和窄 Store ports；先稳定接口与合同测试，再移动实现。

**验收条件**

- 拆分前后公共 API、HTTP/SSE、启动/关闭顺序和持久化合同保持一致。
- 新增领域功能不再要求修改多个无关路由或 Provider 装配分支。
- 删除重复装配和双写路径，不长期保留新旧结构并行。

**依赖与复估节点**

依赖关键交互测试、公共 API snapshot、Memory/MySQL 合同测试和明确模块边界。单文件冲突持续阻塞交付、变更回归率升高或需独立扩缩 Worker 时复估。

## 9. Hook 未接入执行链

**当前事实**

仓库实现并测试了 `HookRunner.preTool()`，`buildRuntime()` 也创建并暴露 `runtime.hooks`；当前 `src/` 与 `packages/` 的工具执行链没有调用它。Hook 执行异常按实现 fail-open，注释也明确合规硬拦截应由 permission policy 承担。

**影响**

配置 `hooks.preToolUse` 不会影响当前 Agent 工具执行，操作者可能误以为外部审批或告警已接入；若直接接入且继续 fail-open，也不能把它当作强制安全控制。

**目标方向**

先确定 Hook 是通知/软治理还是可选硬门禁，再在 Governed Tool Execution 的单一位置接入，避免 HTTP 直调、Agent、Scheduler 或恢复路径行为不一致。强制策略仍以服务端 permission/policy 为权威。

**验收条件**

- Agent、直接 Tool API、Scheduler 和恢复路径对同一工具调用具有一致的 Hook 顺序与审计结果。
- 超时、非零退出、webhook 拒绝、SSRF 防护和 fail-open/fail-closed 模式都有合同测试。
- 文档和配置 schema 明确 Hook 失效语义，不能把通知型 Hook 宣称为权限边界。

**依赖与复估节点**

依赖工具执行单一入口、策略顺序决策、超时预算和外部 Hook 可用性目标。首次准备启用 `hooks.preToolUse` 配置或把外部审批纳入合规流程前复估。

## 10. 文档质量门

**当前事实**

设计文档以固定验证基线人工核对，仓库当前没有自动验证 Mermaid 可渲染、内部链接有效、metadata 完整或事实声明仍与 manifests/Makefile/源码一致的文档质量门。

**影响**

代码、清单和命令变化后，文档可能继续通过普通代码测试但产生失效链接、不可渲染图或能力漂移；部署类误述会直接增加操作风险。

**目标方向**

把格式、链接、Mermaid 渲染和关键事实断言纳入 CI；对版本、端口、副本数、Make target、健康语义和 migration 基线优先采用可自动检查的来源或测试。

**验收条件**

- CI 检查 01～13 metadata、站内链接、重复 heading/anchor 和 Mermaid 渲染。
- 对部署与能力边界设置负向断言，禁止把未实现的 metrics、tracing、依赖 readiness、通用 recovery 或任意旧库升级写成当前能力。
- 事实基线变化时有明确的文档复核清单，失败会阻止合并。

**依赖与复估节点**

依赖选定 Markdown/link/Mermaid 工具、CI 运行环境和可维护的事实断言。设计文档重建完成、首次发现文档导致部署误操作或部署清单大改时复估。

## 11. 复估方法

每次复估至少记录：

1. 触发问题及可观测证据；
2. 当前稳定接口与不能破坏的数据事实；
3. 备选方案及成本、可用性、安全性和运维 trade-off；
4. 数据迁移、灰度、回滚或前向修复方式；
5. 多租户、故障注入和兼容性验收结果；
6. 新增本地状态、基础设施依赖和长期运维负担。

未满足验收条件的接口、表字段、清单或原型仍属于准备工作，不能移入当前能力说明。
