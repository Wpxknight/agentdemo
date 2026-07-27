# Agent Runtime、Agent Loop 与 Agent Core 设计

> 历史说明：本章保留退役前 Legacy/LangGraph 双 Kernel 设计。现行实现使用 Legacy/Pi，新运行不再加载 LangGraph；请以[第 12 章](./12-pi-integration-plan.md)和 `packages/agent-runtime-*` 为准。

## 1. 文档目标与所有权标记

本文说明 AIoP 的 Agent 执行架构，重点回答四个问题：

1. `AgentRuntime`、`AgentKernel`、Agent Loop 和 Agent Core 分别是什么。
2. Legacy 与 LangGraph 两条执行路径如何共享同一组平台能力。
3. 哪些能力来自开源组件，哪些是 AIoP 自研，哪些属于混合封装。
4. Checkpoint、Agent Run、Interaction、Session 和 Tool Ledger 为什么不能互相替代。

本文使用以下标记：

| 标记 | 含义 | 判断标准 |
| --- | --- | --- |
| **开源引用** | 直接使用外部项目提供的协议、运行机制或基础类型 | 主要行为由依赖包定义，AIoP 只调用公开 API |
| **自研** | AIoP 定义并维护的业务契约、控制逻辑或完整实现 | 行为、状态和失败语义由本仓库源码决定 |
| **混合封装** | 基于开源协议实现 AIoP 特有的适配、扩展或持久化 | 外部项目定义扩展点，AIoP 实现业务语义 |

核心结论：**LangGraph 是 `AgentKernel` 内部使用的开源执行引擎，不是 AIoP 的完整 Agent Runtime。**

## 2. 概念与所有权速览

| 概念 | 当前含义 | 所有权 | 事实入口 |
| --- | --- | --- | --- |
| Agent Runtime | HTTP、CLI、Scheduler 共用的稳定执行入口；选择 Kernel、锁定图版本、协调业务 Run | **自研** | `src/agent/runtime.ts` |
| Agent Kernel | 可替换执行内核契约，输入输出统一为 `RunAgentOptions` / `RunAgentResult` | **自研** | `src/agent/kernel.ts` |
| Legacy Agent Loop | TypeScript `while` 循环实现的 model → tools → model 执行路径 | **自研** | `src/agent/core.ts` |
| LangGraph 运行引擎 | `StateGraph`、`Annotation`、Checkpoint、`interrupt()`、`Command` | **开源引用** | `@langchain/langgraph`、`@langchain/langgraph-checkpoint` |
| LangGraph Kernel | 把 AIoP 运行契约映射为 LangGraph thread、graph invoke、interrupt/resume | **混合封装** | `src/agent/langgraph/kernel.ts` |
| AIoP Agent Graph | `prepare → model ↔ tools` 的状态、节点和路由规则 | **自研** | `src/agent/langgraph/graph.ts`、`state.ts` |
| Agent Core 契约 | 两种 Kernel 共用的 options、result、消息、模型轮次和工具执行语义 | **自研** | `src/agent/core.ts`、`src/agent/services/**` |
| Model Adapter 基础 SDK | Anthropic/OpenAI SDK、LangChain 基础类型 | **开源引用** | 根目录 `package.json` |
| Model Adapter | 基于供应商 SDK 实现中立消息和流事件转换 | **混合封装** | `src/model/anthropic.ts`、`openai.ts` |
| Model Gateway | 模型轮次、重试、工具过滤和 usage 聚合 | **自研** | `src/agent/services/model-gateway.ts` |
| Tool Broker | Policy、Approval、Hook、Ledger、dispatch 固定执行链 | **自研** | `src/agent/services/tool-broker.ts` |
| Agent Run Coordinator | Lease、fencing、取消、节点事件和终态 | **自研** | `src/agent/run-coordinator.ts` |
| MySQL Checkpoint Saver | 实现 LangGraph Saver 协议并增加 tenant、run、graph version、TTL | **混合封装** | `src/agent/checkpoint/mysql.ts` |
| Durable Interaction | 审批、问题、计划的持久记录、授权解析和等待 | **自研** | `src/agent/interactions/store.ts` |
| Tool Ledger | 工具副作用开始、完成、复用和 recovery_required | **自研** | `src/agent/tool-ledger/store.ts` |

