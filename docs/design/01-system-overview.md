# AIoP 系统总览

## 1. 定位与范围

AIoP 是面向企业运维与研发场景的多租户 Web Agent 平台。它把大模型、工具、Skill、MCP、隔离沙箱、集群运维、定时任务和审计能力组装为统一运行时，并通过 HTTP/SSE、Web 页面、CLI 和调度器提供入口。

当前系统负责：

- 维护用户、租户、会话、消息、Agent Run 与审计数据。
- 按配置选择 Anthropic 或 OpenAI 协议模型。
- 在工具执行前实施权限规则、运维策略、审批和 Hook。
- 管理 Local、E2B、OpenSandbox 三类 Sandbox Provider。
- 通过 E2B 兼容路径接入 AIOS Lifecycle 和模板目录。
- 管理本地 Skill、MCP Server、定时任务和运行中心。
- 通过 MySQL 提供生产持久化，未配置时降级为内存 Store。

非目标：

- AIoP 不实现通用模型训练或推理服务。
- AIoP 不把 LangGraph Checkpoint 当作业务数据库或分布式锁。
- AIoP 不把沙箱内权限当作平台侧授权边界。
- AIoP 不承诺工具副作用 exactly-once。

## 2. 系统上下文

~~~mermaid
flowchart LR
  User[普通用户]
  Admin[租户或平台管理员]
  AIOS[AIOS 宿主平台]
  Model[Anthropic 或 OpenAI 兼容模型]
  MCP[MCP Servers]
  Sandbox[Local E2B OpenSandbox]
  Cluster[Kubernetes 集群]
  DB[(MySQL)]

  subgraph AIOP[AIoP]
    Web[React Web]
    API[HTTP 与 SSE]
    Runtime[Agent Runtime]
    Control[认证 策略 审计 调度]
  end

  User --> Web
  Admin --> Web
  AIOS --> API
  Web --> API
  API --> Runtime
  API --> Control
  Runtime --> Model
  Runtime --> MCP
  Runtime --> Sandbox
  Sandbox --> Cluster
  Control --> DB
  Runtime --> DB
~~~

信任边界分为三层：

1. 浏览器、AIOS 宿主和外部调用方是不可信输入源。
2. HTTP 层、认证上下文、策略和 Store 是平台权威控制面。
3. 模型、MCP、沙箱和目标集群是受控外部执行面。

## 3. 运行形态

| 入口 | 命令 | 职责 |
| --- | --- | --- |
| HTTP Server | `tsx src/index.ts serve` | Web 静态资源、JSON API、SSE Agent 运行；可内嵌 Scheduler |
| Scheduler | `tsx src/index.ts scheduler` | 周期领取并执行到期任务 |
| CLI Agent | `tsx src/index.ts "<task>"` | 使用默认可信身份执行一次任务并续接 `cli` 会话 |
| 初始化管理员 | `tsx src/index.ts seed-admin ...` | 仅 Local Auth 下创建首个平台管理员 |

所有入口都通过 `buildRuntime()` 复用同一组组件和 `AgentRuntime`，但调用选项并不完全相同。

| 能力 | HTTP | Scheduler | CLI |
| --- | --- | --- | --- |
| Agent Run 与 Tool Ledger | 是 | 是 | 是 |
| Permission Rules 工具定义过滤 | 是 | 是 | 否 |
| 配置化 PreToolUse Hook | 是 | 是 | 否 |
| 上下文预算与图片保留 | 是 | 是 | 未显式传入 |
| 人工交互 | 是 | 无人值守 AutoDeny | 可信操作者 AutoApprove |
| 会话与用量提交 | 是 | 是 | 是 |

因此 CLI 是可信本地操作入口，不应直接视为 HTTP 链路的安全等价实现。

## 4. 总体组件架构

~~~mermaid
flowchart TB
  Entry[CLI HTTP Scheduler]
  Config[Config Schema 与环境变量]
  Compose[buildRuntime Composition Root]
  Auth[Auth Provider 与 RBAC]
  Agent[Agent Runtime]
  Model[Model Adapters]
  Tool[Tool Registry 与 Tool Broker]
  Ext[Skill 与 MCP]
  Policy[Rules Policy Approval Hooks]
  Sbx[Sandbox Runtime Controller]
  Store[Store]
  MySQL[(MySQL)]
  Memory[(Memory)]
  Web[React Web]

  Entry --> Compose
  Config --> Compose
  Compose --> Auth
  Compose --> Agent
  Compose --> Model
  Compose --> Tool
  Compose --> Ext
  Compose --> Policy
  Compose --> Sbx
  Compose --> Store
  Store --> MySQL
  Store --> Memory
  Web --> Entry
  Agent --> Model
  Agent --> Tool
  Tool --> Policy
  Tool --> Sbx
  Tool --> Ext
  Agent --> Store
~~~

### 4.1 Composition Root

`src/runtime.ts` 是主要装配点，负责：

- 从文件配置、环境变量和租户设置解析模型与 Sandbox 设置。
- 创建 Model Adapter、Store、Checkpoint Saver、Agent Runtime。
- 注册 Sandbox、Browser、Export、kubectl、Schedule、Todo、Ask User、Change Plan、Web Fetch、Skill 和 MCP 工具。
- 创建 Local/OIDC Auth，并可并行启用 AIOS 嵌入认证。
- 创建 Permission Rules、Ops Policy、Hook Runner、Audit Sink 和用户凭据服务。
- 支持模型、MCP 与 Sandbox 设置的运行期更新。

