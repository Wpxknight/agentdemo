# AIoP 设计文档

本目录是 AIoP 现行设计文档的统一入口。文档基线为 `feature/langgraph-dev` 分支在 2026-07-23 的实现；代码、数据库迁移、配置 Schema、测试和部署清单是事实依据，本文负责导航，不替代源码契约。

研发首次接触项目时，建议先阅读 [AIoP 代码走读：从启动到一次 Agent Run](../guide/code-walkthrough.md)，再按本文进入对应领域设计。

## 文档结构与阅读顺序

首次了解系统时建议按编号顺序阅读。只处理局部问题时，可从下表直接进入对应主题，再沿文档中的源码引用核对实现。

| 顺序 | 文档 | 主要内容 |
| --- | --- | --- |
| 1 | [系统总览](./01-system-overview.md) | 产品边界、参与者、运行形态、总体组件、请求与数据路径、技术栈全景 |
| 2 | [Agent Runtime](./02-agent-runtime.md) | Runtime 组装、Legacy/LangGraph Kernel、Agent Run 协调、Checkpoint、恢复、取消、交互与工具账本 |
| 3 | [模型与上下文](./03-model-and-context.md) | Anthropic/OpenAI 适配、消息契约、提示词、上下文压缩、图片保留、Token 与成本统计 |
| 4 | [工具、Skill 与 MCP](./04-tools-skills-mcp.md) | 工具注册与 Broker、权限与审批、Hook、内置工具、Skill 生命周期、MCP 连接与热管理 |
| 5 | [沙箱与运维能力](./05-sandbox-and-ops.md) | Local/E2B/OpenSandbox Provider、AIOS Lifecycle（E2B 兼容集成）、运行代际、Profile、预热池、桌面浏览器、文件导出、kubectl |
| 6 | [认证、安全与多租户](./06-auth-security-tenancy.md) | Local/OIDC/AIOS 登录、JWT、RBAC、租户与用户隔离、凭据、SSRF、下载与嵌入安全 |
| 7 | [数据与持久化](./07-data-and-persistence.md) | Store 契约、Memory/MySQL、0001–0014 迁移、会话、Agent Run、Checkpoint、设置与审计数据 |
| 8 | [调度器](./08-scheduler.md) | 内嵌/独立调度模式、Cron、到期任务领取、无人值守策略、运行记录与超时 |
| 9 | [HTTP API 与 Web](./09-api-and-web.md) | Node HTTP 路由、JSON/SSE、会话与 Agent API、管理 API、React 页面和前端状态 |
| 10 | [部署与可观测性](./10-deployment-observability.md) | CLI/Server/Scheduler 进程、Kubernetes 拓扑、配置与密钥、健康检查、日志、审计和故障域 |
| 11 | [演进路线](./11-evolution-roadmap.md) | 已知限制、技术债、兼容边界及有证据支撑的后续演进方向 |

推荐的专题阅读路径：

- Agent 执行与恢复：[01 系统总览](./01-system-overview.md) → [02 Agent Runtime](./02-agent-runtime.md) → [03 模型与上下文](./03-model-and-context.md) → [07 数据与持久化](./07-data-and-persistence.md) → [09 API 与 Web](./09-api-and-web.md)。
- 扩展与运维执行：[01 系统总览](./01-system-overview.md) → [04 工具/Skill/MCP](./04-tools-skills-mcp.md) → [05 沙箱与运维](./05-sandbox-and-ops.md) → [06 认证与安全](./06-auth-security-tenancy.md) → [10 部署与可观测性](./10-deployment-observability.md)。
- 多租户 Web 服务：[01 系统总览](./01-system-overview.md) → [06 认证与安全](./06-auth-security-tenancy.md) → [07 数据与持久化](./07-data-and-persistence.md) → [09 API 与 Web](./09-api-and-web.md) → [10 部署与可观测性](./10-deployment-observability.md)。
- 定时任务：[01 系统总览](./01-system-overview.md) → [02 Agent Runtime](./02-agent-runtime.md) → [06 认证与安全](./06-auth-security-tenancy.md) → [07 数据与持久化](./07-data-and-persistence.md) → [08 调度器](./08-scheduler.md) → [10 部署与可观测性](./10-deployment-observability.md)。

当前实现的三个重要边界：

- Agent Run Lease 提供多副本 fencing，但没有过期 running Run 的自动接管扫描器。
- Interaction 记录已持久化，但等待通知仍在进程内；跨副本解析需要粘性路由或后续通知机制。
- 模型、Sandbox Controller 和 MCP Manager 是进程级单实例，主要读取 `default` 设置；表结构中的 tenant key 不代表运行态已按 tenant 隔离。