仓库中没有名为 `AgentCore` 的类或 interface。本文所称 **Agent Core** 是架构术语，表示两个 Kernel 共享的运行契约与服务。`src/agent/core.ts` 目前承担两类职责：

- 定义 `RunAgentOptions`、`RunAgentResult` 和共享常量。
- 实现 Legacy Kernel 使用的 `runAgent()` Agent Loop。

共享实现已拆到 `src/agent/services/`，包括 Prompt、Context Service、Model Gateway、Tool Broker 和 Session Committer。LangGraph Kernel 直接复用这些服务，因此不会绕过 AIoP 的模型、上下文或工具安全语义。

## 3. 总体架构

~~~mermaid
flowchart TB
  Caller[HTTP CLI Scheduler]
  Runtime[AgentRuntime 自研]
  Binding[Run Binding 自研]
  Coordinator[Run Coordinator 自研]
  Contract[RunAgentOptions Result 自研]
  Legacy[Legacy Kernel 自研]
  Loop[runAgent Loop 自研]
  LGKernel[LangGraph Kernel 混合封装]
  LGEngine[LangGraph Engine 开源引用]
  Graph[AIoP Graph 自研]
  Services[Prompt Context Model Gateway Tool Broker 自研]
  Store[Store 自研契约]
  Checkpoint[MySQL Saver 混合封装]

  Caller --> Runtime
  Runtime --> Binding
  Runtime --> Coordinator
  Runtime --> Contract
  Contract --> Legacy
  Contract --> LGKernel
  Legacy --> Loop
  Loop --> Services
  LGKernel --> LGEngine
  LGEngine --> Graph
  Graph --> Services
  LGKernel --> Checkpoint
  Binding --> Store
  Coordinator --> Store
  Services --> Store
  Checkpoint --> Store
~~~

这是一种“自研稳定外壳 + 可替换 Kernel + 共享核心服务”的架构：

- 外部入口只依赖 `AgentRuntime.run()`，不依赖具体 Kernel。
- Legacy 和 LangGraph 使用相同的 `RunAgentOptions` 与 `RunAgentResult`。
- 两条路径复用 Model Gateway、Context Service 和 Tool Broker。
- LangGraph 只替换循环的表达和持久化执行机制，不替换业务控制面。

## 4. `RunAgentOptions`：两种 Kernel 的稳定输入契约

`RunAgentOptions` 位于 `src/agent/core.ts`，是整个 Agent 执行面的主要依赖注入边界。重要字段可按职责分组：

| 分组 | 字段 | 作用 |
| --- | --- | --- |
| 运行身份 | `runId`、`ctx` | 关联 tenant、user、session、Checkpoint、Interaction 和 Ledger |
| 模型与工具 | `model`、`tools`、`policy` | 注入中立模型、工具注册表和策略执行器 |
| 输入 | `task`、`taskContentBlocks`、`messages` | 支持新任务、附件和已有会话历史 |
| 流式输出 | `onEvent` | 向 HTTP/SSE、CLI 或日志报告中立事件 |
| 活动会话 | `drainPendingMessages` | 在模型轮次边界合并运行中的追加消息 |
| 上下文 | `contextBudgetTokens`、`keepImages`、`summarize`、压缩水位字段 | 控制硬裁剪与摘要压缩 |
| 工具安全 | `approval`、`filterToolDefs`、`hooks`、`toolLedger` | 控制模型可见工具和真实执行链 |
| 人机交互 | `askUser`、`requestPlanApproval`、`durableInteractions` | 支持兼容内存等待和 LangGraph interrupt 路径 |
| 运行治理 | `maxSteps`、`unattended`、`signal` | 限制步数、无人值守行为和取消传播 |
| Run 生命周期 | `runLifecycle`、`runGuard`、`resumeFromCheckpoint` | 节点观测、Lease fencing、取消和恢复 |

`RunAgentResult` 统一返回最终消息、最后一轮文本、步数、累计 usage 和是否发生摘要压缩。调用方因此无需根据 Kernel 编写两套提交逻辑。

## 5. `AgentRuntime`：自研稳定入口

