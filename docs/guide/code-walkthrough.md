# AIoP 代码走读：从启动到一次 Agent Run

> 历史说明：本文部分 LangGraph 路径和文件引用已随 Pi Agent Platform 迁移退役。现行入口见 `packages/agent-runtime-core`、`packages/agent-kernel-pi`、`packages/agent-runtime-aiop` 与 `src/agent/pi`。

> 目标读者：第一次接触 AIoP、准备开发功能或排查问题的后端、前端和平台研发。
>
> 建议用时：快速浏览约 30 分钟；跟着源码和测试完整走读约 2 小时。

## 1. 读完后应该掌握什么

读完本文后，你应该能够回答：

- AIoP 有哪些进程入口，它们如何组装同一套 Runtime。
- 浏览器发起一次聊天后，请求如何经过 HTTP、Agent、模型、工具和 Store。
- Legacy Kernel 与 LangGraph Kernel 的关系是什么。
- Tool Broker 如何执行权限、审批、Hook 和 Tool Ledger。
- Skill、MCP、Sandbox 和 kubectl 如何进入统一工具体系。
- 会话、Checkpoint、Agent Run、Interaction 和工具执行记录分别保存什么。
- Scheduler 如何在多副本下领取任务。
- React 页面如何调用后端 API 和消费 SSE。
- 修改一个常见需求时应该从哪些文件和测试开始。

本文侧重“代码如何跑起来”，系统设计和完整边界请结合 [设计文档入口](../design/README.md) 阅读。

## 2. 最快阅读路线

如果只有 30 分钟，按以下顺序打开源码：

1. [src/index.ts](../../src/index.ts)：看四种进程入口。
2. [src/runtime.ts](../../src/runtime.ts)：看所有组件如何装配。
3. [src/server/http.ts](../../src/server/http.ts)：搜索 `/v1/agent` 和 `runAgentSse`。
4. [src/agent/runtime.ts](../../src/agent/runtime.ts)：看 Kernel 选择和 Agent Run binding。
5. [src/agent/core.ts](../../src/agent/core.ts)：看 Legacy Agent 循环。
6. [src/agent/langgraph/graph.ts](../../src/agent/langgraph/graph.ts)：看 LangGraph 的 prepare/model/tools 图。
7. [src/agent/services/tool-broker.ts](../../src/agent/services/tool-broker.ts)：看工具安全链。
8. [src/db/store.ts](../../src/db/store.ts)：看持久化能力总表。
9. [web/src/App.tsx](../../web/src/App.tsx)：搜索 `fetch('/v1/agent'`。
10. [tests/http.test.ts](../../tests/http.test.ts)：用集成测试验证理解。

## 3. 本地启动和质量命令

环境要求以 [package.json](../../package.json) 为准，当前需要 Node.js 20 或更高版本。

~~~bash
npm install
npm --prefix web install

npm run dev -- serve
npm run serve
npm run scheduler

npm run typecheck
npm test
npm --prefix web run build
~~~

常用入口：

| 目标 | 命令 |
| --- | --- |
| 开发模式监听 HTTP 服务源码 | `npm run dev -- serve` |
| 启动 HTTP/SSE 服务 | `npm run serve` |
| 启动独立 Scheduler | `npm run scheduler` |
| CLI 执行一次任务 | `npm start -- "检查当前环境"` |
| 创建首个平台管理员 | `npm start -- seed-admin <tenant> <user> <password>` |

配置从 `AIOP_CONFIG` 指定的 JSON/JSONC 文件读取，Schema 在 [src/config/schema.ts](../../src/config/schema.ts)。MySQL 环境变量解析在 [src/config/mysql.ts](../../src/config/mysql.ts)。

## 4. 先建立整体心智模型

~~~mermaid
flowchart LR
  Entry[HTTP CLI Scheduler]
  Compose[buildRuntime]
  Auth[Auth and RequestContext]
  Agent[AgentRuntime]
  Model[ChatModel]
  Broker[Tool Broker]
  Extensions[Built-in Skill MCP Sandbox]
  Store[Store]
  Web[React Web]

  Entry --> Compose
  Web --> Entry
  Compose --> Auth
  Compose --> Agent
  Compose --> Model
  Compose --> Broker
  Compose --> Extensions
  Compose --> Store
  Agent --> Model
  Agent --> Broker
  Agent --> Store
  Broker --> Extensions
