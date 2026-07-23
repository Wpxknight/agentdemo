# 工具、Skill 与 MCP 设计

## 1. 总体结构

AIoP 将内置工具、Sandbox 工具、Skill 工具和 MCP 工具统一为 `ToolHandler`，由 `ToolRegistry` 提供定义列表和 dispatch。

~~~mermaid
flowchart LR
  Model[Model ToolCall]
  Broker[Tool Broker]
  Rules[Permission Rules]
  Policy[Ops Policy]
  Approval[Approval or Interaction]
  Hook[PreToolUse Hooks]
  Ledger[Tool Ledger]
  Registry[Tool Registry]
  Builtin[Built-in Tools]
  Skill[Skill Tools]
  MCP[MCP Tools]
  Sandbox[Sandbox Tools]

  Model --> Broker
  Broker --> Rules --> Policy --> Approval --> Hook --> Ledger --> Registry
  Registry --> Builtin
  Registry --> Skill
  Registry --> MCP
  Registry --> Sandbox
~~~

## 2. Tool Registry 与 Broker

`ToolRegistry` 负责注册、注销、列出定义和按名称调用。未知工具、参数异常和执行异常都转成 `ToolResult`，避免 Provider 协议被异常打断。

`executeToolCalls()` 对同一模型轮次的调用使用 `Promise.all` 并发执行，但返回顺序与模型 call 顺序一致。对于传入相应选项的 HTTP 与 Scheduler 调用，单调用顺序为：

1. Agent Run guard 与 AbortSignal。
2. Policy 检查。
3. Approval、durable approval 或拒绝。
4. PreToolUse Hook。
5. Tool Ledger begin 或 completed 结果复用。
6. Registry dispatch。
7. Ledger complete。
8. 发出 tool output 和 tool result 事件。

CLI 虽复用 Tool Broker、Policy、Approval 和 Tool Ledger，但 `runOnce()` 当前没有传入 Permission Rules 的工具定义过滤或配置化 Hook，因此不具备与 HTTP/Scheduler 完全相同的调用链。

## 3. 权限规则与运维策略

`PermissionRules` 支持 `allow`、`deny`、`ask`，优先级为 deny > ask > allow。规则可匹配工具名、MCP 前缀，以及 kubectl verb/目标或 Sandbox 命令文本。

无条件 deny 的工具在注入模型前被剥离；带参数条件的规则只能在执行时判断。

`OpsPolicy` 继续实施不可绕过的底线：

- 高危 shell，如 `rm -rf /`、`mkfs`、设备写入、重启。
- kubectl 未知集群、租户 ACL、namespace 白名单。
- 危险 kubectl verb。
- 角色写权限与只读集群。
- 生产集群审批、已批准变更计划或 preApproved。

规则 allow 可以跳过普通审批，但不能绕过危险命令、租户、namespace 和只读边界。

~~~mermaid
flowchart TD
  Call[ToolCall] --> Deny{deny rule}
  Deny -->|yes| Block[Block and audit]
  Deny -->|no| Hard{hard safety check}
  Hard -->|fail| Block
  Hard -->|pass| Ask{ask or production approval}
  Ask -->|required| Wait[Approval interaction]
  Ask -->|approved| Hooks[Run hooks]
  Ask -->|not required| Hooks
  Hooks -->|deny| Block
  Hooks -->|allow or fail-open| Dispatch[Dispatch tool]
~~~

## 4. Approval、Question 与 Plan

交互分为内存兼容路径和 durable interaction 路径。LangGraph Kernel 使用持久记录与 interrupt：

- approval：批准一次工具调用。
- question：`ask_user` 请求结构化回答。
- plan：`submit_change_plan` 请求批准变更计划。

会话内 `PlanApprovalState` 可让后续同会话生产变更免于逐条审批；它不跨会话扩权。

## 5. Hook

`HookRunner` 支持 command 和 webhook 两类 PreToolUse：

- command 通过 stdin 接收 JSON。
- webhook POST JSON，并使用 SSRF 校验。
- 任一 Hook deny 即拦截。
- Hook 执行失败默认 fail-open 并记录告警。

合规硬限制必须使用 Permission Rules 或内置 Policy，不能只依赖 fail-open Hook。

## 6. 内置工具

当前组装的主要工具族：

- Sandbox：运行命令、代码和文件操作。
- Browser/Desktop：截图、交互与预览。
- Export：从 Sandbox 导出受控下载文件。
- kubectl：目标集群运维。
- Schedule：创建、启停和查询定时任务。
- Todo：更新模型侧任务清单。
- Ask User：结构化提问。
- Change Plan：提交变更计划审批。
- Web Fetch：带域名和 SSRF 约束的抓取。
- Sandbox Profile：发现可用模板。
- Skill：加载内容、读取文件、同步到 Sandbox。

工具是否注册取决于配置和运行期能力。例如禁用代码 Sandbox 时会注销 Skill 同步工具。

## 7. Skill 系统

`SkillRegistry` 扫描配置目录中的 `SKILL.md`，解析名称、描述和正文，生成受预算控制的摘要注入系统提示词。

Skill 生命周期包括：

- 扫描本地/导入目录。
- 租户或管理员上传与导入。
- 启用、禁用、共享、取消共享和删除。
- 浏览 Skill 文件树并读取受限文件。
- 通过 `load_skill` 按需读取完整说明。
- 将 Skill 文件同步到当前用户会话的 Sandbox。

安全规则：

- 文件路径必须保持在 Skill 根目录内。
- 同步限制文件数量、单文件大小和总大小。
- 运行期凭据不能写入 Skill 文件或镜像。
- 共享和管理动作按角色与所有权授权。

## 8. MCP 管理

`McpManager` 支持 stdio、SSE 和 HTTP 配置。工具命名为 `mcp__<server>__<tool>`，避免不同 Server 冲突。

~~~mermaid
sequenceDiagram
  participant A as Admin API
  participant M as McpManager
  participant C as MCP Client
  participant R as Tool Registry
  participant S as Store

  A->>M: add or reconnect server
  M->>C: connect and listTools
  alt connected
    C-->>M: tool schemas
    M->>R: replace MCP handlers
    M->>S: persist configs
  else failed
    M-->>A: error status retained
  end
~~~

单 Server 连接失败只把该 Server 标为 error，不影响其他 Server。add/remove/reconnect 后，HTTP 层重新同步 Registry。公开信息不返回 header 敏感值。

## 9. 失败与测试边界

- Policy block 返回工具错误结果，不调用目标工具。
- Approval 拒绝返回明确错误结果。
- Hook 故障告警但默认放行。
- MCP 调用错误由对应 ToolResult 表达。
- Tool Ledger 的不确定副作用进入 recovery_required。
- 测试需覆盖规则优先级、kubectl 分类、并发结果顺序、Skill 路径穿越、同步限额、MCP 热更新和敏感配置隐藏。

## 10. 源码依据

- `src/agent/tools.ts`
- `src/agent/services/tool-broker.ts`
- `src/agent/rules.ts`
- `src/agent/policy.ts`
- `src/agent/hooks.ts`
- `src/tools/`
- `src/skill/registry.ts`
- `src/skill/import.ts`
- `src/mcp/manager.ts`
- `src/mcp/client.ts`