`AgentRuntime` 本身不执行模型循环。它负责平台级选择与治理：

1. 根据固定配置或 rollout 规则选择 `legacy` / `langgraph`。
2. 对带 `runId` 的执行读取或创建 `AgentRunBinding`。
3. 锁定 Kernel、graph name 和 graph version。
4. 从 `AgentRunCoordinator` 获取执行 lease。
5. 把 lifecycle observer 与 guard 注入 Kernel。
6. 根据 Kernel 结果写成功、失败、取消或 recovery_required 终态。

~~~mermaid
sequenceDiagram
  participant C as Caller
  participant R as AgentRuntime 自研
  participant B as Binding Store 自研
  participant O as Run Coordinator 自研
  participant K as Selected Kernel
  participant S as Store 自研

  C->>R: run options
  R->>B: get or create binding
  B-->>R: locked kernel and graph version
  R->>O: start run
  O->>S: acquire lease and mark running
  O-->>R: lifecycle and guard
  R->>K: run enriched options
  K-->>R: result or error
  alt success
    R->>O: succeed result
  else cancelled or failed
    R->>O: fail error
  end
  R-->>C: result or error
~~~

### 5.1 Kernel 选择

`AIOP_AGENT_KERNEL` 支持：

- `legacy`：默认路径。
- `langgraph`：LangGraph Kernel 初始化失败时告警并回退 Legacy。
- `tenant-rule`：按测试租户、内部用户和会话集合灰度选择。

### 5.2 Binding 与版本锁定

Binding 使用 `tenantId + runId` 定位，并保存 `userId`、`sessionId`、Kernel、graph name 和 graph version。恢复时必须同时满足：

- 当前用户和会话与原 Run 一致。
- Kernel 与原 Run 一致。
- LangGraph graph name/version 与原 Checkpoint 兼容。

该机制是 **自研发布治理**，不是 LangGraph 自动提供的能力。

## 6. Legacy Kernel 与自研 Agent Loop

`LegacyAgentKernel` 是很薄的 **自研适配器**，只调用 `runAgent(options)`。真正的 Agent Loop 位于 `src/agent/core.ts`。

~~~mermaid
flowchart TD
  Start[构造消息和 system prompt]
  Boundary[轮次边界合并消息并尝试摘要]
  Model[Model Gateway 流式调用]
  Save[追加 assistant 消息]
  Calls{是否有 tool calls}
  Tools[Tool Broker 并发执行]
  Feedback[追加 tool results]
  Pending{是否有 pending messages}
  Limit{达到 maxSteps}
  End[返回 RunAgentResult]

  Start --> Boundary --> Model --> Save --> Calls
  Calls -->|有| Tools --> Feedback --> Limit
  Limit -->|否| Boundary
  Limit -->|是| End
  Calls -->|无| Pending
  Pending -->|有| Boundary
  Pending -->|无| End
~~~

### 6.1 完整执行顺序

1. 复制历史消息，并把本次 task/附件追加为 user 消息。
2. 通过 `buildSystemPrompt()` 合并聊天规则、无人值守规则和运行期 system 文本。
3. 在每个模型轮次边界检查 AbortSignal，并排空活动会话追加消息。
4. 调用 `compactAtBoundary()`；满足阈值时摘要旧历史，失败则保留原消息继续。
5. 调用 `runModelTurn()`；它执行工具定义过滤、请求前硬裁剪、模型流消费、usage 聚合和整轮重试。
6. 把文本、thinking、thinking blocks 和 tool calls 追加为 assistant 消息。
7. 没有 tool calls 时再次检查 pending messages；没有新增消息则完成。
8. 有 tool calls 时调用 `executeToolCalls()`，经 Tool Broker 执行安全链。
9. 把结果按原 call 顺序追加为 tool 消息，进入下一轮模型调用。
10. 模型不再调用工具或达到 `maxSteps` 后返回统一结果。

### 6.2 Legacy 路径的边界

- Legacy Loop 不使用 LangGraph StateGraph 或 Checkpoint。
- 它仍然使用 Agent Run Coordinator、Tool Ledger、Store 和 Session Committer。
- `askUser`、Approval 和 Plan 可使用入口层提供的内存等待回调。
- Legacy Loop 当前没有把 `runGuard` 继续传给 Model Gateway 或 Tool Broker，主要依赖 AbortSignal。它虽然被 Run Coordinator 包裹并持有 lease，但不会像 LangGraph 路径一样在节点/模型/工具边界执行 fencing guard。