~~~

可以把 AIoP 分成四个面：

- 接入面：HTTP、SSE、CLI、Scheduler、React Web。
- 执行面：Agent Runtime、Kernel、模型网关、Tool Broker。
- 扩展面：内置工具、Skill、MCP、Sandbox、kubectl。
- 控制面：认证、RBAC、Policy、审批、审计和 Store。

## 5. 目录地图

| 目录 | 主要职责 | 建议先读 |
| --- | --- | --- |
| `src/agent` | Agent 循环、Kernel、运行协调、上下文、工具策略 | `runtime.ts`、`core.ts`、`langgraph/graph.ts` |
| `src/model` | 中立消息协议和模型 Adapter | `types.ts`、`factory.ts` |
| `src/server` | HTTP、SSE、下载和请求上下文 | `http.ts` |
| `src/db` | Store、MySQL、Memory 和迁移 | `store.ts`、`migrations/` |
| `src/sandbox` | Provider、生命周期、Profile、Desktop | `runtime-controller.ts`、`lifecycle.ts` |
| `src/tools` | 所有内置工具 Adapter | 按需求选择 |
| `src/skill` | Skill 扫描、导入和文件管理 | `registry.ts` |
| `src/mcp` | MCP 连接与工具映射 | `manager.ts` |
| `src/auth` | Local、OIDC、AIOS、RBAC | `rbac.ts`、`local.ts`、`oidc.ts` |
| `src/scheduler` | Cron、领取和无人值守执行 | `ticker.ts`、`runner.ts` |
| `web/src` | React 页面、API 和类型 | `App.tsx`、`api.ts`、`types.ts` |
| `tests` | 行为契约与回归测试 | 从需求对应测试开始 |
| `deploy` | Kubernetes 与 OpenSandbox 部署 | `deploy/k8s/` |

## 6. 第一条主线：进程如何启动

入口在 [src/index.ts](../../src/index.ts)。

~~~mermaid
flowchart TD
  Main[main]
  Args{argv 0}
  Serve[runServer]
  Scheduler[runScheduler]
  Seed[seedAdmin]
  Once[runOnce]
  Runtime[buildRuntime]

  Main --> Args
  Args -->|serve| Serve --> Runtime
  Args -->|scheduler| Scheduler --> Runtime
  Args -->|seed-admin| Seed --> Runtime
  Args -->|other task| Once --> Runtime
~~~

### 6.1 HTTP Server

`runServer()` 的顺序：

1. 调用 `buildRuntime(config)`。
2. 根据 `AIOP_EMBED_SCHEDULER` 决定是否内嵌 Scheduler。
3. 调用 `createHttpServer(rt)`。
4. 监听 `HOST` 和 `PORT`。
5. SIGINT/SIGTERM 时关闭 Server、Scheduler 和 Runtime。

### 6.2 CLI

`runOnce()` 是可信本地入口：

- 使用 `defaultContext`。
- 自动批准工具审批。
- 复用 `cli` 会话历史。
- 调用相同 `AgentRuntime` 和 Tool Ledger。
- 成功后提交消息和 usage 审计。

需要注意：CLI 当前没有传入 HTTP/Scheduler 使用的 Permission Rules 工具定义过滤、配置化 Hook、上下文预算和图片保留选项，因此不是 HTTP 安全链的完全等价入口。

### 6.3 Scheduler

`runScheduler()` 创建 Runtime 后启动 `startRuntimeScheduler(rt)`。它不提供 HTTP，只周期领取数据库任务。

## 7. 第二条主线：Runtime 如何组装

[src/runtime.ts](../../src/runtime.ts) 是最重要的 Composition Root。不要试图第一次就逐行读完，建议按下面的顺序搜索。

### 7.1 Store 和控制组件

搜索 `createStore`、`PermissionRules`、`HookRunner`、`OpsPolicy`：

