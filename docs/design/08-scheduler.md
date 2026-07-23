# Scheduler 设计

## 1. 定位与运行模式

Scheduler 是数据库驱动的 Agent 任务触发器。可以单独运行 `tsx src/index.ts scheduler`，也可通过 `AIOP_EMBED_SCHEDULER=true` 内嵌到 HTTP 进程。

生产部署当前在两个 Server 副本中内嵌 Scheduler，因此正确性依赖 Store 的原子领取，而不是单实例假设。

## 2. 数据模型

`scheduled_tasks` 保存 tenant、user、session、title、cron、task、preApproved、enabled、next/last run。`task_runs` 保存每次执行状态、detail、steps 和时间。

Cron 使用 `cron-parser` 校验并计算下次时间。创建和更新时即生成 nextRunAt。

## 3. Tick 与领取

~~~mermaid
sequenceDiagram
  participant S1 as Scheduler replica 1
  participant S2 as Scheduler replica 2
  participant DB as Store and MySQL
  participant A as Agent Runtime

  par concurrent ticks
    S1->>DB: claimDueTasks(now, batch)
    S2->>DB: claimDueTasks(now, batch)
  end
  DB-->>S1: claimed set A
  DB-->>S2: claimed set B
  loop each claimed task
    S1->>A: run scheduled task
    A-->>S1: result or error
    S1->>DB: recordTaskRun
  end
~~~

`Scheduler` 默认每 30 秒 tick、每轮最多 10 个任务，并用进程内 running 标记避免同一实例 tick 重叠。跨实例依赖 MySQL claim/locking。

## 4. 任务执行上下文

任务以保存的 tenantId、userId、sessionId 执行，角色固定为 user。执行前读取该用户会话历史和可见 Skill 摘要。

- 每次生成新的 runId。
- 使用相同 `AgentRuntime`。
- 绑定 `DurableToolLedger`。
- 使用模型上下文预算和图片保留配置。
- 成功后通过 `SessionCommitter` 提交消息。
- 写 usage 审计并估算成本。

## 5. 无人值守策略

~~~mermaid
flowchart TD
  Task[Scheduled Task] --> Pre{preApproved}
  Pre -->|yes| PP[policyPreApproved]
  Pre -->|no| P[normal policy]
  PP --> Run[Agent Runtime unattended]
  P --> Deny[AutoDenyGate for approvals]
  Deny --> Run
  Run --> Record[task_runs and usage audit]
~~~

`unattended=true` 告知模型不要等待空气中的确认。未 preApproved 的任务使用 `AutoDenyGate`，需要审批的调用被拒绝并由 Agent 汇报；preApproved 只降低普通审批，不绕过危险命令、租户 ACL、只读集群和硬安全规则。

## 6. 超时与失败

租户 Scheduler 设置可配置 maxRunMs，默认值由 Store 常量提供。每个任务创建 AbortController，超时后中止模型/工具链并记录 error task run。

失败隔离：

- 单任务失败不阻止本轮其他任务。
- tick 查询失败记录错误，下一周期重试。
- recordTaskRun 失败会进入 tick 异常日志，不能声称运行已可靠记录。
- 外部副作用已经发生时，超时不能自动回滚，仍依赖 Tool Ledger 和目标系统确认。

## 7. 启停与修改

任务支持创建、更新、启用、禁用、删除和立即运行。API 授权按当前 tenant/user，管理员能力不能隐式读取其他租户任务。

删除用户时关联任务被禁用，避免无人值守继续使用失效身份。

## 8. 已知边界

- Scheduler 没有独立工作队列；数据库是触发与领取协调点。
- 长任务会占用执行进程资源，当前没有全局并发配额。
- Memory Store 只适合单进程开发，不能验证多副本 claim。
- 内嵌 Scheduler 与 Server 同故障域；独立部署可改善隔离，但需要运维选择。
- preApproved 是任务级高风险开关，应仅由有 approve 权限的角色设置。

## 9. 测试重点与源码依据

测试需覆盖 Cron、原子领取、重叠 tick、成功/失败记录、preApproved、AutoDeny、超时、会话提交和用户删除禁用任务。

源码：

- `src/scheduler/cron.ts`
- `src/scheduler/ticker.ts`
- `src/scheduler/runner.ts`
- `src/tools/schedule.ts`
- `src/db/store.ts`
- `src/db/mysql.ts`
- `src/server/http.ts`
