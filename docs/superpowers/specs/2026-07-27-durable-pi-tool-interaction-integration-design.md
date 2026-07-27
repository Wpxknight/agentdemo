# Durable Pi Tool and Interaction Integration Design

日期：2026-07-27

## 背景

`/home/opt/develop/aicoding/aiop/docs/design/12-pi-integration-plan.md` 要求 AIOP 的 Pi 产品路径使用统一 Tool Runtime，并通过 Turn commit 原子持久化 Interaction、Tool Ledger、消息、usage 和事件。当前公共 `@aiop/tool-runtime` 已实现固定安全流水线与并发控制，但 `/home/opt/develop/aicoding/aiop/src/agent/pi/kernel.ts` 仍包装旧 `executeToolCall` broker；`RunAgentOptions.durableInteractions` 在 Pi Adapter 中未消费，审批、提问和计划仍可能依赖进程内 waiter。HTTP resolve 也不会自动创建新 Attempt，Runtime resume 没有把可信 resolution 交给 Kernel。

## 目标

1. Durable Pi 产品路径以 `@aiop/tool-runtime` 作为唯一工具安全执行引擎。
2. tenant/tool/resource 并发控制器由长生命周期 AIOP Runtime 共享，覆盖其创建的全部 Durable Runtime 实例。
3. approval/question/plan 首次调用返回 `waiting`，Interaction 与 Ledger facts 随 Turn 原子提交。
4. HTTP resolve 后自动异步恢复 Run，创建新 Attempt。
5. 新 Attempt 获得经过 Store 校验的 resolution；批准后执行原工具，拒绝或回答则生成确定性的工具结果，再继续模型循环。
6. Memory 与 MySQL 产品 Store 都读取同一份 Runtime Interaction 数据，不维持两套互相漂移的记录。

## 方案选择

### 方案 A：Durable-native Adapter（采用）

新增 AIOP Tool Runtime Adapter，把产品 `ToolRegistry`、`PolicyMiddleware`、`HookRunner` 和审计/输出回调转换为 `ToolRuntimeEngine` 的中立接口。Runtime Store 的 Tool Ledger 和 Interaction repositories 是唯一 durable facts 来源。

优点：产品路径与公共包语义一致；Turn 原子性、幂等、并发和恢复只实现一次。缺点：需要扩展少量 neutral contracts，并统一 Memory Store Interaction。

### 方案 B：修补旧 broker（不采用）

在 `executeToolCall` 周围增加 semaphore 和 waiting 返回。改动较少，但会永久保留两套 Ledger、Approval 和恢复实现，公共包测试无法证明产品路径安全。

### 方案 C：继续进程内等待（不采用）

保持现有 waiter，在 resolve 时唤醒原请求。该方案无法承受 Worker 重启或多副本切换，违反设计目标。

## 架构

### 1. Neutral contracts

- `KernelRunInput` 增加 `sessionId` 和可选 `interactionResolution`。
- `ToolExecutionContext` 增加 `sessionId` 和可选 `interactionResolution`。
- `DurableInteractionUpdate` 保存 `userId`、`sessionId`、`toolCallId`、`expiresAt` 和可选 `resolvedBy`。
- `InteractionRepository` 增加按 Run 列出记录的接口，供产品管理面和恢复器读取。

Resolution 只能由 Runtime 在校验 tenant/run/interaction/status 后构造，模型消息不能直接生成该字段。

### 2. Runtime resume

`DurableAgentRuntime.resume()` 接受以下两种安全输入：

- Interaction 仍为 `pending`：Runtime 在恢复前原子写入 `resolved` 状态；
- Interaction 已由产品 HTTP Store 写为 `resolved`：Runtime 校验 resolution 一致后复用，不重复解析。

Runtime 把包含 kind、toolCallId 和 value 的可信 resolution 传给 Kernel。原 TurnCommit 保持不可变；新 Attempt 的 TurnSnapshot 记录恢复前 transcript 与 resolution 处理后的新执行边界。