1. 创建 MySQL 或 Memory Store。
2. 创建 Audit Sink。
3. 创建 Cluster Registry。
4. 创建 Permission Rules。
5. 创建 PreToolUse Hook Runner。
6. 创建普通 Policy 和 preApproved Policy。
7. 创建 Plan Approval State。

### 7.2 Sandbox

搜索 `prepareSandboxGeneration` 和 `SandboxRuntimeController`：

1. 读取 `default` 平台 Sandbox 设置。
2. 创建 Local、E2B 或 OpenSandbox Provider。
3. AIOS 模式读取模板目录，并复用 E2B Provider。
4. 构造 Profile、SandboxManager、Desktop Provider 和 Warm Pool。
5. 将 generation 原子提交到 Controller。
6. 根据当前 capability 动态注册或注销 Sandbox 工具。

### 7.3 工具和扩展

搜索 `tools.register`：

- Sandbox 命令、代码和文件工具。
- Browser/Desktop。
- Export。
- kubectl。
- Schedule。
- Todo、Ask User、Change Plan。
- Web Fetch。
- Skill 工具。
- MCP 工具。

所有工具最终进入 [src/agent/tools.ts](../../src/agent/tools.ts) 的 `ToolRegistry`。

### 7.4 模型、认证和 Agent Runtime

最后阅读：

- `createModel()`：创建 Anthropic/OpenAI Adapter。
- `LocalAuthProvider`、`OidcAuthProvider`、`AiosAuthProvider`。
- `createConfiguredAgentRuntime()`：创建 Legacy/LangGraph Kernel、Checkpoint Saver 和 Run Coordinator。
- Runtime 返回对象中的 `updateModel`、`updateSandbox`、`refreshSandboxTemplates` 和 `dispose`。

一个重要现状是：Model、Sandbox Controller 和 MCP Manager 都是进程级单实例，启动时主要读取 `default` 设置，并非真正的 tenant-scoped Runtime。

## 8. 第三条主线：一次 HTTP 聊天请求

前端入口在 [web/src/App.tsx](../../web/src/App.tsx)，搜索：

~~~typescript
fetch('/v1/agent', ...)
~~~

后端入口在 [src/server/http.ts](../../src/server/http.ts)：

- `createHttpServer(rt)` 创建 Server。
- `handle()` 做路径分发。
- `requireAuth()` 构建 RequestContext。
- `runAgentSse()` 处理 Agent 流。

~~~mermaid
sequenceDiagram
  actor U as User
  participant W as Web App
  participant H as HTTP handle
  participant S as Store
  participant A as AgentRuntime
  participant K as Kernel
  participant M as Model
  participant B as Tool Broker

  U->>W: send
  W->>H: POST /v1/agent
  H->>H: requireAuth and validate body
  H->>S: load or create session
  H->>A: run with runId and AbortSignal
  A->>K: select locked kernel
  K->>M: stream model turn
  opt tool calls
    K->>B: execute tool calls
    B-->>K: tool results
    K->>M: next turn
  end
  K-->>H: neutral StreamEvent
  H-->>W: SSE
  H->>S: commit result and audit
~~~

### 8.1 HTTP 层做了什么

`runAgentSse()` 负责的不是模型推理本身，而是 Web 语义：

- 校验用户状态和会话归属。
- 建立 Session 互斥，防止同会话并发 Agent Run。
- 创建 runId、AbortController 和运行记录。
- 读取历史、上下文预算和图片配置。
- 注入当前用户可见 Skill、Sandbox 和用户目录说明。
- 连接 approval、question 和 change plan。
- 把 `StreamEvent` 编码为 SSE。
- 成功、失败或终止时调用 `SessionCommitter`。
- 写 usage 和错误审计。
- 处理活动会话追加消息。

### 8.2 建议同时读的测试

从 [tests/http.test.ts](../../tests/http.test.ts) 依次阅读这些测试名称：

- `runs an agent over SSE and persists the session`。
- `continues a session`。
- `terminates an active agent run`。
- `pauses an SSE agent run for approval`。
- `rejects a concurrent run on the same session`。
- `auto-compacts a long history`。

测试比路由代码更快说明“系统对外承诺什么”。

