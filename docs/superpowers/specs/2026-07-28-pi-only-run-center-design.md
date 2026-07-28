# Pi-only Agent Runtime 与运行中心收口设计

## 1. 目标

AIoP Agent Runtime 收敛为仅使用 Pi Kernel，同时保留现有运行中心承担的三类能力：

- 运维控制：查看运行状态、取消运行、安全恢复失败运行；
- 审计追踪：查看 Run、Attempt、Committed Turn、Timeline、Interaction 和工具执行；
- 调试观测：查看错误、耗时、Token、Kernel 版本与执行阶段。

本次不引入 OpenTelemetry、Grafana 或其他外部观测平台。运行中心继续基于现有 MySQL Durable Runtime 数据实现。

## 2. 明确决策

1. 新运行和恢复运行只允许使用 Pi Kernel。
2. 删除 Legacy Kernel、旧 Agent loop 及其配置和回退语义。
3. 删除 LangGraph 历史 Run、checkpoint 和 checkpoint write 数据，不再提供历史查询或旧版本恢复。
4. 删除 `legacy`、`langgraph`、`tenant-rule` 和 `AIOP_PI_MODE=disabled` 的可执行语义。
5. 保留现有运行中心页面和 API 形态，数据来源收敛到 Pi Durable Runtime 表。
6. 不修改已经发布的历史迁移；通过新的向前迁移完成数据清理和表结构收口。

## 3. Runtime 架构

产品 Runtime 只构造 Pi Kernel。配置缺失时默认使用 Pi；若仍传入已废弃的 Kernel 值，服务启动失败并给出明确错误，避免静默回退到另一套执行循环。

Pi 的 `read-only`、`dry-run`、`replay` 和 `full` 模式继续保留。`disabled` 模式删除，因为不存在可回退的 Legacy Kernel。租户灰度规则删除；如未来重新引入灰度，应在 Pi 内部按能力或版本路由，而不是恢复第二套 Agent loop。

旧 `runAgent()` 中仍被 Pi 使用的中立类型或通用服务需要保留并移动到职责明确的模块。只删除 Legacy 专用循环，不重复实现模型网关、上下文压缩、工具代理、审批或 Hook 逻辑。

## 4. 数据与迁移

新增一条向前迁移，按外键和引用关系安全完成以下操作：

1. 删除 `kernel <> 'pi'` 的历史 Agent Run 及其关联 Attempt、Turn、Event、Interaction、Tool Ledger 和 Scheduler 关联记录；
2. 删除 LangGraph checkpoint 只读触发器；
3. 删除 `langgraph_checkpoint_writes` 和 `langgraph_checkpoints`；
4. 将仍存在的 Kernel 默认值和 Kernel version 默认值调整为 Pi；
5. 保证迁移可以在空表以及存在历史 LangGraph 数据的数据库上执行。

历史迁移 `0011_langgraph_checkpoints.sql` 和 `0019_langgraph_checkpoints_read_only.sql` 保留不动。新数据库仍按完整迁移链创建旧表后再由新迁移删除，以维持迁移历史可重复执行。

该迁移是不可逆的数据删除。回滚代码版本不能恢复已删除的 LangGraph 数据；恢复只能依赖迁移执行前的数据库备份。本次用户已明确选择放弃这些历史数据和旧版本恢复能力。

## 5. 运行中心

运行中心继续展示：

- Run 列表、状态筛选、分页和详情；
- Attempt 与 Kernel version；
- Committed Turn；
- Timeline/Event；
- Interaction 和工具执行；
- Token、耗时、错误、租约；
- 取消与安全恢复操作。

前后端 Run 的 Kernel 类型收敛为 `pi`。页面不再展示 LangGraph、Legacy 或“已退役 Kernel”分支。恢复资格继续由后端依据 Run 状态、租约、未决 Interaction 和不确定工具副作用计算，前端只消费 `canResume` 与 `recoveryBlockedReason`。

删除 checkpoint 表不会影响页面，因为运行中心当前不从 LangGraph checkpoint 构建列表、详情或 Timeline。

## 6. 配置与部署

- 删除 `AIOP_AGENT_KERNEL`；
- 删除 Legacy、tenant-rule 和 Pi disabled 相关环境变量说明与测试；
- development K8s 继续设置 `AIOP_PI_MODE=full`，但不再声明 Kernel 选择；
- 保留 Pi 并发、dry-run、replay、read-only 和 full 模式所需配置；
- 非法 Pi mode 或废弃 Kernel 配置不得静默改变执行语义。

## 7. 兼容性与错误处理

- API 路径和主要响应结构保持不变；
- 运行中心普通用户操作不需要迁移；
- 已删除的 LangGraph Run 查询返回不存在，而不是尝试兼容或恢复；
- 数据库中若迁移后仍出现非 Pi Kernel，Store 映射应明确报数据一致性错误；
- 服务不得在 Pi 初始化失败时回退 Legacy。

## 8. 测试与验收

至少覆盖：

1. Runtime 只构造并执行 Pi；
2. 缺省配置选择 Pi，废弃 Kernel 配置明确失败；
3. Pi `read-only`、`dry-run`、`replay`、`full` 行为保持；
4. 迁移删除历史 LangGraph 数据、触发器和 checkpoint 表；
5. Store、API 和前端类型不再暴露 Legacy/LangGraph；
6. 运行中心列表、详情、取消、恢复、Attempt、Turn、Timeline 和工具记录仍可用；
7. Scheduler 和 HTTP Agent 入口继续创建 Pi Run；
8. TypeScript typecheck、全量测试、前端 production build 和公共包验证通过；
9. 本地 K8s 部署后新 Run 为 Pi，运行中心可查看并操作；
10. 仓库中不存在 LangGraph 运行依赖、Legacy Kernel 或可执行配置残留。

## 9. 非目标

- 不接入外部日志、指标或链路平台；
- 不重做运行中心 UI；
- 不改变 Durable Runtime 的 Attempt、Turn Commit、Lease、Interaction 或 Tool Ledger 协议；
- 不重新设计 Scheduler；
- 不为已删除的 LangGraph 历史数据提供归档页面。

