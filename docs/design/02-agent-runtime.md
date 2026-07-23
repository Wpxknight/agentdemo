# Agent Runtime 设计

## 1. 职责与边界

`AgentRuntime` 是 HTTP、CLI 和 Scheduler 共用的稳定执行入口。它不直接实现模型循环，而是选择并调用 `AgentKernel`，同时在存在 `runId` 时协调 Agent Run 生命周期。

~~~mermaid
flowchart LR
  Caller[HTTP CLI Scheduler]
  AR[AgentRuntime]
  Bind[Agent Run Binding]
  Legacy[LegacyAgentKernel]
  LG[LangGraphAgentKernel]
  Coord[AgentRunCoordinator]
  CP[Checkpoint Saver]
  Store[Store]

  Caller --> AR
  AR --> Bind
  Bind --> Store
  AR --> Legacy
  AR --> LG
  AR --> Coord
  LG --> CP
  Coord --> Store
~~~

稳定边界：

- `AgentRuntime.run(options)`：执行入口。
- `AgentKernel.run(options)`：内核契约。
- `AgentRunBindingStore`：锁定一次 Agent Run 的 Kernel 和图版本。
- `AgentRunCoordinator`：Lease、取消和状态事件。
- `BaseCheckpointSaver`：LangGraph 状态持久化。

## 2. Kernel 选择与版本锁定

内置 Kernel：

- `legacy`：直接调用现有 `runAgent()` 循环。
- `langgraph`：执行 `prepare → model ↔ tools` StateGraph。

`AIOP_AGENT_KERNEL` 支持：

- `legacy`：默认值。
- `langgraph`：LangGraph 不可用时记录告警并回退 Legacy。
- `tenant-rule`：按测试租户、内部用户、只读会话或全量会话集合选择。

一旦带 `runId` 的执行建立 binding，后续恢复必须继续使用相同 Kernel。LangGraph 还校验 `graphName` 和 `graphVersion`，防止旧 Checkpoint 被不兼容图定义恢复。

## 3. LangGraph 图结构

~~~mermaid
flowchart TD
  Start([START]) --> Prepare[prepare]
  Prepare --> Model[model]
  Model -->|有工具调用| Tools[tools]
  Tools -->|仍可继续| Model
  Model -->|无工具且有待处理消息| Model
  Model -->|完成或达到 maxSteps| End([END])
  Tools -->|达到 maxSteps| End
~~~

节点职责：

- `prepare`：复制初始消息并检查取消。
- `model`：排空待处理消息、执行边界摘要压缩、过滤工具定义、流式调用模型、累计 usage。
- `tools`：经 Tool Broker 并发执行同一轮工具调用，并保持结果顺序。
- `observedNode`：在节点前后写入 Agent Run 事件并执行 Lease/取消 guard。

LangGraph `interrupt()` 用于 durable approval、question 和 plan。交互记录先写 Store，再返回 interaction id；恢复接口解析记录后恢复图。

## 4. Agent Run 主时序

~~~mermaid
sequenceDiagram
  participant C as Caller
  participant R as AgentRuntime
  participant B as Binding Store
  participant O as Run Coordinator
  participant K as Kernel
  participant S as Store

  C->>R: run(runId, context)
  R->>B: get or create binding
  B-->>R: locked kernel and graph version
  R->>O: start
  O->>S: acquire lease
  O->>S: status running and run event
  O-->>R: AgentRunExecution
  R->>K: run with lifecycle and guard
  K->>S: node events and interactions
  K-->>R: result or error
  alt success
    R->>O: succeed(result)
    O->>S: status succeeded and clear lease
  else cancelled or failed
    R->>O: fail(error)
    O->>S: terminal status
  end
  R-->>C: result or error
~~~

## 5. Lease 与取消

Agent Run Lease 解决多副本同时拥有同一执行的问题：

- `acquireAgentRunLease` 返回带单调 token 的 Lease。
- 默认 TTL 30 秒，心跳间隔为 TTL 的约三分之一且至少 1 秒。
- 每个节点和工具边界调用 `guard()`。
- guard 校验 owner、token、过期时间，并读取取消标记。
- Lease 丢失时当前副本停止写最终状态，避免覆盖新 owner。
- 取消是协作式的；模型请求和工具必须观察 AbortSignal 或 guard 才能及时终止。

~~~mermaid
sequenceDiagram
  actor U as User
  participant H as HTTP
  participant S as Store
  participant E as AgentRunExecution
  participant K as Kernel

  U->>H: cancel run
  H->>S: set cancel_requested_at
  K->>E: guard at node or tool boundary
  E->>S: verify lease and cancellation
  S-->>E: cancellation requested
  E-->>K: AgentRunCancelledError
  K-->>E: fail
  E->>S: status cancelled and clear lease
~~~

## 6. 状态模型