## 9. 第四条主线：Agent Runtime 与双 Kernel

入口在 [src/agent/runtime.ts](../../src/agent/runtime.ts)。

先统一所有权标记：

| 标记 | 含义 | 本节示例 |
| --- | --- | --- |
| **开源引用** | 外部项目直接提供的协议或运行机制 | LangGraph `StateGraph`、Checkpoint、`interrupt()`、`Command` |
| **自研** | AIoP 定义并维护的业务契约和实现 | `AgentRuntime`、Legacy Loop、Tool Broker、Run Coordinator |
| **混合封装** | 基于开源扩展点实现 AIoP 特有适配 | `LangGraphAgentKernel`、MySQL Checkpoint Saver |

不要把 `Agent Runtime` 和 LangGraph 画等号：LangGraph 只在一个 Kernel 内部提供图执行机制。

### 9.1 AgentRuntime

`AgentRuntime` 是**自研**稳定入口。`AgentRuntime.run()` 做三件事：

1. 选择 Kernel。
2. 用 Agent Run binding 锁定 Kernel 和 graph version。
3. 在存在 runId 时用 `AgentRunCoordinator` 包裹生命周期。

`AIOP_AGENT_KERNEL` 支持 `legacy`、`langgraph`、`tenant-rule`。已创建的 Run 不会因为运行时配置变化而切换 Kernel。

### 9.2 Legacy Kernel

[src/agent/legacy-kernel.ts](../../src/agent/legacy-kernel.ts) 是很薄的**自研**适配器，只调用 [src/agent/core.ts](../../src/agent/core.ts) 的 `runAgent()`。

仓库里没有 `AgentCore` 类。`core.ts` 一方面定义两个 Kernel 共用的 `RunAgentOptions` / `RunAgentResult`，另一方面实现 Legacy 路径的自研 Agent Loop。共享逻辑已拆到 `src/agent/services/**`。

`runAgent()` 的核心循环：

1. 构建 system prompt。
2. 在轮次边界做摘要压缩。
3. 调用 `runModelTurn()`。
4. 保存 assistant 文本、thinking 和 tool calls。
5. 有工具调用则执行 Tool Broker。
6. 把 ToolResult 追加为 tool 消息。
7. 继续下一轮，直到模型不再调用工具或达到 maxSteps。

### 9.3 LangGraph Kernel

[src/agent/langgraph/graph.ts](../../src/agent/langgraph/graph.ts) 使用开源 LangGraph 机制，将相同的自研业务语义拆为三个节点：

~~~mermaid
flowchart LR
  Start([START]) --> Prepare[prepare]
  Prepare --> Model[model]
  Model -->|tool calls| Tools[tools]
  Tools -->|continue| Model
  Model -->|complete| End([END])
~~~

- `StateGraph`、`Annotation`、条件边、Checkpoint、interrupt/Command：**开源引用**。
- `prepare`：**自研节点**，准备消息并检查取消。
- `model`：**自研节点**，调用共享 Context Service 和 Model Gateway。
- `tools`：**自研节点**，调用共享 Tool Broker。
- `observedNode`：**自研封装**，写节点时间线并执行 Run guard。

[src/agent/langgraph/kernel.ts](../../src/agent/langgraph/kernel.ts) 是**混合封装**，负责 thread id、Checkpoint metadata、graph invoke、interrupt 检测和 Command resume。

### 9.4 Agent Run 与恢复

[src/agent/run-coordinator.ts](../../src/agent/run-coordinator.ts) 负责：

- 获取和续约 Lease。
- 用 token fencing 防止旧 owner 写入。
- 在节点/工具边界检查取消。
- 更新 running、waiting 和终态。
- 写 Agent Run events。

Checkpoint、Lease、Interaction 和 Tool Ledger 不是一回事：

| 机制 | 解决的问题 |
| --- | --- |
| Checkpoint | 图计算状态恢复 |
| Agent Run binding | Kernel 和 graph version 不漂移 |
| Lease | 多副本执行所有权 |
| Interaction | 审批、问题和计划事实 |
| Tool Ledger | 外部副作用结果复用与不确定性 |

