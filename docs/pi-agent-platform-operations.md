# Pi Agent Platform 操作说明

AIoP 新运行支持 `legacy` 与 `pi`。历史 `kernel=langgraph` 记录继续通过运行中心查询，但运行时代码和依赖已经删除，不能恢复或创建新的 LangGraph Run。

## 灰度与回滚

- `AIOP_AGENT_KERNEL=legacy`：所有新 Run 使用 Legacy。
- `AIOP_AGENT_KERNEL=pi`：新 Run 使用 Pi。
- `AIOP_AGENT_KERNEL=tenant-rule`：按 `AIOP_PI_TEST_TENANTS`、`AIOP_PI_INTERNAL_USERS`、`AIOP_PI_READ_ONLY_SESSIONS`、`AIOP_PI_FULL_SESSIONS` 灰度。
- `AIOP_PI_MODE=read-only`：Pi 仅暴露只读工具。
- `AIOP_PI_MODE=dry-run` 或 `replay`：Pi 不暴露可执行工具，适合影子验证。
- `AIOP_PI_MODE=disabled`：立即停止新 Pi Run 并回退 Legacy。已绑定 Pi 的 Run 不会切换 Kernel，只能继续、取消或进入人工恢复。

## 并发与容量

- `AIOP_PI_MAX_CONCURRENT_MODEL_CALLS` 控制每个 tenant/provider/model/route 的并发模型流数量，默认 `4`，必须是正整数。
- 相同 tenant/model 的请求按 FIFO 排队；不同 tenant 或 model 使用独立队列。
- 模型许可只覆盖实际 `ModelProvider.stream()` 消费期，进入工具执行后立即释放，不会用模型配额锁住外部工具。
- provider 异常、Run 取消和排队期间取消都会释放或移除许可。该控制器在进程内跨所有新建 Durable Runtime 实例共享；多副本部署仍应叠加 provider 网关或分布式全局配额。

## 数据迁移

迁移 `0015`～`0018` 增加 Attempt、Turn Snapshot/Commit、Ledger v2、事件 sequence 与 Scheduler 关联，迁移 `0020` 持久化跨进程恢复所需的 Run limits，迁移 `0021` 为 durable event 增加 Attempt、Turn、Kernel 与 correlation 身份列。迁移 `0019` 把历史 LangGraph checkpoint 表冻结为只读。回滚窗口结束前不要删除这些表；最终删除必须先完成真实备份恢复验证和审计保留确认。

## 可观测性

每条 Durable Runtime 事件都携带 `tenantId`、`runId`、`attemptId`、`turnNo`、`kernel`、`kernelVersion` 和 `correlationId`。控制事件只保存工具名称/调用标识、结果状态、usage、停止原因和 compaction 计数，不保存模型 text/thinking、工具参数或工具结果正文。

`DurableAgentRuntime` 的结构化 observer 输出以下 counter/timer：

- Run、Attempt 和 Turn 的开始计数与完成耗时；
- lease loss、compaction、tool call/result、waiting、`recovery_required` 计数；
- SSE durable event 断点补发量。

Observer 失败不会改变 Run 的 durable 语义。接入 metrics/logging 后端时，应以完整身份字段作为标签/日志字段，并控制 tenant/run/correlation 等高基数字段的指标使用方式。

## 验证

```bash
make verify-node
make test-agent-platform
npm run typecheck
npm test
npm --prefix web run build
```

Run 事件可通过 `GET /v1/agent/runs/{runId}/events` 获取 SSE；使用 `Last-Event-ID` 或 `?after=<sequence>` 断点补发。

GitLab CI 使用 Node 24 执行 Node 基线、Agent Platform、公共包 tarball、typecheck、全量测试、Web production build 和 high/critical audit 门禁；独立 Docker-in-Docker job 执行 `make image`。Dockerfile 在 builder stage 内运行 `npm run build:packages`，且 `.dockerignore` 排除宿主 `packages/*/dist`，镜像构建不依赖开发机残留产物。

故障矩阵可用以下命令复验：

```bash
npx vitest run --reporter=verbose tests/durable-runtime.test.ts tests/memory-runtime-store.test.ts tests/mysql-runtime-store.test.ts tests/tool-runtime-platform.test.ts tests/http-agent-runs.test.ts tests/pi-observability.test.ts tests/pi-contract.test.ts tests/agent-runtime.test.ts
```

矩阵覆盖取消、deadline、shutdown、stale fencing、事务回滚、跨进程 resume、approval/question/plan、重复写复用、未知外部副作用保护、模型与工具并发释放以及 SSE 断点补发。

## 生产外部待办

以下事项不能由仓库测试替代，目前均不得标记完成：

- 阶段 7 的真实生产灰度阈值、持续窗口和安全事件统计；
- 阶段 8 的真实 checkpoint 保留周期以及该周期内无新 LangGraph Run 的证据；
- 阶段 10 前的真实备份恢复演练和历史审计查询；
- 生产回滚窗口结束后的 checkpoint 清表审批、执行与验证。

在以上证据齐备前，不得创建或执行删除 `langgraph_checkpoints`、`langgraph_checkpoint_writes` 的迁移。

## 独立嵌入

[`examples/pi-agent-platform.ts`](../examples/pi-agent-platform.ts) 只从公共包根导入，使用 Memory Runtime、fake model 和 fake tool，不依赖 AIOP HTTP、认证或 MySQL。

## 供应链审计

2026-07-27 执行 `npm audit fix` 后，high/critical 漏洞已清零，剩余 5 个 moderate 均来自 Pi → Google GenAI → MCP SDK → Hono 链，npm 当前标记为无可用修复。Pi 两个包与 E2B 包为 MIT，OpenSandbox 为 Apache-2.0。升级 Pi/MCP 前必须重新运行公共出口、事件顺序、截断和 Durable Runtime 合约测试。
