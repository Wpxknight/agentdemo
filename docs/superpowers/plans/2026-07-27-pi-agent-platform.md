# Pi Agent Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/design/12-pi-integration-plan.md` 完成 Durable Runtime、Pi Kernel、模块化包、AIOP 兼容适配和 LangGraph 退役所需的全部代码与验证工作。

**Architecture:** 保持产品入口不变，先从现有 `Store`/`RequestContext` 中抽取中立 contracts 与 Runtime Store ports，再以 Memory/MySQL 实现 Attempt/Turn/Commit、事件 sequence 和恢复协议。Pi Kernel 只负责进程内 loop 与协议转换，工具副作用、审批、幂等、持久化和恢复继续由 AIOP Runtime 控制；最终删除 LangGraph 新流量、代码、依赖和 checkpoint 实现。

**Tech Stack:** Node.js >=22.19.0、TypeScript、Vitest、Kysely/MySQL、`@earendil-works/pi-agent-core@0.82.1`、`@earendil-works/pi-ai@0.82.1`。

---

### Task 1: Node 与构建基线

**Files:** `package.json`, `package-lock.json`, `Dockerfile`, `web/Dockerfile`, `Makefile`, `scripts/verify-node.ts`, `tests/pi-platform-manifest.test.ts`

- [ ] 先写 manifest/Node/Pi 精确版本/Makefile 命令的失败测试。
- [ ] 将 Node engine 升级到 `>=22.19.0`，锁定两个 Pi 包为 `0.82.1`。
- [ ] 增加 `verify-node`、Agent Platform 测试、镜像、部署和回滚命令。
- [ ] 运行定向测试、typecheck 和现有回归。

### Task 2: Contracts 与包工作区

**Files:** `packages/agent-contracts/**`, `packages/agent-runtime-core/**`, 根 `package.json`, `tsconfig.json`, `tests/agent-platform-packages.test.ts`

- [ ] 先写包清单、exports 与禁止产品类型泄漏的失败测试。
- [ ] 定义 Identity、Run、Attempt、Turn、Kernel、Tool、事件、错误和 provider 中立契约。
- [ ] 定义 Runtime Store ports、transaction 和 repository 接口。
- [ ] 保持现有 AIOP 类型通过 Adapter 兼容。

### Task 3: Attempt/Turn/Commit 与事件序列数据模型

**Files:** `src/db/migrations/0015_agent_attempts_and_turns.sql`, `0016_agent_tool_ledger_v2.sql`, `0017_agent_run_event_sequence.sql`, `src/db/schema.ts`, `src/db/store.ts`, `tests/runtime-migrations.test.ts`

- [ ] 先写迁移字段、索引、不可修改历史迁移的失败测试。
- [ ] 新增 attempts、snapshots、commits 和 `agent_runs` Runtime 字段。
- [ ] 扩展 Interaction/Tool Ledger v2 与单调 event sequence。
- [ ] 更新 Kysely schema 和兼容数据类型。

### Task 4: Memory Runtime Store

**Files:** `packages/agent-runtime-core/src/memory-store.ts`, `tests/runtime-store-contract.ts`, `tests/memory-runtime-store.test.ts`

- [ ] 先写 Run/Attempt/Turn/Interaction/Ledger/Event transaction 合约测试。
- [ ] 实现快照不可变、Commit 幂等、sequence 单调、lease fencing 和原子回滚。
- [ ] 覆盖提交前/后崩溃、取消、deadline 和 lease loss。

### Task 5: MySQL Runtime Adapter

**Files:** `packages/agent-runtime-mysql/**`, `src/db/mysql.ts`, `tests/mysql-runtime-store.test.ts`

- [ ] 先写 SQL/transaction/lease fencing 合约测试。
- [ ] 实现 repository 与 Turn 原子提交。
- [ ] 将现有 AIOP MySQL Store 通过 adapter 接入 Runtime ports。

### Task 6: Durable Runtime 与恢复器

**Files:** `packages/agent-runtime-core/src/runtime.ts`, `src/agent/runtime-adapter.ts`, `tests/durable-runtime.test.ts`

- [ ] 先写 run/resume/cancel、Kernel 锁定和最后已提交 Turn 恢复测试。
- [ ] 实现 RunHandle、Attempt 生命周期、TurnSnapshot、TurnCommit 和 awaited durable sink。
- [ ] 实现崩溃、半提交、取消、deadline、lease loss 和 recovery_required 语义。