当前没有自动扫描器接管 Lease 已过期的 running Run。Interaction waiter 也是进程内状态，跨副本解析需要粘性路由或后续通知机制。

另一个当前差异是：LangGraph 路径会在节点、模型和工具边界调用 `runGuard`；Legacy `runAgent()` 目前没有继续传递该 guard，主要依赖 AbortSignal，因此多副本 fencing 与 Store 取消检查并不完全等价。

### 9.5 Agent Core 共享能力与修改入口

| 想修改的行为 | 所有权 | 首选文件 |
| --- | --- | --- |
| Kernel 选择、灰度、binding、graph version | **自研** | `src/agent/runtime.ts` |
| Legacy model → tools 循环 | **自研** | `src/agent/core.ts` |
| LangGraph 状态、节点和路由 | **自研** | `src/agent/langgraph/state.ts`、`graph.ts` |
| LangGraph thread、invoke、interrupt/resume | **混合封装** | `src/agent/langgraph/kernel.ts` |
| 模型流、重试和 usage | **自研** | `src/agent/services/model-gateway.ts` |
| Prompt 与上下文压缩 | **自研** | `src/agent/services/prompt.ts`、`context-service.ts`、`context.ts` |
| 工具安全链 | **自研** | `src/agent/services/tool-broker.ts`、`policy.ts`、`rules.ts`、`hooks.ts` |
| Run lease、取消和节点事件 | **自研** | `src/agent/run-coordinator.ts` |
| LangGraph Saver 协议实现 | **混合封装** | `src/agent/checkpoint/mysql.ts` |

详细设计见[Agent Runtime、Agent Loop 与 Agent Core 设计](../design/02-agent-runtime.md)。

## 10. 第五条主线：模型和上下文

从 [src/model/types.ts](../../src/model/types.ts) 开始。`Msg`、`ToolDef`、`ToolCall`、`ToolResult` 和 `StreamEvent` 是 Provider 中立契约。

[src/model/factory.ts](../../src/model/factory.ts) 根据 protocol 创建：

- [src/model/anthropic.ts](../../src/model/anthropic.ts)
- [src/model/openai.ts](../../src/model/openai.ts)

[src/agent/services/model-gateway.ts](../../src/agent/services/model-gateway.ts) 处理：

- 流式事件归集。
- usage 累加。
- 整轮重试。
- 4xx 分类。
- AbortSignal。
- 指数退避。

[src/agent/context.ts](../../src/agent/context.ts) 处理：

1. 只保留最近 K 条带图消息。
2. 截断单条超大消息。
3. 从最旧历史开始硬裁剪。
4. 保持 tool call/result 配对。
5. 生成摘要压缩计划。

调上下文问题时优先阅读 [tests/context.test.ts](../../tests/context.test.ts)、[tests/context-service.test.ts](../../tests/context-service.test.ts) 和 [tests/model-gateway.test.ts](../../tests/model-gateway.test.ts)。

## 11. 第六条主线：工具执行与安全链

入口是 [src/agent/services/tool-broker.ts](../../src/agent/services/tool-broker.ts)。

~~~mermaid
flowchart TD
  Call[ToolCall]
  Guard[Run guard and abort]
  Policy[Permission Rules and Ops Policy]
  Approval[Approval or durable interaction]
  Hook[PreToolUse Hook]
  Ledger[Tool Ledger begin]
  Dispatch[ToolRegistry dispatch]
  Complete[Tool Ledger complete]

  Call --> Guard --> Policy --> Approval --> Hook --> Ledger --> Dispatch --> Complete
~~~

需要区分：

- [src/agent/rules.ts](../../src/agent/rules.ts)：配置化 allow/deny/ask。
- [src/agent/policy.ts](../../src/agent/policy.ts)：kubectl、危险 shell、生产审批等硬规则。
- [src/agent/hooks.ts](../../src/agent/hooks.ts)：外部 command/webhook 联动，失败默认 fail-open。
- [src/agent/tool-ledger/store.ts](../../src/agent/tool-ledger/store.ts)：防止恢复时盲目重放副作用。

同轮工具调用并发执行，但 ToolResult 按模型 call 顺序返回。最直接的行为说明在 [tests/tool-broker.test.ts](../../tests/tool-broker.test.ts)。

