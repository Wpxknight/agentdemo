# Pi Agent Platform 操作说明

AIoP 只使用 Pi Kernel。Legacy、LangGraph、Kernel 灰度选择和历史 LangGraph Run 查询均已移除；运行中心只读取 Pi Durable Runtime 数据。

## 执行模式

- `AIOP_PI_MODE=full`：Pi 可按现有 Policy、Approval 和 Hook 规则使用完整工具集，也是缺省模式。
- `AIOP_PI_MODE=read-only`：Pi 仅暴露只读工具。
- `AIOP_PI_MODE=dry-run` 或 `replay`：Pi 不暴露可执行工具，适合影子验证。

`AIOP_AGENT_KERNEL` 已退役。若遗留部署仍将其设置为非 `pi` 值，服务会明确拒绝启动，不会静默回退。`AIOP_PI_MODE=disabled` 同样不再支持。

## 并发与容量

- `AIOP_PI_MAX_CONCURRENT_MODEL_CALLS` 控制每个 tenant/provider/model/route 的并发模型流数量，默认 `4`，必须是正整数。
- `AIOP_PI_MAX_CONCURRENT_TOOLS_PER_TENANT`、`AIOP_PI_MAX_CONCURRENT_TOOLS_PER_TOOL`、`AIOP_PI_MAX_CONCURRENT_TOOLS_PER_RESOURCE` 分别控制进程内 tenant、工具和资源 FIFO 并发，默认 `8`、`4`、`1`，必须是正整数。
- 相同 tenant/model 的请求按 FIFO 排队；不同 tenant 或 model 使用独立队列。
- 模型许可只覆盖实际 `ModelProvider.stream()` 消费期，进入工具执行后立即释放，不会用模型配额锁住外部工具。
- provider 异常、Run 取消和排队期间取消都会释放或移除许可。该控制器在进程内跨所有新建 Durable Runtime 实例共享；多副本部署仍应叠加 provider 网关或分布式全局配额。
- `RunLimits.maxAttempts` 与其他 Run 预算一起保存在现有 TurnSnapshot `limits_json`；达到上限后，跨进程恢复会在获取新 Attempt 前返回 `RUN_LIMIT_EXCEEDED`，无需新增迁移。

## 数据迁移

迁移 `0015`～`0018` 增加 Attempt、Turn Snapshot/Commit、Ledger v2、事件 sequence 与 Scheduler 关联，迁移 `0020` 持久化跨进程恢复所需的 Run limits，迁移 `0021` 为 durable event 增加 Attempt、Turn、Kernel 与 correlation 身份列。

迁移 `0022_pi_only_runtime.sql` 会永久删除全部非 Pi Run 及其关联记录，并删除 `langgraph_checkpoints`、`langgraph_checkpoint_writes` 和只读触发器。部署包含该迁移的版本前必须备份数据库；迁移完成后不能依靠代码回滚恢复旧数据。

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

## 生产部署门禁

- 执行迁移 `0022` 前生成并校验数据库备份；
- 确认业务接受删除非 Pi Run、历史 Timeline 和 LangGraph checkpoint；
- 部署后确认 `agent_runs` 只包含 `kernel=pi`，且 LangGraph checkpoint 表不存在；
- 观察 Pi Run 成功率、恢复失败、Lease 丢失和不确定工具副作用告警。

## 独立嵌入

[`examples/pi-agent-platform.ts`](../examples/pi-agent-platform.ts) 只从公共包根导入，使用 Memory Runtime、fake model 和 fake tool，不依赖 AIOP HTTP、认证或 MySQL。

## 供应链审计

2026-07-27 执行 `npm audit fix` 后，high/critical 漏洞已清零，剩余 5 个 moderate 均来自 Pi → Google GenAI → MCP SDK → Hono 链，npm 当前标记为无可用修复。Pi 两个包与 E2B 包为 MIT，OpenSandbox 为 Apache-2.0。升级 Pi/MCP 前必须重新运行公共出口、事件顺序、截断和 Durable Runtime 合约测试。
