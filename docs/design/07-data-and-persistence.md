# 数据与持久化设计

## 1. 两类事实源

- Pi Session Tree：会话内 message、branch、compaction 和 session stats 的事实源。
- AIoP MySQL：产品 Run、Attempt、Lease、Turn commit、Inbox、Interaction、Tool Ledger、Scheduler、认证、设置、审计和产品查询的事实源。

两者通过 `pi_session_id`、`pi_leaf_id`、`pi_entry_seq` 和 `committed_leaf_id` 建立恢复边界，不做双 Agent loop 或双上下文写入。

## 2. Store 分层

| 数据 | 实现 |
| --- | --- |
| Durable Run/Interaction/Ledger/Inbox | `packages/pi-runtime/src/store/types.ts`、`memory.ts`、`mysql.ts` |
| Pi SessionStorage | `packages/pi-runtime/src/store/pi-session-mysql.ts` |
| Scheduler Fire | `packages/scheduler-runtime/src/store.ts`、`mysql.ts` |
| 产品用户、会话、消息、设置、审计 | `src/db/store.ts`、`src/db/memory.ts`、`src/db/mysql.ts` |
| Product message projection | `src/agent/projections.ts` |

Memory 实现用于合同测试和本地开发；生产多副本依赖 MySQL transaction、唯一键和 row locking。

## 3. 核心 durable 数据

- `agent_runs`：状态、lease、limits、usage/cost、execution mode、append cutoff。
- `agent_run_attempts`：每次执行所有权和结束原因。
- `agent_turn_snapshots` / `agent_turn_commits`：Turn 输入、水位线与提交结果。
- `agent_run_events`：有序产品事件流。
- `agent_run_inbox_messages`：跨 Worker steer/follow-up。
- `agent_interactions`：approval/question/plan。
- `agent_tool_executions`：Tool Ledger 与未知副作用保护。
- `pi_sessions` / `pi_session_entries`：Pi Session Tree 持久化。
- `scheduler_fires`：调度触发、claim 和 Run 关联。

## 4. 迁移边界

- `0022_pi_only_runtime.sql` 删除非 Pi Run 和旧 checkpoint 表，是不可逆迁移，执行前必须备份。
- `0023_pi_session_and_run_inbox.sql` 增加 Pi Session 与 durable inbox。
- `0024_pi_run_controls.sql` 增加 cost、limits 和 append cutoff。
- `0025_scheduler_fires.sql` 增加 durable scheduler fire。
- `0026_scheduler_run_compat.sql` 增加 execution mode 与 fire/run 兼容关联。

新版本首次启动会执行迁移。代码回滚不能撤销 schema 或恢复 `0022` 删除的数据；数据库恢复必须使用已演练备份。

## 5. 事务与 fencing

- Run 终态、Turn commit 和 lease 更新必须验证当前 attempt/token。
- Tool result、Interaction resolution、Inbox claim 必须使用唯一键或状态条件保证幂等。
- Memory transaction overlay 只在 active parent 中合并；失效或逃逸 transaction 返回冲突。
- MySQL transaction 失败时不能留下部分 Run/Interaction/Ledger 状态。

## 6. 设置与 Secret

非敏感设置可保存在 ConfigMap 或 tenant settings。Credential 保存到受控 Secret/Credential Store；API 返回掩码状态而不是明文。运维检查只验证 Secret 资源存在，不读取、describe、decode 或打印其内容。

## 7. 备份与恢复

备份恢复演练、兼容抽样和 evidence 格式见[Pi Agent Platform 操作说明](../pi-agent-platform-operations.md)。准备阶段不虚构环境结果；实际证据写入 `/home/opt/develop/aicoding/aiop/dist/runtime-refactor-migration-rehearsal.md`，`dist/` 不提交。