## 12. 第七条主线：Skill、MCP 和 Sandbox

### 12.1 Skill

[src/skill/registry.ts](../../src/skill/registry.ts) 扫描 `SKILL.md`、生成摘要并管理文件树。 [src/tools/skill.ts](../../src/tools/skill.ts) 将读取、加载和同步能力暴露给模型。

关注三个边界：

- 可见性：私有、共享和管理员管理。
- 路径：必须留在 Skill 根目录。
- 凭据：运行期注入，不能写入 Skill 或镜像。

### 12.2 MCP

[src/mcp/manager.ts](../../src/mcp/manager.ts) 将 MCP 工具映射为：

`mcp__<server>__<tool>`

Manager 支持 add/remove/reconnect；单个 Server 失败不会阻断其他 Server。HTTP 修改配置后会重新同步 ToolRegistry。

### 12.3 Sandbox

建议阅读顺序：

1. [src/sandbox/types.ts](../../src/sandbox/types.ts)：Provider 和 Handle。
2. [src/sandbox/lifecycle.ts](../../src/sandbox/lifecycle.ts)：复用、使用计数和回收。
3. [src/sandbox/runtime-controller.ts](../../src/sandbox/runtime-controller.ts)：generation 热切换。
4. [src/sandbox/profiles.ts](../../src/sandbox/profiles.ts)：模板和角色可见性。
5. Local、E2B、OpenSandbox 的具体 Provider。

~~~mermaid
stateDiagram-v2
  [*] --> Current
  Current --> Draining: settings or catalog changes
  Draining --> Disposed: active operations reach zero
  Current --> Current: reuse handles
~~~

AIOS 不是第四种 Provider，而是 E2B 兼容路径上的 Lifecycle 和模板目录集成。

## 13. 第八条主线：Store 和 MySQL

[src/db/store.ts](../../src/db/store.ts) 是持久化能力清单。第一次阅读不要先看 `mysql.ts` 的 SQL 细节，先按领域浏览接口：

- Session 和 Message。
- Interaction 和 Tool Execution。
- Agent Run、Event 和 Lease。
- Audit。
- Scheduled Task 和 Task Run。
- Tenant、User 和 Credential。
- LLM、Scheduler、Sandbox 和 MCP Settings。

再对照：

- [src/db/memory.ts](../../src/db/memory.ts)：容易理解行为。
- [src/db/mysql.ts](../../src/db/mysql.ts)：生产事务与 SQL。
- [src/db/migrations](../../src/db/migrations)：真实表结构。
- [src/db/index.ts](../../src/db/index.ts)：连接与迁移入口。

生产问题排查时，先判断故障属于哪类数据：

| 现象 | 首先检查 |
| --- | --- |
| 历史消息不对 | sessions、messages |
| Run 状态不对 | agent_runs、agent_run_events |
| 审批卡住 | agent_interactions 和执行副本 |
| 工具无法恢复 | agent_tool_executions |
| LangGraph 无法恢复 | langgraph_checkpoints、writes、graph version |
| 定时任务重复/漏跑 | scheduled_tasks、task_runs、claim 事务 |
| 设置未生效 | tenant_settings、setting_secrets 和进程级 Runtime |

## 14. 第九条主线：Scheduler

[src/scheduler/ticker.ts](../../src/scheduler/ticker.ts) 的 `Scheduler.tick()`：

1. `claimDueTasks(now, batch)`。
2. 逐个调用 TaskRunner。
3. 成功或失败都写 task_runs。
4. 单任务失败不阻断其他任务。

[src/scheduler/runner.ts](../../src/scheduler/runner.ts) 将任务转换为 Agent Run：

- 身份来自任务 tenant/user。
- role 固定为 user。
- preApproved 选择不同 Policy。
- 未预批准的审批由 AutoDeny。
- 使用上下文预算、Tool Ledger 和 SessionCommitter。
- 默认最长运行时间为 4 小时，可通过设置修改。

多副本正确性依赖 MySQL 的原子 claim/`SKIP LOCKED`，Memory Store 只适合开发。