### Task 7: Pi 公共出口与协议 Adapter

**Files:** `packages/agent-kernel-pi/**`, `tests/pi-contract.test.ts`, `tests/pi-kernel.test.ts`

- [ ] 先写 Pi 包根 exports、事件顺序、abort、tool result 顺序和长度截断保护测试。
- [ ] 实现 AIOP/Pi 消息、模型、usage、事件和工具转换。
- [ ] 使用 `agentLoop/agentLoopContinue` 实现 `PiAgentKernel`，禁止 deep import。
- [ ] 使用 fake model/tool 验证模型—工具—模型和跨 Attempt 恢复。

### Task 8: Context、Skill 与输出截断

**Files:** `packages/agent-kernel-pi/src/context-manager.ts`, `packages/skill-runtime/**`, `packages/tool-runtime/src/output-limiter.ts`, tests

- [ ] 先写 compaction/token estimation/Skill loader/truncate 包根合约测试。
- [ ] 包装 Pi 公共辅助函数，隔离 Pi 类型。
- [ ] 实现策略、版本、tenant 可见性、审计和原始输出保存边界。

### Task 9: Tool Runtime 与 Ledger v2

**Files:** `packages/tool-runtime/**`, `src/agent/services/tool-broker.ts`, `src/agent/tool-ledger/store.ts`, tests

- [ ] 先写固定执行顺序、只读受限并行、写操作串行和截断时禁执行测试。
- [ ] 实现 capability、logical call、stable idempotency key、correlation、审批事实和资源锁。
- [ ] 实现跨进程审批恢复、幂等复用和非幂等 unknown 保护。

### Task 10: Sandbox、MCP、Skill、Scheduler 模块化

**Files:** `packages/sandbox-*`, `packages/mcp-runtime`, `packages/skill-runtime`, `packages/scheduler-*`, tests

- [ ] 先写各 provider 公共契约和依赖边界测试。
- [ ] 将现有实现通过薄 adapter 导出为可组合包。
- [ ] 增加不依赖 AIOP HTTP/Auth/MySQL 的嵌入示例和测试。

### Task 11: AIOP HTTP/SSE/Scheduler/运行中心适配

**Files:** `packages/agent-runtime-aiop/**`, `src/runtime.ts`, `src/server/http.ts`, `src/scheduler/runner.ts`, `web/src/**`, tests

- [ ] 先写 Pi run 详情、attempt/turn 摘要、Kernel 无关 resume/cancel 和 SSE sequence 补发测试。
- [ ] 接入新的 Runtime facade，同时保持既有路由和错误码兼容。
- [ ] 确保普通用户/管理员 tenant 边界与敏感 Ledger 脱敏。

### Task 12: 灰度与回滚控制

**Files:** `src/agent/runtime.ts`, config/deploy docs, tests

- [ ] 先写 replay/dry-run、只读/写流量门控和“Run 不可中途换 Kernel”测试。
- [ ] 增加 Pi 灰度、停止新 LangGraph Run、回滚到 Legacy 的配置。
- [ ] 保留历史 LangGraph Run 查询但禁止重新执行。

### Task 13: LangGraph 代码与依赖清理

**Files:** `src/agent/langgraph/**`, `src/agent/checkpoint/**`, `package.json`, `src/runtime.ts`, tests

- [ ] 先将行为/恢复测试迁移到 Pi/Durable Runtime。
- [ ] 删除 LangGraph Kernel、Saver、配置、依赖和专用测试。
- [ ] 增加 checkpoint 转只读及最终清表迁移，保持历史审计查询。

### Task 14: 完整验证与文档

**Files:** `README.md`, `docs/design/**`, package READMEs, examples

- [ ] 逐条审计设计文档 BR、接口、迁移、阶段和验收条件。
- [ ] 运行 `make verify-node`, `make test-agent-platform`, `npm test`, `npm run typecheck` 和镜像构建。
- [ ] 检查依赖树、public exports、无 deep import、无 LangGraph 运行时代码。
- [ ] 更新操作、迁移、回滚和嵌入文档。
- [ ] 按仓库要求提交，commit message 带 AIOS co-author trailer。