## 模块与源码映射

| 设计域 | 主要实现与事实入口 | 对应文档 |
| --- | --- | --- |
| 进程入口与 Runtime 组装 | `src/index.ts`、`src/runtime.ts`、`src/config/schema.ts` | [01 系统总览](./01-system-overview.md)、[02 Agent Runtime](./02-agent-runtime.md)、[10 部署与可观测性](./10-deployment-observability.md) |
| Agent Kernel 与 Agent Run | `src/agent/runtime.ts`、`src/agent/kernel.ts`、`src/agent/legacy-kernel.ts`、`src/agent/langgraph/kernel.ts`、`src/agent/run-coordinator.ts`、`src/agent/services/**`、`src/agent/tool-ledger/**` | [02 Agent Runtime](./02-agent-runtime.md) |
| 模型、消息与上下文 | `src/model/**`、`src/agent/context.ts`、`src/agent/services/context-service.ts`、`src/config/schema.ts` | [03 模型与上下文](./03-model-and-context.md) |
| 工具、策略、Hook、Skill、MCP | `src/agent/tools.ts`、`src/agent/policy.ts`、`src/agent/rules.ts`、`src/agent/hooks.ts`、`src/tools/**`、`src/skill/**`、`src/mcp/**` | [04 工具/Skill/MCP](./04-tools-skills-mcp.md) |
| 沙箱、桌面与运维工具 | `src/sandbox/**`、`src/tools/browser.ts`、`src/tools/export.ts`、`src/tools/kubectl.ts`、`deploy/opensandbox/**` | [05 沙箱与运维](./05-sandbox-and-ops.md) |
| 身份、安全与租户边界 | `src/auth/**`、`src/security/**`、`src/net/ssrf.ts`、`src/server/context.ts`、`src/config/schema.ts` | [06 认证与安全](./06-auth-security-tenancy.md) |
| 数据契约与数据库 | `src/db/store.ts`、`src/db/mysql.ts`、`src/db/memory.ts`、`src/db/migrations/0001_init.sql` 至 `0014_agent_run_center.sql` | [07 数据与持久化](./07-data-and-persistence.md) |
| 定时调度 | `src/scheduler/**`、`src/index.ts`、`src/db/store.ts` | [08 调度器](./08-scheduler.md) |
| HTTP/SSE 与 Web 页面 | `src/server/http.ts`、`web/src/api.ts`、`web/src/app-data.ts`、`web/src/App.tsx`、`web/src/components/**` | [09 API 与 Web](./09-api-and-web.md) |
| 部署、健康检查、日志与审计 | `deploy/k8s/**`、`deploy/dev-k8s/**`、`deploy/opensandbox/**`、`src/logger.ts`、`src/audit/**` | [10 部署与可观测性](./10-deployment-observability.md) |
| 限制与回归边界 | `tests/**`、上述实现文件中的兼容分支和失败路径 | [11 演进路线](./11-evolution-roadmap.md) |

`src/runtime.ts` 是后端组件装配中心：它连接模型、Agent Runtime、工具注册表、策略与 Hook、Skill、MCP、沙箱控制器、下载中转、认证、审计和 Store。`src/index.ts` 暴露 CLI 单次执行、HTTP/SSE 服务、独立调度器和管理员引导四种入口。`src/server/http.ts` 是 HTTP 路由与 SSE 协议入口，`src/db/store.ts` 是业务持久化契约，`web/src/app-data.ts` 定义 Web 一级导航与页面元数据。

## 术语约定

- **Agent Runtime**：组装模型、Kernel、工具、策略、持久化和运行协调能力的顶层执行服务。
- **Agent Run**：一次具有独立 `runId`、状态、事件、租约和恢复语义的持久化执行实例，不等同于会话。
- **Kernel**：Agent Runtime 内可替换的执行内核；当前实现包括 Legacy Kernel 和 LangGraph Kernel。
- **Provider**：未加限定时指 Sandbox Provider，当前仅 `local`、`e2b`、`opensandbox`；AIOS Lifecycle 是 E2B 兼容集成，不是 Provider。
- **Store**：业务持久化接口及其隔离契约，当前实现包括 MemoryStore 和 MysqlStore，不特指某一种数据库。

## 技术栈与开源组件

依赖版本以根目录的 `package.json` 和 Web 目录的 `web/package.json` 为唯一真源，本节不复制易过期的版本范围，只记录组件、包名、用途和运行边界。Node.js 内建模块、仓库自研模块与外部依赖分开记录。

### 后端运行与集成