## 15. 第十条主线：React Web

从 [web/src/app-data.ts](../../web/src/app-data.ts) 看一级页面，再读 [web/src/api.ts](../../web/src/api.ts) 的 Token API Client。

主要页面仍集中在 [web/src/App.tsx](../../web/src/App.tsx)：

| 页面 | 关键 API |
| --- | --- |
| Chat | `/v1/agent`、`/v1/sessions`、终止和追加 |
| Runs | `/v1/agent/runs` |
| Skills | `/v1/skills` |
| MCP | `/v1/mcp/servers` |
| Schedule | `/v1/schedule` |
| Sandbox | `/v1/sandboxes`、Profile 和截图 |
| Users | `/v1/admin/users` |
| Settings | `/v1/settings/*` |

Run Center 已拆到 [web/src/components/run-center-page.tsx](../../web/src/components/run-center-page.tsx)。Mermaid 渲染在 [web/src/components/mermaid-diagram.tsx](../../web/src/components/mermaid-diagram.tsx)。

前端调试聊天时，从 `sendMessage()` 附近开始，观察：

- 请求体。
- SSE 分帧解析。
- model_retry 回滚。
- tool_output 按 session 隔离。
- 最终消息与重新加载历史的合并。

## 16. 常见需求应该改哪里

| 需求 | 首选入口 | 通常需要同步 |
| --- | --- | --- |
| 新增模型协议 | `src/model/types.ts`、`factory.ts` | Adapter 测试、配置 Schema、设置 UI |
| 新增内置工具 | `src/tools/`、`src/runtime.ts` | Tool Broker/Policy 测试、前端事件展示 |
| 修改工具权限 | `rules.ts`、`policy.ts` | RBAC、审计和 policy 测试 |
| 新增 Sandbox Provider | `src/sandbox/types.ts`、Provider | Runtime 装配、Profile、合同测试、设置 UI |
| 新增 API | `src/server/http.ts` | `web/src/api.ts`、types、HTTP 测试 |
| 新增页面 | `web/src/app-data.ts`、`App.tsx` | CSS、API、frontend 测试 |
| 修改 Legacy Agent Loop | `src/agent/core.ts` | 共享 options/result、Agent 行为测试、Kernel parity |
| 修改 Agent 图 | `src/agent/langgraph/graph.ts`、`state.ts` | graph version、Checkpoint 兼容、Kernel parity |
| 修改会话数据 | `src/db/store.ts` | Memory/MySQL、迁移、HTTP 测试 |
| 修改调度行为 | `src/scheduler/` | Store claim、Schedule API 和测试 |
| 修改认证/RBAC | `src/auth/` | HTTP 权限、租户隔离、安全测试 |

原则：先修改稳定接口和测试，再修改具体实现；不要只改 MySQL 而漏掉 Memory Store，也不要只隐藏前端按钮而不做后端授权。

## 17. 推荐断点和日志字段

### 17.1 一次聊天请求

建议断点：

1. `src/server/http.ts: handle()`
2. `runAgentSse()`
3. `AgentRuntime.run()`
4. `runAgent()` 或 LangGraph `model` 节点
5. `runModelTurn()`
6. `executeToolCall()`
7. `SessionCommitter.commitSuccess()`

### 17.2 Sandbox 工具

建议断点：

1. Tool Handler。
2. `SandboxRuntimeController.acquire()`。
3. `SandboxManager.get()`。
4. 具体 Provider 的 create/connect。
5. Policy 和 Audit。

### 17.3 常用日志关联字段

- `tenantId`、`userId`、`sessionId`。
- `runId`、`currentNode`、`leaseOwner`、`leaseToken`。
- `tool`、`toolCallId`、`cluster`。
- `taskId`、`sandboxId`、`profile`。
- 模型 `attempt`、token usage 和 duration。

排查时优先使用 runId 串起 Agent Run、节点、Interaction、Tool Ledger 和 Checkpoint。

## 18. 测试地图

