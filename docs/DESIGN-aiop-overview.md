# aiop 总体技术设计

> 文档状态：当前实现总览
>
> 更新日期：2026-07-18
>
> 说明：本文描述当前已落地的主要架构。专题细节以对应设计文档和源码为准；规划中的多副本 Agent Runtime、Checkpoint 等能力不视为当前已实现。

## 1. 系统定位

aiop 是面向企业运维场景的 Web AI 助手平台，核心目标是让大模型在明确的身份、权限、审批、审计和沙箱边界内调用工具。

当前主要能力：

- Web 对话、SSE 流式输出、会话历史、附件和执行过程展示；
- Anthropic/OpenAI 双协议模型接入和运行时模型配置；
- Local、OIDC、AIOS 嵌入登录，租户、用户和 RBAC；
- Skills、MCP、定时任务和统一工具注册；
- E2B、OpenSandbox、Local、AIOS Lifecycle 沙箱；
- 浏览器/桌面沙箱和文件导出；
- 多集群 kubectl、Policy、审批、Hook 和审计。

## 2. 总体架构

```text
Browser
  |
  | HTTPS / SSE
  v
aiop-web（Nginx + React 静态资源）
  |
  | 同 Pod 反向代理
  v
aiop API（Node.js / TypeScript）
  |-- Auth / Tenant / RBAC
  |-- Session / Message / Settings API
  |-- Agent Core / Model Adapter
  |-- Tool Registry / Policy / Approval / Hook / Audit
  |-- Scheduler
  |
  +------ MySQL（生产）/ Memory Store（开发测试）
  +------ MCP Servers
  +------ E2B / OpenSandbox / AIOS Lifecycle
  +------ Kubernetes 集群与浏览器沙箱
```

核心原则：

1. **内部协议中立**：模型、消息、工具和流式事件使用内部统一类型，外部协议通过 Adapter 转换。
2. **身份先于工具**：请求先形成可信 `RequestContext`，租户和用户信息不接受 Prompt 或前端自报。
3. **执行与控制分离**：API 负责身份、策略、审批和审计；高风险命令在沙箱内执行。
4. **所有能力工具化**：内置工具、Skills、MCP、Sandbox、Browser、kubectl 都进入统一 `ToolRegistry`。
5. **生产状态持久化**：会话、消息、任务、设置、用户和审计进入数据库；内存实现只用于开发测试。

## 3. 开源组件

### 3.1 当前直接依赖

| 领域 | 组件 | 用途 |
|---|---|---|
| 运行时 | Node.js、TypeScript | 后端、CLI、调度器和前端统一语言栈 |
| Web | React 19、Vite、Tailwind CSS | Web 应用、构建和设计系统实现 |
| UI 基础 | Radix UI、Lucide、class-variance-authority | 可访问组件、图标和组件样式变体 |
| 内容渲染 | react-markdown、remark-gfm、highlight.js、Mermaid | Markdown、代码高亮和图表展示 |
| 模型 | `@anthropic-ai/sdk`、`openai` | Anthropic Messages 与 OpenAI Chat Completions 接入 |
| MCP | `@modelcontextprotocol/sdk` | stdio、SSE、Streamable HTTP MCP Client |
| 沙箱 | `@e2b/code-interpreter`、`@e2b/desktop` | E2B 代码和桌面沙箱 |
| 沙箱 | `@alibaba-group/opensandbox` | OpenSandbox 生命周期与执行接入 |
| 数据 | Kysely、mysql2 | 类型化数据访问和 MySQL 驱动 |
| 身份 | openid-client、jose | OIDC、JWT、JWKS 和 Token 校验 |
| 配置与日志 | Zod、Pino | 配置校验、结构化日志 |
| 调度 | cron-parser | Cron 解析和下次运行时间计算 |
| 测试 | Vitest | 后端、运行时和前端源码契约测试 |

前端组件采用基于 Radix 的本地 shadcn 风格封装，但当前没有把 shadcn CLI 或完整组件库作为运行时依赖。

### 3.2 参考但未直接集成的项目

| 项目 | 借鉴方向 | 当前状态 |
|---|---|---|
| Boclaw / BoBot | Coding Agent、上下文治理、模型能力路由、工具发现 | 仅调研和设计参考，未作为 aiop 运行依赖 |
| Nanobot | 轻量 Agent Loop、WebUI、工具与渠道分层 | 仅作为候选 Runner/二开方案调研 |
| LibreChat、Open WebUI、AnythingLLM、Dify | 多用户 Web AI 产品和部署模式 | 仅做产品与技术选型参考 |
| CopilotKit、assistant-ui、agent-chat-ui | Agent Chat 前端交互 | 当前未引入，可作为后续 UI 组件候选 |