| 类别 | 技术、组件与包名 | 用途和运行边界 |
| --- | --- | --- |
| 运行平台 | Node.js、TypeScript（`typescript`）、tsx（`tsx`） | Node.js ESM 后端；TypeScript 负责类型检查，tsx 用于开发和直接运行 TypeScript |
| HTTP 与流式协议 | Node.js `http`、SSE | Node.js 内建能力；承载 `/healthz`、`/readyz`、认证、`/v1/**` JSON API 和 Agent 流式事件 |
| 配置校验 | Zod（`zod`） | 校验模型、Sandbox、MCP、集群、认证、权限、Hook 等配置 Schema；边界在进程启动和设置更新入口 |
| 日志 | Pino（`pino`） | 输出结构化运行日志；审计事件由仓库内 AuditSink/Store 单独持久化 |
| Agent 编排 | LangChain Core（`@langchain/core`）、LangGraph（`@langchain/langgraph`） | 提供模型/消息基础契约和 LangGraph Kernel；兼容 Legacy Kernel 仍由仓库内实现维护 |
| 模型 SDK | Anthropic SDK（`@anthropic-ai/sdk`）、OpenAI SDK（`openai`） | 适配 Anthropic/OpenAI 协议；中立消息与模型调用边界由 `src/model/**` 封装 |
| 扩展协议 | Model Context Protocol SDK（`@modelcontextprotocol/sdk`） | 连接 stdio、SSE、HTTP MCP Server 并投影工具；生命周期由 McpManager 管理 |
| 认证与令牌 | JOSE（`jose`）、OpenID Client（`openid-client`） | 处理 JWT/JWKS 和 OIDC 登录回调；授权与租户边界由仓库内 RBAC 和 RequestContext 负责 |
| 数据访问 | `mysql2`、Kysely（`kysely`） | 提供 MySQL 连接、事务和类型化 SQL；无 MySQL 时可使用仓库内 MemoryStore |
| 调度 | `cron-parser` | 校验 Cron 并计算下次执行时间；任务领取、隔离和运行记录由 Store 实现 |
| 沙箱 | Alibaba OpenSandbox（`@alibaba-group/opensandbox`）、E2B Code Interpreter（`@e2b/code-interpreter`）、E2B Desktop（`@e2b/desktop`） | 提供 OpenSandbox/E2B 代码执行和桌面能力；AIOS Lifecycle 复用 E2B Provider，另有仓库内 Local Provider |

### Web 运行栈

| 类别 | 技术、组件与包名 | 用途和运行边界 |
| --- | --- | --- |
| UI 框架 | React（`react`）、React DOM（`react-dom`） | 构建单页 Web 应用和交互状态；服务端业务状态仍以 HTTP API 和 Store 为准 |
| 无障碍基础组件 | Radix UI（`@radix-ui/react-label`、`@radix-ui/react-scroll-area`、`@radix-ui/react-select`、`@radix-ui/react-separator`、`@radix-ui/react-slot`、`@radix-ui/react-tabs`、`@radix-ui/react-tooltip`） | 提供表单、选择、标签页、提示和布局原语；业务组合由 Web 组件负责 |
| 样式组合 | `tailwindcss`、`tailwindcss-animate`、`tailwind-merge`、`class-variance-authority`、`clsx` | 提供原子样式、动画、类名合并和组件变体，不承载业务状态 |
| 图标 | Lucide React（`lucide-react`） | 提供 Web 图标系统 |
| Markdown 与代码 | React Markdown（`react-markdown`）、`remark-gfm`、`rehype-highlight`、`highlight.js` | 渲染对话 Markdown、GFM 和代码高亮；内容仍按 Web 渲染安全策略处理 |
| 图表 | Mermaid（`mermaid`） | 渲染对话及设计内容中的 Mermaid 图 |
| 构建 | Vite（`vite`）、React Plugin（`@vitejs/plugin-react`）、TypeScript（`typescript`）、PostCSS（`postcss`）、Autoprefixer（`autoprefixer`） | 提供 Web 开发服务器、类型构建、打包和 CSS 处理，仅在前端构建链路使用 |

### 测试与部署