## 7. LangGraph Kernel：开源引擎与自研图的组合

LangGraph 路径必须拆成三层理解：

| 层 | 所有权 | 内容 |
| --- | --- | --- |
| LangGraph 运行机制 | **开源引用** | `StateGraph`、`Annotation`、`START/END`、条件边、Checkpoint、`interrupt()`、`Command`、`graph.invoke()` |
| AIoP LangGraph Kernel | **混合封装** | 把 runId 映射为 thread id，注入 tenant/run/graph metadata，设置 recursion limit，处理 invoke 与 resume |
| AIoP Agent Graph | **自研** | 状态字段、prepare/model/tools 节点、路由、上下文治理、模型调用、工具安全链和生命周期事件 |

### 7.1 自研图状态

`src/agent/langgraph/state.ts` 使用开源 `Annotation.Root` 声明状态，但字段由 AIoP 定义：

- `messages`：中立消息历史。
- `text`：最后模型文本。
- `steps`：模型轮次数。
- `usage`：跨轮次累计用量。
- `compacted` / `compactionWatermark`：摘要状态。
- `calls`：本轮 ToolCall。
- `continueModel`：下一跳控制。

因此状态容器机制是 **开源引用**，状态 Schema 与业务含义是 **自研**。

### 7.2 自研图节点与路由

~~~mermaid
flowchart TD
  Start[START 开源机制]
  Prepare[prepare 自研节点]
  Model[model 自研节点]
  Tools[tools 自研节点]
  End[END 开源机制]

  Start --> Prepare --> Model
  Model -->|有 tool calls| Tools
  Tools -->|steps 小于 maxSteps| Model
  Tools -->|达到上限| End
  Model -->|有 pending messages| Model
  Model -->|无调用且无新增消息| End
~~~

- `prepare`：检查取消并复制消息。
- `model`：合并 pending messages、摘要压缩、调用自研 Model Gateway、累计 usage。
- `tools`：调用自研 Tool Broker，并把 durable approval/question/plan 映射成 LangGraph interrupt。
- `observedNode`：执行 Run guard，并把节点开始、完成和失败写入自研 Run 生命周期。

### 7.3 Interrupt 与 Durable Interaction

LangGraph 提供 `interrupt()` 和 `Command(resume)`，但不提供 AIoP 的业务交互记录与授权。当前流程是：

1. Tool Broker 判断需要审批、问题或计划确认。
2. AIoP `DurableInteractionService.create()` 持久化 interaction。
3. 图节点调用开源 `interrupt({ interactionId })`。
4. Kernel 观察到 interrupted 状态，把 Agent Run 标为 waiting。
5. HTTP API 按 tenant/user/session/run 校验并解析 interaction。
6. Kernel 通过自研 `wait()` 取得可信 resolution。
7. 用开源 `Command({ resume })` 恢复图执行。

这是典型的 **混合封装**：暂停恢复原语来自 LangGraph，交互业务语义来自 AIoP。

## 8. 两种 Kernel 共享的自研 Agent Core 服务

### 8.1 Prompt Service

`buildSystemPrompt()` 合并聊天行为、无人值守限制和调用方额外提示。提示词只引导模型，不承担权限控制。

### 8.2 Context Service

`compactAtBoundary()` 在模型轮次边界执行摘要压缩：

- 超过触发线且高于 watermark 才运行。
- 保留真实 user 输入和近期消息。
- 摘要失败不破坏原历史。
- 通过 `context_compacted` 报告压缩结果。

请求前硬裁剪位于 `src/agent/context.ts`，确保发送给模型的消息不超过预算。

### 8.3 Model Gateway

`runModelTurn()` 是自研的 Provider 中立模型轮次：

- 调用 `ChatModel.stream()`。
- 聚合 text、thinking、thinking blocks、ToolCall 和 usage。
- 过滤模型可见工具定义。
- 对可重试错误执行整轮指数退避。
- 通过 `model_retry` 通知前端回滚失败尝试的增量展示。
- 观察 AbortSignal 和 Run guard。