## 4. 核心系统设计

### 4.1 Web 前端

前端位于 `web/`，由 React + Vite 构建，主要页面包括：

- 聊天、会话历史、附件、上下文与 Token 用量；
- Skills 浏览和导入；
- MCP Server 管理和工具测试；
- 定时任务及运行记录；
- 沙箱实例、模板和详情；
- 用户管理、模型和沙箱设置。

聊天页通过 SSE 接收文本、Thinking、工具调用、Todo、审批、提问、文件和运行状态事件。浏览器预览使用沙箱流或截图接口，不把模型密钥暴露给浏览器。

### 4.2 HTTP API 与 SSE

后端使用 Node.js 原生 HTTP Server，不依赖 Express/Fastify。`src/server/http.ts` 集中提供：

- 登录、OIDC 回调、AIOS Token Exchange；
- Session、Message、Context、Usage；
- Agent SSE、停止运行、问题回答和审批；
- Skills、MCP、Tools、Schedule、Sandbox、Browser；
- Settings、Users、Audit 和文件下载。

HTTP 层负责认证、输入校验和资源归属；业务能力由 `Runtime` 中的 Store、Agent、Tool、Sandbox 等组件提供。

### 4.3 身份、租户和 RBAC

认证支持三种入口：

- Local：本地用户名和密码；
- OIDC：Authorization Code + PKCE，按 Claims 映射租户和角色；
- AIOS：宿主页 Token Exchange，校验后 JIT 建号并签发 aiop JWT。

角色为 `platform_admin`、`tenant_admin`、`user`。服务端从签名 Token 构造 `RequestContext`，Store 的业务接口按 `tenantId` 强制过滤。AIOS/OIDC 用户可被本地禁用，避免外部身份再次 JIT 激活已封禁账号。

### 4.4 Agent Core 与模型层

模型层使用统一的 `ChatModel`、`Msg`、`ToolCall`、`ToolResult` 和 `StreamEvent`：

- `AnthropicModel` 适配 Anthropic Messages、Thinking 和 Tool Use；
- `OpenAIModel` 适配 OpenAI Chat Completions 和 Function Calling；
- `createModel()` 按持久化设置创建或热切换模型实例。

Agent Loop 的基本流程：

```text
用户输入
  -> 加载会话历史并执行上下文治理
  -> 模型流式推理
  -> 收集 Tool Call
  -> Policy / Approval / Hook
  -> ToolRegistry Dispatch
  -> Tool Result 回填模型
  -> 无 Tool Call 后结束并持久化消息、Usage、Audit
```

当前支持取消、重试、上下文摘要压缩、图片历史治理、Thinking、Todo、用户提问和执行时长展示。完整的多副本 Run Lease、Checkpoint 和工具边界恢复仍属于后续演进。

### 4.5 工具、Skills 与 MCP

`ToolRegistry` 汇集：

- 内置工具：Todo、Ask User、Change Plan、Web Fetch、Schedule；
- Sandbox：代码、命令和文件导出；
- Browser：打开、导航、点击、输入、截图和 URL；
- Kubernetes：统一 `kubectl(cluster, args, dryRun)`；
- Skills：读取 `SKILL.md`、导入、按所有权加载并同步到沙箱；
- MCP：运行期连接、增删、重连和动态注册工具。

工具定义在发送模型前会经过权限过滤；真正执行时再次经过 Policy、Approval 和 Hook，避免仅靠 Prompt 或 UI 隐藏控制权限。

### 4.6 Policy、审批、Hook 与审计

安全控制链：

```text
Tool Call
  -> Permission Rules（allow / deny / ask）
  -> Ops Policy（集群、命名空间、读写和危险操作分类）
  -> Interactive Approval（需要时通过 SSE 请求用户批准）
  -> PreToolUse Hook（命令或 Webhook）
  -> Dispatch
  -> Audit
```

无人值守定时任务使用独立策略；只有任务显式 `preApproved` 时才可使用预批准路径。审批当前与活动 SSE 连接和进程内状态绑定，因此多副本部署需要会话粘滞或外置审批/Run 协调存储。

### 4.7 数据与持久化

Store 提供 MySQL 和 Memory 两种实现：

- MySQL：生产和持久环境；
- Memory Store：开发和测试，重启后丢失。

主要数据包括：

- Tenant、User、角色、状态和主目录绑定；
- Session、Message、标题、上下文和 Token Usage；
- Scheduled Task、Task Run；
- Tenant LLM/Sandbox/Scheduler Settings；
- 用户下游凭据；
- Audit Event。

业务 Store API 必须接收 `RequestContext` 并执行租户过滤。敏感设置和用户凭据使用服务端 Secret Box 加密后落库。