| 类别 | 技术、组件与入口 | 用途和运行边界 |
| --- | --- | --- |
| 单元与集成测试 | Vitest（`vitest`）、Node.js 类型定义（`@types/node`） | 执行后端与跨模块回归测试；测试边界位于 `tests/**` |
| Checkpoint 兼容验证 | LangGraph Checkpoint Validation（`@langchain/langgraph-checkpoint-validation`） | 验证 MySQL Checkpoint Saver 协议，不替代业务级 Agent Run 恢复测试 |
| Web 类型定义 | `@types/node`、`@types/react`、`@types/react-dom` | 提供 Web 构建期类型支持，不进入浏览器运行包 |
| 数据库 | MySQL；`deploy/dev-k8s/mysql.yaml` 或外部实例 | 持久化会话、用户、设置、调度、审计、Checkpoint 与 Agent Run；生产环境依赖外部数据库运维边界 |
| 容器与编排 | Docker、Kubernetes、Nginx；`Dockerfile`、`web/Dockerfile`、`deploy/k8s/**` | 生产 Pod 包含 Web/Nginx 8080 与 API 8081 两个容器，后端通过环境变量内嵌调度器 |
| 沙箱工作负载 | OpenSandbox 镜像与 Kubernetes 资源；`deploy/opensandbox/**` | 提供浏览器、网络诊断、ServiceAccount 与运行模板；权限边界由模板和 Kubernetes RBAC 决定 |

Web 的产品入口由 `web/src/app-data.ts` 明确为聊天、运行中心、技能、MCP、定时任务、沙箱环境、用户管理和设置；用户管理带管理员可见性限制。生产依赖与开发依赖的组件集合和版本均以两个 `package.json` 为准，本文只说明它们在系统中的角色和边界。

## 事实来源与证据规则

设计结论按以下优先级取证：

1. 运行时行为、公共接口和安全边界：`src/**`、`web/src/**`。
2. 数据实体与兼容演进：`src/db/store.ts`、`src/db/migrations/**`。
3. 可配置范围与默认值：`src/config/schema.ts`，并结合配置加载代码核对环境变量行为。
4. 依赖与版本：`package.json`、`web/package.json`。
5. 生产拓扑和运行参数：`deploy/k8s/**`；开发、OIDC 和诊断环境差异由 `deploy/dev-k8s/**`、`deploy/opensandbox/**` 补充。
6. 已验证边界与失败语义：`tests/**`。测试可证明某个场景受保护，但不能替代实现本身。

关键事实的当前证据包括：

- `src/runtime.ts` 的 `Runtime` 接口及 `buildRuntime` 返回对象定义组件组成和释放边界。
- `src/index.ts` 定义 `serve`、`scheduler`、`seed-admin` 和 CLI 单次任务入口，以及 SIGINT/SIGTERM 关闭流程。
- `src/server/http.ts` 定义健康检查、认证、Agent/SSE、Run Center、会话、工具、Skill、MCP、沙箱、设置、审批、问题、调度、审计和管理 API。
- `src/db/store.ts` 定义租户过滤的会话、durable interaction、工具账本、Agent Run/lease、审计、调度、用户、凭据和设置契约。
- `src/config/schema.ts` 定义 Anthropic/OpenAI 模型、三类 MCP transport、三种 Sandbox Provider、仅支持 E2B 的 AIOS Lifecycle 集成约束、Local/OIDC/AIOS 认证、RBAC 角色、权限规则、Hook、下载和集群配置。
- `tests/**` 覆盖 Agent 行为与 Kernel parity、Agent Run 协调和恢复、上下文、模型网关、工具策略、Skill/MCP、Sandbox、认证与 RBAC、Store/Checkpoint、调度、HTTP、下载、部署清单和 Web Run Center 等边界。

无法由上述来源确认的内容不得写成现状。设想、替代方案和未落地能力只能进入[演进路线](./11-evolution-roadmap.md)，并明确标为建议而非实现。

## 维护规则

- 影响模块职责、公共 API、持久化 Schema、配置字段、安全边界、部署拓扑或关键失败语义的代码变更，必须同步更新对应设计文档。
- 新增、移除或升级依赖时，以 `package.json`、`web/package.json` 为版本真源同步技术栈矩阵；CI/文档校验使用 `npm pkg get engines dependencies devDependencies` 和 `npm --prefix web pkg get dependencies devDependencies` 核对组件集合，不依赖文档内复制版本范围。
- 新增数据库迁移时，更新数据设计中的迁移清单、实体关系、回滚/兼容说明，并调整本文的迁移范围。
- 新增 Web 一级页面、HTTP API、运行模式或 Sandbox Provider 时，更新本文的导航/源码映射及对应专题文档。
- 当前实现和演进建议必须分段表达；兼容代码、可选 Provider 和部署差异需注明启用条件。
- Mermaid 图应表达可由代码验证的结构或流程，并与正文使用相同组件名称。
- 文档内部使用相对链接；对外移交、评审或问题报告中的仓库文件路径使用绝对路径。
- 文档变更提交前检查相对链接、Mermaid 语法、事实引用、`git diff --check`，并搜索未完成标记和过期状态描述。