Anthropic/OpenAI SDK 是 **开源引用**；`ChatModel`、Adapter 和 Model Gateway 的业务转换是 **自研**。

### 8.4 Tool Broker

Legacy 和 LangGraph 都调用同一个 `executeToolCalls()`。固定链路是：

1. Run guard 与 AbortSignal。
2. Policy。
3. Approval 或 durable interaction。
4. PreToolUse Hook。
5. Tool Ledger begin/reuse。
6. Tool Registry dispatch。
7. Tool Ledger complete。
8. 发出 tool output/result 事件。

LangGraph 的 ToolNode 或 prebuilt ReAct Agent 当前没有替代该链路。模型或图节点不能直接 dispatch 工具。

## 9. Agent Run、Checkpoint 与业务持久化

这些机制共同支持 durable execution，但保存不同事实：

| 机制 | 所有权 | 主键/身份 | 保存内容 | 不负责 |
| --- | --- | --- | --- | --- |
| Agent Run Binding | **自研** | tenant + runId | user、session、Kernel、graph name/version | 图状态、工具结果 |
| Agent Run / Event | **自研** | tenant + runId | 状态、节点、lease、取消、用量、时间线 | 图 channel 数据 |
| LangGraph Checkpoint 协议 | **开源引用** | thread + namespace + checkpoint | 图状态、metadata、pending writes 的协议 | 用户授权、lease、业务审计 |
| MySQL Checkpoint Saver | **混合封装** | thread + namespace + checkpoint | 按开源协议保存图状态，并扩展 tenant/run/version/TTL | Agent Run、Session、Ledger |
| Durable Interaction | **自研** | tenant + interactionId | approval/question/plan、payload、resolution、授权归属 | 图的完整计算状态 |
| Tool Ledger | **自研** | tenant + runId + toolCallId | started/completed/recovery_required、结果摘要 | 模型上下文、会话消息 |
| Session Messages | **自研 Store** | tenant + sessionId | 可展示和续接的消息历史 | Run 执行所有权 |
| Audit | **自研** | tenant + event identity | 安全与使用记录 | Checkpoint 恢复 |

### 9.1 MySQL Checkpoint Saver

`MysqlCheckpointSaver` 继承 LangGraph `BaseCheckpointSaver`，因此属于 **混合封装**：

- 开源协议定义 `getTuple`、`list`、`put`、`putWrites` 和 `deleteThread`。
- AIoP 实现 Memory/Kysely persistence。
- AIoP 增加 tenant、runId、graph name/version、expiresAt。
- 协议兼容由 `@langchain/langgraph-checkpoint-validation` 与项目测试保护。

### 9.2 Session Committer

Kernel 只返回 `RunAgentResult`。消息如何成为会话事实由自研 `SessionCommitter` 决定：

- 摘要压缩后整体替换历史。
- 未压缩时只追加本次新增消息。
- 失败或终止时保留用户输入、已流式文本/思考和明确结果。
- 最后一条 assistant 消息记录运行时长。

## 10. Lease、取消与多副本 fencing

`AgentRunCoordinator` 是自研的多副本业务 Run 协调器：

- 默认 lease TTL 为 30 秒。
- owner 周期续约，token 单调递增。
- guard 校验 owner、token、过期时间和取消标记；当前由 LangGraph 路径显式使用。
- LangGraph 节点开始、完成、失败写入 Run Event。
- lease 丢失时旧 owner 停止写最终状态。
- 普通错误、取消和未知副作用映射为不同终态。

LangGraph Checkpoint 可以恢复图状态，但不能证明当前副本仍拥有业务 Run。因此 Checkpoint 不能替代 lease/fencing。

## 11. Tool Ledger 与副作用恢复

`DurableToolLedger` 使用 `tenantId + runId + toolCallId` 标识一次工具调用：

1. dispatch 前写 `started`。
2. 已有 `completed` 记录时复用结果。
3. 已有未完成记录时，说明进程可能在副作用后崩溃。
4. 此时转为 `recovery_required`，禁止自动重放。
5. dispatch 成功后写 `completed` 和结果。

