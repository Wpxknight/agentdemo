# 数据与持久化设计

## 1. Store 边界

`Store` 统一承载会话消息、Agent Run、交互、工具账本、审计、定时任务、用户、凭据和租户设置。`MemoryStore` 用于开发测试，`MysqlStore` 用于持久环境；两者应保持相同的租户与用户隔离语义。

~~~mermaid
flowchart LR
  HTTP[HTTP]
  Agent[Agent Runtime]
  Scheduler[Scheduler]
  Auth[Auth]
  Store[Store Interface]
  Memory[MemoryStore]
  MySQL[MysqlStore]
  DB[(MySQL 8)]

  HTTP --> Store
  Agent --> Store
  Scheduler --> Store
  Auth --> Store
  Store --> Memory
  Store --> MySQL --> DB
~~~

## 2. 核心实体

~~~mermaid
erDiagram
  TENANTS ||--o{ USERS : contains
  USERS ||--o{ SESSIONS : owns
  SESSIONS ||--o{ MESSAGES : contains
  USERS ||--o{ SCHEDULED_TASKS : creates
  SCHEDULED_TASKS ||--o{ TASK_RUNS : produces
  SESSIONS ||--o{ AGENT_RUNS : executes
  AGENT_RUNS ||--o{ AGENT_RUN_EVENTS : emits
  AGENT_RUNS ||--o{ AGENT_INTERACTIONS : waits_for
  AGENT_RUNS ||--o{ AGENT_TOOL_EXECUTIONS : records
  AGENT_RUNS ||--o{ LANGGRAPH_CHECKPOINTS : snapshots
  LANGGRAPH_CHECKPOINTS ||--o{ LANGGRAPH_CHECKPOINT_WRITES : has
  USERS ||--o{ USER_CREDENTIALS : owns
  TENANTS ||--o{ TENANT_SETTINGS : configures
  TENANTS ||--o{ SETTING_SECRETS : protects
  TENANTS ||--o{ AUDIT_EVENTS : records
~~~

逻辑关系主要由应用层维护，迁移未普遍使用外键，以便兼容历史数据和多种删除策略。

## 3. 迁移演进

| 迁移 | 主要内容 |
| --- | --- |
| 0001 | messages、audit_events、scheduled_tasks、task_runs、tenants、users |
| 0002 | tenant_settings |
| 0003 | 消息租户历史索引 |
| 0004 | sessions 与历史回填 |
| 0005 | scheduled task title |
| 0006 | sessions/messages 增加 user_id 与用户级主键 |
| 0007 | 用户 status、auth_provider、display_name |
| 0008 | 加密 user_credentials |
| 0009 | users.home_dir |
| 0010 | setting_secrets |
| 0011 | LangGraph checkpoints 与 pending writes |
| 0012 | agent_interactions、agent_tool_executions |
| 0013 | agent_runs binding |
| 0014 | Agent Run 生命周期、Lease 和 agent_run_events |

迁移只追加，不修改历史文件。`schema_migrations` 记录已执行版本，启动时按顺序应用。

## 4. 会话与消息

会话主键为 tenant + user + session。消息也带相同隔离字段并按 id 排序。

- 创建空会话时先写 sessions。
- 追加消息时保持 JSON 中立消息结构。
- 摘要压缩后使用 replaceMessages 原子替换可见历史。
- 会话列表按 updated_at 分页。
- 删除会话同时触发相关 Sandbox 回收，但数据库与外部资源释放属于不同事务边界。

## 5. Agent Run 数据

`agent_runs` 同时保存不可变 binding 和可变生命周期：

- tenant、run、user、session。
- kernel、graph name/version。
- status、current node、step、usage。
- error、start/update/complete/cancel 时间。
- lease owner、token、expiry。

`agent_run_events` 追加节点和运行事件；Interaction 与 Tool Execution 是独立事实表。

~~~mermaid
flowchart TD
  Run[agent_runs]
  Events[agent_run_events]
  Interaction[agent_interactions]
  Ledger[agent_tool_executions]
  CP[langgraph_checkpoints]
  Writes[langgraph_checkpoint_writes]

  Run --> Events
  Run --> Interaction
  Run --> Ledger
  Run --> CP
  CP --> Writes
~~~

## 6. Checkpoint Saver

MySQL Saver 以 tenant、thread、namespace、checkpoint id 为主键，二进制保存 checkpoint 与 metadata，并保存 parent id、run、graph version 和 expires_at。

pending writes 以 checkpoint、task id 和 write index 唯一。Saver 需要通过 LangGraph checkpoint validation 合同测试。

Checkpoint 清理可依据 expires_at，但清理前必须确认对应 Agent Run 不再需要恢复。

## 7. 并发与事务

- Scheduler 使用原子 claim 和 MySQL `SKIP LOCKED` 避免多副本重复领取。
- Agent Run Lease 使用 owner + 单调 token 做 fencing。
- Tool Ledger 使用 insert-if-absent 确定调用所有权。
- Interaction resolve 使用条件更新防止重复解析。
- Session 消息提交和外部工具副作用不在同一事务，必须接受部分成功并提供恢复记录。
- MySQL 断开或写失败不得被伪装成成功。

## 8. 设置与密钥

`tenant_settings` 保存非敏感 JSON。`setting_secrets` 保存加密 payload。模型、Scheduler、MCP 和 Sandbox 设置通过固定 setting key 读取。

这些表的主键支持 tenant，但当前 Runtime 并未按 tenant 实例化全部组件：启动模型、Sandbox 设置和 MCP 配置主要读取 `default`；Model、Sandbox Controller 和 MCP Manager 是进程级单实例。特别是 LLM 设置 API 可以按请求 tenant 落库后热替换全局 Model，属于需要治理的现状边界，不能把存储隔离等同于运行态隔离。

用户下游凭据独立存于 `user_credentials`，带 provider 和 expires_at。用户删除时清理凭据但保留审计和历史主体。

## 9. 审计、保留与备份

`audit_events` 按 tenant、session 和 kind 建索引。生产环境应备份 MySQL 全库并验证恢复；仅备份 messages 无法恢复 Agent Run、设置和身份。

建议保留策略按数据类型区分：

- 审计：按合规周期。
- Agent Run 事件：按排障周期。
- Checkpoint：只保留可恢复窗口。
- Tool Ledger：至少覆盖 Checkpoint 恢复窗口。
- 下载文件不在 MySQL，由 Download Store TTL 管理。

当前代码提供 expires_at 字段和查询能力，但完整归档作业仍属于运维演进项。

## 10. 源码依据

- `src/db/store.ts`
- `src/db/mysql.ts`
- `src/db/memory.ts`
- `src/db/index.ts`
- `src/db/migrations/`
- `src/agent/checkpoint/mysql.ts`
- `src/agent/run-center.ts`
- `src/agent/run-coordinator.ts`