| 领域 | 重点测试 |
| --- | --- |
| Agent 行为 | `agent.test.ts`、`agent-behavior-v1.test.ts` |
| Kernel | `agent-runtime.test.ts`、`agent-kernel-parity.test.ts`、`langgraph-kernel.test.ts` |
| 恢复 | `langgraph-run-recovery.test.ts`、`agent-run-coordinator.test.ts` |
| HTTP/SSE | `http.test.ts`、`http-agent-runs.test.ts` |
| 工具安全链 | `tool-broker.test.ts`、`policy.test.ts`、`rules.test.ts`、`hooks.test.ts` |
| Sandbox | `sandbox.test.ts`、`runtime-sandbox-controller.test.ts`、Provider 测试 |
| 数据库 | `db.test.ts`、`agent-run-store.test.ts`、`mysql-checkpointer.test.ts` |
| 调度 | `scheduler.test.ts` |
| 认证 | `auth.test.ts`、`oidc.test.ts`、`aios-integration.test.ts` |
| Web | `frontend.test.ts`、`web-run-center-source.test.ts` |

定位回归时优先运行单文件：

~~~bash
npx vitest run tests/tool-broker.test.ts
npx vitest run tests/http.test.ts -t "runs an agent over SSE"
~~~

## 19. 新人最容易踩的坑

1. 把 `src/runtime.ts` 当领域实现文件。它应该负责装配，具体规则应放回领域模块。
2. 认为所有入口安全语义完全相同。CLI 当前没有 HTTP/Scheduler 的全部过滤和 Hook 选项。
3. 认为 tenant_settings 意味着运行态已经按租户隔离。Model、Sandbox Controller、MCP Manager 当前是进程级单实例。
4. 认为 LangGraph Checkpoint 能替代 Agent Run、Lease 或 Tool Ledger。
5. 自动重放 status=started 的写工具。副作用可能已经发生，应进入 recovery_required。
6. 认为 Lease 过期会自动接管。当前没有后台接管扫描器。
7. 认为 Interaction resolved 后任意副本都能唤醒原 Run。waiter 当前在进程内。
8. 只修改 MySQL Store，忘记 Memory Store 和合同测试。
9. 只做前端权限隐藏，忘记服务端 `requirePermission`。
10. 修改 LangGraph 图却不考虑 graph version 和旧 Checkpoint。

## 20. 新人第一周建议

### 第 1 天：跑起来

- 完成安装、typecheck、test 和 Web build。
- 用 Local Auth 启动服务。
- 创建会话并执行一次不调用工具的聊天。
- 在 `runAgentSse()` 和 `runModelTurn()` 打断点。

### 第 2 天：跟一次工具调用

- 使用无副作用工具。
- 跟踪 ToolCall → Policy → Broker → ToolResult → 下一轮模型。
- 阅读 `tool-broker.test.ts`。

### 第 3 天：理解持久化

- 对照 Store 接口和迁移。
- 查看一次 Agent Run 写入的 Run/Event/Tool Ledger/Checkpoint。
- 手工终止一次运行并观察 SessionCommitter。

### 第 4 天：理解 Sandbox 与扩展

- 跟一次 Local Sandbox。
- 导入一个最小 Skill。
- 连接测试 MCP Server。
- 观察工具如何动态进入 Registry。

### 第 5 天：做一个小改动

推荐任选其一：

- 新增一个只读内置工具。
- 给现有 API 增加一个只读字段。
- 给运行中心增加一个展示字段。
- 为某个失败边界补一条测试。

提交前运行完整质量门禁。

## 21. 延伸阅读

- [系统总览](../design/01-system-overview.md)
- [Agent Runtime 设计](../design/02-agent-runtime.md)
- [模型与上下文设计](../design/03-model-and-context.md)
- [工具、Skill 与 MCP 设计](../design/04-tools-skills-mcp.md)
- [Sandbox 与运维设计](../design/05-sandbox-and-ops.md)
- [认证、安全与多租户设计](../design/06-auth-security-tenancy.md)
- [数据与持久化设计](../design/07-data-and-persistence.md)
- [Scheduler 设计](../design/08-scheduler.md)
- [HTTP API 与 Web 设计](../design/09-api-and-web.md)
- [部署与可观测性设计](../design/10-deployment-observability.md)
- [演进路线](../design/11-evolution-roadmap.md)