Checkpoint 只能说明图是否准备再次执行 tools 节点，无法确认外部系统的副作用是否已经发生。因此 Tool Ledger 也是不可被 LangGraph 自动替代的自研安全机制。

本设计提供 at-most-once 倾向和人工恢复入口，不承诺 exactly-once。目标系统仍应提供幂等键、状态查询或补偿操作。

## 12. 流式事件与入口边界

两种 Kernel 都通过 `StreamEvent` 报告 thinking/text delta、tool_call、tool_output、tool_result、model_retry、usage、context_compacted 等事件。

- HTTP 将事件编码为 SSE。
- CLI 只消费需要的文本增量。
- Session Committer 根据最终结果提交消息。
- Run Coordinator 保存业务运行状态与节点事件。

SSE 是实时传输通道，不是持久化；Checkpoint 是图状态，不是前端消息历史。

## 13. 故障与恢复边界

| 故障 | 当前处理 | 主要责任方 |
| --- | --- | --- |
| 模型临时错误或断流 | 整轮重试并通知前端丢弃失败尝试输出 | 自研 Model Gateway |
| 4xx 参数或鉴权错误 | 除 408/429 外不重试 | 自研 Model Gateway |
| 客户端断开或用户取消 | AbortSignal 传播；LangGraph 节点/模型/工具边界还执行 Run guard | HTTP + 自研 Runtime/Tool Broker |
| Lease 丢失 | 旧 owner 停止，不覆盖新 owner 状态 | 自研 Run Coordinator |
| 图执行中断 | Checkpoint 保存状态，interaction 解析后 Command resume | LangGraph 开源原语 + AIoP 混合封装 |
| 工具结果已完成 | Ledger 复用持久化结果 | 自研 Tool Ledger |
| 工具 started 但结果未知 | `recovery_required`，禁止自动重放 | 自研 Tool Ledger/Coordinator |
| 图版本不匹配 | binding 校验失败，拒绝恢复 | 自研 Agent Runtime |
| 交互在另一副本解析 | Store 状态更新，但原进程 waiter 不会自动唤醒 | 当前自研 Interaction 限制 |
| Lease 过期 | 新 owner 可获取；没有后台扫描器自动接管 running Run | 当前自研 Run 限制 |

## 14. 开源替代与演进判断

没有一个开源项目可以无损替换完整 AIoP Agent Runtime。应按子问题评估：

| 当前部分 | 可评估方案 | 适用条件 | 不应误解为 |
| --- | --- | --- | --- |
| 三节点 Agent Graph | LangGraph prebuilt agent / LangChain 高层 agent | 图长期保持标准 ReAct，且定制节点语义很少 | 可替代 Tool Broker、Run Coordinator 或 Store |
| MySQL Checkpoint Saver | LangGraph 官方维护的数据库 Checkpointer | 可以采用其支持的数据库并接受数据迁移 | 可替代 Agent Run、Session 或 Ledger |
| 长时间等待与跨副本恢复 | Temporal 等 durable workflow 引擎 | 长任务、多 worker、timer/signal 和自动接管成为主需求 | 低成本替换 LangGraph；两者边界仍需设计 |
| 权限规则决策 | OPA 或 Cedar | 策略需要跨产品集中治理 | 可替代 Approval、Hook、Ledger 和 dispatch |
| Agent 可观测性 | OpenTelemetry + Langfuse/Phoenix | 需要标准 trace 与模型质量分析 | 可替代业务 Run、审计和持久化事实 |
| 模型路由 | LiteLLM Proxy 等 | Provider 数量、限流和路由复杂度明显增长 | 可消除中立事件和项目特有 usage 适配 |

当前推荐保留“自研 Agent Runtime + 双 Kernel + 共享 Core 服务”。更高优先级的演进是跨副本 interaction 唤醒、Checkpoint 兼容维护和标准可观测性，而不是整体替换 Agent 框架。

## 15. 修改影响地图