该文件是组装边界，不应成为具体领域规则的归属地。

## 5. 主要数据与请求路径

~~~mermaid
sequenceDiagram
  actor U as User
  participant W as React Web
  participant H as HTTP Server
  participant A as Agent Runtime
  participant M as Model
  participant T as Tool Broker
  participant S as Store

  U->>W: 输入任务
  W->>H: POST Agent 请求
  H->>S: 读取会话历史
  H->>A: run(runId, context, messages)
  A->>M: stream(messages, tools)
  M-->>A: 文本或工具调用
  A->>T: 执行工具调用
  T-->>A: 工具结果
  A->>M: 继续模型轮次
  A-->>H: StreamEvent
  H-->>W: SSE
  A-->>H: 最终结果
  H->>S: 提交消息、用量与审计
~~~

关键原则：

- 请求身份由服务端认证生成，不能相信模型或客户端提供的 tenant/user/role。
- 工具定义可在注入模型前过滤，调用时仍必须再次执行策略检查。
- 流式展示和最终持久化分离；失败时由 `SessionCommitter` 写入可解释的终止结果。
- Agent Run、Checkpoint、Interaction 和 Tool Ledger 共同构成 durable execution，但职责不同。

## 6. 技术栈与开源组件

版本唯一事实源为根目录和 `web/package.json`，本文不复制版本范围。

| 层次 | 组件或包 | 用途 | 封装与替换影响 |
| --- | --- | --- | --- |
| 运行时 | Node.js、TypeScript、`tsx` | 服务、CLI、调度与开发运行 | ESM 与 Node API 使用广，替换运行时影响全仓 |
| 配置 | `zod` | 配置解析与跨字段校验 | 集中在 `src/config/schema.ts` |
| 模型 | `@anthropic-ai/sdk`、`openai` | 两种模型协议与流式响应 | 经 `ChatModel` 中立接口隔离 |
| Agent | `@langchain/core`、`@langchain/langgraph` | LangGraph Kernel、StateGraph、interrupt | Legacy Kernel 保留回退路径 |
| 持久化 | `mysql2`、`kysely` | MySQL 连接与类型化查询 | 经 `Store` 隔离；生产迁移依赖 SQL |
| Checkpoint | LangGraph checkpoint API | 图状态保存和恢复 | 自定义 MySQL Saver；不能替代 Agent Run Lease |
| MCP | `@modelcontextprotocol/sdk` | stdio/SSE/HTTP MCP 接入 | 经 `McpManager` 映射为 Tool Handler |
| Sandbox | `@alibaba-group/opensandbox` | OpenSandbox 生命周期 | 经 `SandboxProvider` 封装 |
| Sandbox | `@e2b/code-interpreter`、`@e2b/desktop` | 代码与桌面沙箱 | 经 Provider 与 Desktop Provider 封装 |
| Auth | `jose`、`openid-client` | JWT、OIDC 登录和回调 | Local/OIDC Provider 共享内部身份模型 |
| 调度 | `cron-parser` | Cron 校验与下次运行时间 | 任务领取和执行仍由 Store/Scheduler 实现 |
| 日志 | `pino` | 结构化日志 | 审计另有 `AuditSink`，不能只依赖日志 |
| Web | React、React DOM、Vite | 单页应用与构建 | API 契约与页面状态集中在 Web 目录 |
| UI | Radix UI、Tailwind CSS、Lucide | 可访问组件、样式和图标 | UI 层依赖，不进入服务端契约 |
| 内容 | `react-markdown`、`remark-gfm`、`rehype-highlight` | Markdown 和代码高亮 | 展示层需继续做内容安全控制 |
| 图表 | `mermaid` | 聊天内容中的 Mermaid 图 | 动态加载，增加前端包体 |
| 测试 | Vitest、TypeScript | 单元/集成测试和类型检查 | 根脚本是当前质量门禁 |
| Checkpoint 测试 | `@langchain/langgraph-checkpoint-validation` | Saver 合同验证 | 限开发依赖 |

## 7. 核心设计原则

- 稳定入口：HTTP、CLI、Scheduler 统一调用 `AgentRuntime`。
- 权威上下文：租户、用户和角色由认证与服务端上下文提供。
- 端口隔离：模型、Store、Sandbox、Desktop、Audit 通过接口隔离实现。
- 分层恢复：Checkpoint 恢复图状态，Tool Ledger 处理副作用不确定性，Lease 处理并发所有权。
- 默认安全：危险命令硬拦截、生产变更审批、租户隔离、敏感设置加密。
- 渐进替换：Legacy/LangGraph Kernel、Memory/MySQL Store、多种 Sandbox Provider 可以按配置切换。
- 可降级：外部 MCP 单点连接失败不阻断其他 Server；MySQL 未配置可用 Memory Store 开发运行。

## 8. 源码依据

- `src/index.ts`
- `src/runtime.ts`
- `src/config/schema.ts`
- `src/server/http.ts`
- `src/agent/runtime.ts`
- `src/db/store.ts`
- `web/src/app-data.ts`
- `deploy/k8s/`
- `package.json` 与 `web/package.json`
