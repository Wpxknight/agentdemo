# Pi Agent Platform 操作说明

AIoP 新运行支持 `legacy` 与 `pi`。历史 `kernel=langgraph` 记录继续通过运行中心查询，但运行时代码和依赖已经删除，不能恢复或创建新的 LangGraph Run。

## 灰度与回滚

- `AIOP_AGENT_KERNEL=legacy`：所有新 Run 使用 Legacy。
- `AIOP_AGENT_KERNEL=pi`：新 Run 使用 Pi。
- `AIOP_AGENT_KERNEL=tenant-rule`：按 `AIOP_PI_TEST_TENANTS`、`AIOP_PI_INTERNAL_USERS`、`AIOP_PI_READ_ONLY_SESSIONS`、`AIOP_PI_FULL_SESSIONS` 灰度。
- `AIOP_PI_MODE=read-only`：Pi 仅暴露只读工具。
- `AIOP_PI_MODE=dry-run` 或 `replay`：Pi 不暴露可执行工具，适合影子验证。
- `AIOP_PI_MODE=disabled`：立即停止新 Pi Run 并回退 Legacy。已绑定 Pi 的 Run 不会切换 Kernel，只能继续、取消或进入人工恢复。

## 数据迁移

迁移 `0015`～`0018` 增加 Attempt、Turn Snapshot/Commit、Ledger v2、事件 sequence 与 Scheduler 关联，迁移 `0020` 持久化跨进程恢复所需的 Run limits。迁移 `0019` 把历史 LangGraph checkpoint 表冻结为只读。回滚窗口结束前不要删除这些表；最终删除必须先完成备份恢复验证和审计保留确认。

## 验证

```bash
make verify-node
make test-agent-platform
npm run typecheck
npm test
```

Run 事件可通过 `GET /v1/agent/runs/{runId}/events` 获取 SSE；使用 `Last-Event-ID` 或 `?after=<sequence>` 断点补发。

## 独立嵌入

[`examples/pi-agent-platform.ts`](../examples/pi-agent-platform.ts) 只从公共包根导入，使用 Memory Runtime、fake model 和 fake tool，不依赖 AIOP HTTP、认证或 MySQL。

## 供应链审计

2026-07-27 执行 `npm audit fix` 后，high/critical 漏洞已清零，剩余 5 个 moderate 均来自 Pi → Google GenAI → MCP SDK → Hono 链，npm 当前标记为无可用修复。Pi 两个包与 E2B 包为 MIT，OpenSandbox 为 Apache-2.0。升级 Pi/MCP 前必须重新运行公共出口、事件顺序、截断和 Durable Runtime 合约测试。