| 修改目标 | 首选文件 | 必须检查 |
| --- | --- | --- |
| 修改稳定运行参数或结果 | `src/agent/core.ts` | 两种 Kernel、HTTP/Scheduler/CLI 调用方、parity tests |
| 修改 Legacy Loop | `src/agent/core.ts` | `tests/agent.test.ts`、`agent-behavior-v1.test.ts` |
| 修改 LangGraph 图拓扑 | `src/agent/langgraph/graph.ts`、`state.ts` | graph version、旧 Checkpoint、parity/recovery tests |
| 修改 Kernel rollout | `src/agent/runtime.ts` | binding、并发写、租户灰度测试 |
| 修改模型轮次 | `src/agent/services/model-gateway.ts` | 两种 Kernel、重试和流事件测试 |
| 修改上下文压缩 | `src/agent/context.ts`、`services/context-service.ts` | 消息配对、图片、摘要、Session Committer |
| 修改工具执行顺序 | `src/agent/services/tool-broker.ts` | Policy、Approval、Hook、Ledger、安全测试 |
| 修改 Run 状态或 lease | `src/agent/run-coordinator.ts`、`src/db/store.ts` | Memory/MySQL、运行中心、取消与恢复测试 |
| 修改 Checkpoint | `src/agent/checkpoint/**`、迁移 | Saver 合同、graph version、恢复测试 |
| 修改 Interaction | `src/agent/interactions/store.ts`、HTTP API | tenant/user/session/run 授权和跨副本语义 |

## 16. 测试证据

| 测试 | 保护的边界 |
| --- | --- |
| `tests/agent.test.ts` | Legacy Agent Loop、工具反馈、重试、压缩和步数限制 |
| `tests/agent-behavior-v1.test.ts` | 多种 Kernel 的共享行为基线 |
| `tests/agent-runtime.test.ts` | Kernel 选择、binding 与 rollout |
| `tests/agent-kernel-parity.test.ts` | Legacy/LangGraph 公共结果和事件序列一致性 |
| `tests/langgraph-kernel.test.ts` | thread、maxSteps、Checkpoint、interrupt/resume |
| `tests/langgraph-run-recovery.test.ts` | 节点事件与从最新 Checkpoint 恢复 |
| `tests/agent-run-coordinator.test.ts` | lease、续约、fencing、取消和终态 |
| `tests/mysql-checkpointer.test.ts` | Saver 协议、parent、pending writes 和隔离 |
| `tests/durable-interaction.test.ts` | Interaction 授权等待和 Tool Ledger 恢复语义 |
| `tests/tool-broker.test.ts` | Policy、Approval、Hook、Ledger 与工具顺序 |

## 17. 当前已知限制

- Model、Sandbox Controller 和 MCP Manager 仍主要是进程级单实例，不是完整 tenant-scoped Runtime。
- Interaction 事实已持久化，但 waiter 仍在进程内；跨副本解析需要粘性路由、轮询或通知机制。
- Lease 支持过期后新 owner 获取，但没有扫描器自动接管过期的 running Run。
- Legacy 与 LangGraph 的恢复粒度不同；只有 LangGraph 路径具备图级 Checkpoint。
- Legacy Loop 当前不消费 `runGuard`，无法在模型/工具边界获得与 LangGraph 相同的 lease fencing 和 Store 取消检查。
- Tool Ledger 不能把未知外部副作用自动变成 exactly-once。
- 修改图状态或节点语义时必须升级 graph version，并保留旧版本恢复策略。

## 18. 源码依据

- `src/agent/core.ts`
- `src/agent/kernel.ts`
- `src/agent/legacy-kernel.ts`
- `src/agent/runtime.ts`
- `src/agent/langgraph/state.ts`
- `src/agent/langgraph/graph.ts`
- `src/agent/langgraph/kernel.ts`
- `src/agent/langgraph/registry.ts`
- `src/agent/services/prompt.ts`
- `src/agent/services/context-service.ts`
- `src/agent/services/model-gateway.ts`
- `src/agent/services/tool-broker.ts`
- `src/agent/services/session-committer.ts`
- `src/agent/run-coordinator.ts`
- `src/agent/interactions/store.ts`
- `src/agent/tool-ledger/store.ts`
- `src/agent/checkpoint/mysql.ts`
- `src/db/store.ts`
- `tests/agent*.test.ts`
- `tests/langgraph*.test.ts`
- `tests/mysql-checkpointer.test.ts`
- `tests/durable-interaction.test.ts`