### 4.8 Scheduler

Scheduler 周期扫描并原子领取到点任务，构造任务所属租户和用户上下文，再调用同一 Agent 与 Tool Runtime。运行结果、步骤和错误写入 Task Run。

生产部署默认把 Scheduler 嵌入 HTTP Server。数据库领取保证多个实例不会重复领取同一任务，但交互审批不适用于普通无人值守任务。

### 4.9 Sandbox 与浏览器执行面

统一 Sandbox 接口支持：

- Local：本地开发；
- E2B：托管或自建 E2B；
- OpenSandbox：Kubernetes/OpenSandbox Lifecycle；
- AIOS Lifecycle：通过 E2B 兼容 Adapter 使用 AIOS 模板目录。

Sandbox 按租户、用户、会话和 Profile 生成隔离 Key。Runtime Controller 使用 generation 管理热更新：新配置进入新 generation，旧 handle 继续完成并回收。可选 Warm Pool 降低普通沙箱启动延迟。

浏览器能力由 Desktop Provider 抽象，支持 E2B Desktop、OpenSandbox、Local Desktop 和外部命令适配。高风险执行不应落在 API 容器本机。

### 4.10 Kubernetes 运维

Cluster Registry 定义集群端点、ServiceAccount、允许命名空间、租户 ACL、只读/读写和生产标记。`kubectl` 工具在集群专用沙箱内执行，Policy 负责：

- 只读集群拒绝写操作；
- 限制命名空间和租户可见性；
- 危险命令拦截；
- 生产变更要求审批；
- 支持服务端 Dry Run；
- 记录命令、集群、结果和审批审计。

## 5. 关键数据流

### 5.1 交互式对话

```text
Browser -> POST /v1/agent
        -> JWT / RequestContext
        -> 加载 Session History
        -> Agent + Model Stream
        -> SSE 返回增量事件
        -> Tool 安全控制与沙箱执行
        -> Message / Usage / Audit 落库
```

### 5.2 AIOS 嵌入

```text
AIOS Host -> postMessage(Token)
          -> aiop Token Exchange
          -> userinfo/JWKS 校验
          -> JIT User + Credential Cache
          -> aiop JWT
          -> 后续所有请求使用 aiop RequestContext
```

### 5.3 沙箱执行

```text
Tool Call -> Sandbox Profile 选择
          -> tenant/user/session 隔离 Key
          -> 获取或创建 Sandbox Handle
          -> 注入最小必要凭据/Skill
          -> 执行并回传结果
          -> 更新活跃时间，空闲后回收
```

## 6. 部署设计

Kubernetes 生产 Pod 包含两个容器：

- `aiop-web`：Nginx，监听 8080，提供静态资源并代理 API/SSE；
- `aiop`：Node.js 后端，监听 8081，可内嵌 Scheduler。

外部 Service 只暴露 Web 容器。配置使用 ConfigMap，密钥使用 Secret；模型 Key、JWT Secret、Settings Secret、OIDC Secret 不进入前端和镜像。

生产依赖：

- MySQL；
- 可选 E2B/OpenSandbox/AIOS Lifecycle；
- 目标集群的最小权限 ServiceAccount/RBAC；
- MCP 外部服务和模型网关。

## 7. 安全与可靠性边界

- 浏览器不保存模型和沙箱密钥；
- 所有业务资源按 Tenant/User 授权；
- 工具执行前有规则、策略、审批和 Hook 多层校验；
- URL Fetch/Webhook 有 SSRF 防护；
- 文件下载使用短期能力令牌；
- 敏感设置加密存储，日志和 API 不返回完整密钥；
- 沙箱和集群凭据按用途最小注入；
- 健康检查使用 `/healthz`、`/readyz`；
- Pino 记录结构化日志，Audit Store 保存关键安全和执行事件。

当前主要限制：

- 交互审批和活动 Run 主要保存在进程内，多副本需要进一步协调；
- 尚未实现完整 Run Lease、Checkpoint 和崩溃续跑；
- 部分 Sandbox 能力依赖外部平台稳定性；
- Memory Store 不可用于生产；
- Boclaw/Nanobot 等项目尚未成为正式 Runtime 依赖。

## 8. 文档关系

- `docs/DESIGN.md`：最初的能力分层和模型/工具/Sandbox 设计；
- `docs/DESIGN-aios-integration.md`：AIOS 身份、凭据、Skill 所有权和用户生命周期；
- `docs/DESIGN-aios-e2b-integration.md`：AIOS Lifecycle、模板目录和 Runtime Generation；
- `docs/RESEARCH-open-source-ai-assistant-options.md`：开源项目与二开选型。

本文作为总体入口；出现差异时，以当前源码、数据库迁移和部署清单为准。
