# Agent Runtime 文档更新设计

## 目标

更新 AIoP 现行设计文档，使读者能够准确区分 Agent Runtime、Agent Kernel、Agent Loop 和 Agent Core，并明确每项能力属于开源引用、自研实现还是混合封装。

## 范围

深度更新 `docs/design/02-agent-runtime.md`，并同步以下关联文档：

- `docs/design/01-system-overview.md`
- `docs/design/03-model-and-context.md`
- `docs/design/04-tools-skills-mcp.md`
- `docs/guide/code-walkthrough.md`

不修改运行时代码、依赖、配置或数据库结构。

## 分类口径

所有 Agent Runtime 相关组件统一使用三类标记：

| 标记 | 定义 | 示例 |
| --- | --- | --- |
| 开源引用 | 直接使用外部项目提供的运行机制或协议 | LangGraph `StateGraph`、`interrupt()`、`Command`、Checkpoint API |
| 自研 | AIoP 定义并维护的业务契约、控制逻辑或实现 | `AgentRuntime`、Legacy Agent Loop、Tool Broker、Run Coordinator |
| 混合封装 | 基于开源协议或类型实现 AIoP 特有适配与扩展 | `LangGraphAgentKernel`、自研图节点、MySQL Checkpoint Saver |

“使用 LangGraph”不得描述成“Agent Runtime 由 LangGraph 提供”。LangGraph 只位于 Kernel 内部，负责状态图执行、Checkpoint 和 interrupt/resume 原语。

## 主文档结构

`02-agent-runtime.md` 按以下顺序组织：

1. 概念与所有权速览：Runtime、Kernel、Loop、Core 的定义和分类。
2. 总体架构：调用方、Runtime、双 Kernel、共享自研服务和 Store 的关系。
3. `AgentRuntime`：选择、binding、版本锁定和 Run Coordinator。
4. Legacy 路径：`LegacyAgentKernel` 与 `runAgent()` 的完整循环。
5. LangGraph 路径：开源运行机制与自研图定义的边界。
6. 共享 Agent Core 服务：Prompt、Context、Model Gateway、Tool Broker。
7. Agent Run、Checkpoint、Interaction 和 Tool Ledger 的不同职责。
8. 故障恢复、边界和测试证据。
9. 开源替代评估：说明哪些自研能力可被局部替换，避免把替换框架当成替换平台。

## 关联文档同步规则

- 系统总览只保留架构级结论和所有权矩阵，链接到 Agent Runtime 主文档。
- 模型与上下文文档明确 Model Adapter、Model Gateway、Context Service 均为自研，底层 SDK/LangChain 类型为开源引用。
- 工具文档明确 LangGraph 只调用自研 Tool Broker，不直接绕过 Policy、Approval、Hook 和 Ledger。
- 代码走读使用同一术语和分类标记，避免继续把 `core.ts` 含糊称为整个 Agent Runtime。

## 验证标准

- 文档中的源码路径、符号和行为与当前实现一致。
- Mermaid 节点和时序反映真实调用方向。
- 搜索 Agent Runtime、Kernel、Loop、Core、LangGraph、Legacy 时，不出现相互矛盾的所有权描述。
- 相对链接有效，`git diff --check` 通过。
- 不包含 `TODO`、`TBD` 或未经源码证明的未来能力。