### 3. Tool Runtime

`ToolRuntimeEngine` 支持共享 `ToolConcurrencyController`，而不是每次创建私有 semaphore。工具定义可声明 `interactionKind: question | plan`：首次调用创建 pending Interaction，不执行 handler；恢复时由可信 resolution 生成 ToolResult。

普通写工具需要审批时：

1. 首次调用写 `pending_approval` Ledger 与 pending Interaction；
2. 批准恢复时，同一 logical call 从 `pending_approval` 转 `started`，使用原 stable idempotency key 执行；
3. 拒绝恢复时，生成确定性错误 ToolResult，并把 Ledger 结束事实随新 Turn commit 写入；
4. 非幂等 `started` 且结果未知时仍进入 `recovery_required`，不自动重放。

### 4. Pi Kernel

Pi Kernel 在调用 `agentLoopContinue` 前处理 `interactionResolution`：定位原 assistant tool call，并重新调用 Tool Runtime。approval=true 会真正执行原工具；approval=false、question 和 plan 产生确定性 ToolResult。结果替换上一 Turn 中的 `waiting:<interactionId>` 占位结果，然后继续模型调用。

同一 Turn 第一个工具进入 waiting 后，剩余写工具仍被阻止。

### 5. AIOP Adapter 与 HTTP

- `/home/opt/develop/aicoding/aiop/src/agent/pi/tool-runtime.ts` 负责产品类型到公共 Tool Runtime 的转换。
- `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts` 持有共享 model/tool concurrency controllers，并把 Runtime Store repositories 注入每个 Durable Pi Kernel。
- approval/question resolve 接口完成权限校验和 Store CAS 后，立即异步调用现有 recovery orchestration，并传入 interaction resolution。
- 显式 `/v1/agent/runs/{runId}/resume` 保留给失败或人工恢复场景；存在 pending Interaction 时必须要求 resolution，不能绕过审批。

## 数据一致性

- MySQL Runtime Adapter 使用现有 `agent_interactions` 字段完整写入 neutral Interaction。
- Memory 产品 Store 的 Interaction API 改为委托同一个 `MemoryRuntimeStore.interactions` repository，确保事务回滚和管理面查询看到相同数据。
- 不新增清表迁移，不修改历史迁移；现有字段足以保存所需数据。

## 错误与幂等

- 重复 resolve 只有在 value 与已保存 resolution 等价时可用于恢复；冲突 value 返回状态冲突。
- 自动恢复遇到 session busy 时保持现有 `recovery_required` 保护。
- approval=false 不执行外部工具。
- 排队取消、provider/tool 失败和 Runtime shutdown 都必须释放 semaphore。
- HTTP resolve 已成功但异步恢复失败时，Interaction 保持 resolved，Run 进入可人工恢复状态并记录 recovery event。

## 测试

1. Runtime Core：pending/resolved 两种 resume、冲突 resolution、可信 resolution 传给 Kernel、原 commit 不变。
2. Tool Runtime：question/plan waiting、approval 批准执行、拒绝不执行、共享跨实例 FIFO、failure/cancel release。
3. AIOP Durable Pi：真实产品 `ToolRegistry` 路径提交 Interaction/Ledger，fresh Runtime resume 后模型看到工具结果。
4. HTTP：approve/answer 自动创建新 Attempt；重复 resolve 幂等；越权和冲突仍拒绝。
5. Memory/MySQL Store：管理面与 Runtime repository 读取同一 Interaction 字段。
6. 回归：完整故障矩阵、公共 API、typecheck、全量测试、Web build、audit 和镜像。

## 非目标

- 不执行阶段 8/10 的生产保留周期、备份恢复或 checkpoint 清表。
- 不新增分布式 semaphore；进程内共享 controller 之外，由模型网关或部署配额承担跨副本全局上限。
- 不改变 Legacy Kernel 的进程内交互实现。