~~~mermaid
stateDiagram-v2
  [*] --> running
  running --> waiting: durable interaction
  waiting --> running: resume
  running --> succeeded: completed
  running --> failed: ordinary error
  running --> cancelled: cancellation observed
  running --> recovery_required: uncertain side effect
  failed --> running: explicit resume
  recovery_required --> running: operator resolution
  succeeded --> [*]
  cancelled --> [*]
~~~

`AgentRunStatus` 还保留 queued 等数据状态；实际执行开始时由 Coordinator 转为 running。运行中心通过 Agent Run、事件、交互和工具执行记录聚合时间线。

## 7. Checkpoint 与业务记录

MySQL Checkpoint Saver 保存 checkpoint、metadata、parent checkpoint id 和 pending writes。Checkpoint 负责恢复图计算状态，不负责：

- Agent Run 的用户或会话授权。
- 多副本 Lease。
- 工具副作用幂等。
- 运行中心筛选、取消与审计。

Thread identity 与 Agent Run 绑定，恢复前仍需通过请求上下文和 binding 校验。

## 8. Durable Interaction

| 类型 | 触发 | 持久内容 |
| --- | --- | --- |
| approval | 策略要求审批 | ToolCall、原因、结果 |
| question | `ask_user` | 问题结构、回答 |
| plan | `submit_change_plan` | 变更计划、批准结果 |

状态为 pending、resolved、cancelled 或 expired。解析操作必须使用当前租户和用户上下文，不能只依赖 interaction id。

当前 `DurableInteractionService` 的记录持久化在 Store，但等待者保存在进程内 `Map`。解析请求只有落到原执行副本时才会直接唤醒 waiter；在无粘性路由的多副本部署中，另一副本写入 resolved 记录不会通知原副本。现状因此是“交互事实持久化”，不是完整的跨副本唤醒机制。生产使用需要粘性路由，或补充数据库轮询、消息通知/队列与过期恢复扫描。

## 9. Tool Ledger 与副作用恢复

`DurableToolLedger` 使用 `tenantId + runId + toolCallId` 标识一次调用：

1. 执行前写 started。
2. 已 completed 时复用持久化结果。
3. started 但无结果时表示进程可能在副作用后崩溃。
4. 此时不能盲目重放，转为 unknown 或 recovery_required。
5. 执行完成后写 completed 与结果。

`ask_user` 和 `submit_change_plan` 不进入 Ledger，它们由 Interaction Store 管理。

本设计提供 at-most-once 倾向和人工恢复入口，不承诺 exactly-once。外部幂等仍需要目标系统的幂等键、查询确认或补偿操作。

## 10. 会话提交与流式事件

`SessionCommitter` 负责结果落库：

- 成功且发生摘要压缩：替换完整消息历史。
- 成功且未压缩：只追加本次新增消息。
- 失败或终止：保留用户输入、已流式文本或思考和明确结果。
- 最后一条 assistant 消息记录 durationMs。

主要 `StreamEvent` 包括 thinking/text delta、tool_call、tool_output、tool_result、model_retry、usage、context_compacted、todo_updated、file_exported 和 stop。HTTP 层把中立事件编码为 SSE。

## 11. 故障与恢复边界

| 故障 | 当前处理 |
| --- | --- |
| 模型临时错误或断流 | 模型网关整轮重试，通知前端回滚失败尝试输出 |
| 4xx 参数或鉴权错误 | 除 408/429 外不重试 |
| Lease 丢失 | 当前副本停止，不写失败终态 |
| 客户端断开 | AbortSignal 传播；已完成外部副作用不能自动撤销 |
| 工具结果已持久化 | 恢复时复用 |
| 工具 started 但结果未知 | recovery_required，禁止自动重放 |
| Checkpoint 与图版本不匹配 | 拒绝恢复 |
| 交互等待 | Agent Run 进入 waiting，解析后恢复 |
| 交互在另一副本解析 | 数据库状态会更新，但原进程 waiter 不会被自动唤醒 |
| Lease 过期 | 允许新 owner 获取 Lease，但当前没有扫描器自动接管过期 running Run |

## 12. 测试重点

- Legacy/LangGraph 行为兼容与 Kernel rollout。
- Binding 并发写入和图版本拒绝。
- Saver 合同与 pending writes。
- Lease 获取、续约、过期、token fencing 和取消。
- Interrupt 创建、授权解析和恢复。
- Tool Ledger completed 复用与 unknown 恢复。
- SSE 断线、失败提交与运行中心时间线。

## 13. 源码依据

- `src/agent/runtime.ts`
- `src/agent/kernel.ts`
- `src/agent/langgraph/graph.ts`
- `src/agent/langgraph/kernel.ts`
- `src/agent/run-coordinator.ts`
- `src/agent/checkpoint/mysql.ts`
- `src/agent/interactions/store.ts`
- `src/agent/tool-ledger/store.ts`
- `src/agent/services/session-committer.ts`
- `src/db/store.ts`
