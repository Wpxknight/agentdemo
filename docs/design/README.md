# AIoP 设计文档

本目录是 AIoP 现行设计文档的统一入口。文档基线为 `feature/langgraph-dev` 分支在 2026-07-23 的实现；代码、数据库迁移、配置 Schema、测试和部署清单是事实依据，本文负责导航，不替代源码契约。

## 文档结构与阅读顺序

首次了解系统时建议按编号顺序阅读。只处理局部问题时，可从下表直接进入对应主题，再沿文档中的源码引用核对实现。

| 顺序 | 文档 | 主要内容 |
| --- | --- | --- |
| 1 | [系统总览](./01-system-overview.md) | 产品边界、参与者、运行形态、总体组件、请求与数据路径、技术栈全景 |
| 2 | [Agent Runtime](./02-agent-runtime.md) | Runtime 组装、Legacy/LangGraph Kernel、Run 协调、Checkpoint、恢复、取消、交互与工具账本 |
| 3 | [模型与上下文](./03-model-and-context.md) | Anthropic/OpenAI 适配、消息契约、提示词、上下文压缩、图片保留、Token 与成本统计 |
| 4 | [工具、Skill 与 MCP](./04-tools-skills-mcp.md) | 工具注册与 Broker、权限与审批、Hook、内置工具、Skill 生命周期、MCP 连接与热管理 |
| 5 | [沙箱与运维能力](./05-sandbox-and-ops.md) | Local/E2B/OpenSandbox/AIOS Provider、运行代际、Profile、预热池、桌面浏览器、文件导出、kubectl |
| 6 | [认证、安全与多租户](./06-auth-security-tenancy.md) | Local/OIDC/AIOS 登录、JWT、RBAC、租户与用户隔离、凭据、SSRF、下载与嵌入安全 |
| 7 | [数据与持久化](./07-data-and-persistence.md) | Store 契约、Memory/MySQL、0001–0014 迁移、会话、Run、Checkpoint、设置与审计数据 |
| 8 | [调度器](./08-scheduler.md) | 内嵌/独立调度模式、Cron、到期任务领取、无人值守策略、运行记录与超时 |
| 9 | [HTTP API 与 Web](./09-api-and-web.md) | Node HTTP 路由、JSON/SSE、会话与 Agent API、管理 API、React 页面和前端状态 |
| 10 | [部署与可观测性](./10-deployment-observability.md) | CLI/Server/Scheduler 进程、Kubernetes 拓扑、配置与密钥、健康检查、日志、审计和故障域 |
| 11 | [演进路线](./11-evolution-roadmap.md) | 已知限制、技术债、兼容边界及有证据支撑的后续演进方向 |

推荐的专题阅读路径：

- Agent 执行与恢复：1 → 2 → 3 → 7 → 9。
- 扩展与运维执行：1 → 4 → 5 → 6 → 10。
- 多租户 Web 服务：1 → 6 → 7 → 9 → 10。
- 定时任务：1 → 2 → 6 → 7 → 8 → 10。

## 模块与源码映射

| 设计域 | 主要实现与事实入口 | 对应文档 |
| --- | --- | --- |
| 进程入口与 Runtime 组装 | `src/index.ts`、`src/runtime.ts`、`src/config/schema.ts` | [01](./01-system-overview.md)、[02](./02-agent-runtime.md)、[10](./10-deployment-observability.md) |
| Agent Kernel 与 durable run | `src/agent/runtime.ts`、`src/agent/kernel.ts`、`src/agent/legacy-kernel.ts`、`src/agent/langgraph/kernel.ts`、`src/agent/run-coordinator.ts`、`src/agent/services/**`、`src/agent/tool-ledger/**` | [02](./02-agent-runtime.md) |
| 模型、消息与上下文 | `src/model/**`、`src/agent/context.ts`、`src/agent/services/context-service.ts`、`src/config/schema.ts` | [03](./03-model-and-context.md) |
| 工具、策略、Hook、Skill、MCP | `src/agent/tools.ts`、`src/agent/policy.ts`、`src/agent/rules.ts`、`src/agent/hooks.ts`、`src/tools/**`、`src/skill/**`、`src/mcp/**` | [04](./04-tools-skills-mcp.md) |
| 沙箱、桌面与运维工具 | `src/sandbox/**`、`src/tools/browser.ts`、`src/tools/export.ts`、`src/tools/kubectl.ts`、`deploy/opensandbox/**` | [05](./05-sandbox-and-ops.md) |
| 身份、安全与租户边界 | `src/auth/**`、`src/security/**`、`src/net/ssrf.ts`、`src/server/context.ts`、`src/config/schema.ts` | [06](./06-auth-security-tenancy.md) |
| 数据契约与数据库 | `src/db/store.ts`、`src/db/mysql.ts`、`src/db/memory.ts`、`src/db/migrations/0001_init.sql` 至 `0014_agent_run_center.sql` | [07](./07-data-and-persistence.md) |
| 定时调度 | `src/scheduler/**`、`src/index.ts`、`src/db/store.ts` | [08](./08-scheduler.md) |
| HTTP/SSE 与 Web 页面 | `src/server/http.ts`、`web/src/api.ts`、`web/src/app-data.ts`、`web/src/App.tsx`、`web/src/components/**` | [09](./09-api-and-web.md) |
| 部署、健康检查、日志与审计 | `deploy/k8s/**`、`deploy/dev-k8s/**`、`deploy/opensandbox/**`、`src/logger.ts`、`src/audit/**` | [10](./10-deployment-observability.md) |
| 限制与回归边界 | `tests/**`、上述实现文件中的兼容分支和失败路径 | [11](./11-evolution-roadmap.md) |

`src/runtime.ts` 是后端组件装配中心：它连接模型、Agent Runtime、工具注册表、策略与 Hook、Skill、MCP、沙箱控制器、下载中转、认证、审计和 Store。`src/index.ts` 暴露 CLI 单次执行、HTTP/SSE 服务、独立调度器和管理员引导四种入口。`src/server/http.ts` 是 HTTP 路由与 SSE 协议入口，`src/db/store.ts` 是业务持久化契约，`web/src/app-data.ts` 定义 Web 一级导航与页面元数据。

## 技术栈与开源组件

版本范围取自根目录和 Web 目录的 `package.json`；Node.js 内建模块、仓库自研模块与外部依赖分开记录。

### 后端运行与集成

| 类别 | 技术或组件 | 仓库版本 | 实际用途 |
| --- | --- | --- | --- |
| 运行平台 | Node.js、TypeScript、tsx | Node.js `>=20`；TypeScript `^6.0.3`；tsx `^4.22.4` | ESM 后端、类型检查、开发与直接运行 TypeScript |
| HTTP 与流式协议 | Node.js `http`、SSE | Node.js 内建 | `/healthz`、`/readyz`、认证、`/v1/**` JSON API 和 Agent 流式事件 |
| 配置校验 | Zod | `^4.4.3` | 模型、Sandbox、MCP、集群、认证、权限、Hook 等配置 Schema |
| 日志 | Pino | `^10.3.1` | 结构化运行日志 |
| Agent 编排 | LangChain Core、LangGraph | `^1.1.48`、`^1.4.8` | 模型/消息基础契约、LangGraph Kernel、Checkpoint 驱动的运行恢复 |
| 模型 SDK | Anthropic SDK、OpenAI SDK | `^0.104.2`、`^6.43.0` | Anthropic/OpenAI 协议模型适配 |
| 扩展协议 | Model Context Protocol SDK | `^1.29.0` | stdio、SSE、HTTP MCP Server 连接与工具投影 |
| 认证与令牌 | JOSE、openid-client | `^6.2.3`、`^6.8.4` | JWT/JWKS、OIDC 登录与回调 |
| 数据访问 | MySQL 2、Kysely | `^3.22.5`、`^0.29.2` | MySQL 连接、事务和类型化 SQL；无 MySQL 时可使用仓库内 MemoryStore |
| 调度 | cron-parser | `^5.5.0` | Cron 校验和下次执行时间计算，任务领取与记录由 Store 实现 |
| 沙箱 | Alibaba OpenSandbox、E2B Code Interpreter、E2B Desktop | `^0.1.9`、`^2.6.0`、`^2.3.1` | OpenSandbox/E2B/AIOS 生命周期适配、代码执行与桌面浏览器能力；另有仓库内 Local Provider |

### Web 运行栈

| 类别 | 技术或组件 | 仓库版本 | 实际用途 |
| --- | --- | --- | --- |
| UI 框架 | React、React DOM | `^19.2.0`、`^19.2.0` | 单页 Web 应用和交互状态 |
| 无障碍基础组件 | Radix UI Label、Scroll Area、Select、Separator、Slot、Tabs、Tooltip | `^2.1.8`、`^1.2.10`、`^2.2.6`、`^1.1.8`、`^1.2.4`、`^1.1.13`、`^1.2.8` | 表单、选择、标签页、提示和布局原语 |
| 样式组合 | Tailwind CSS、tailwindcss-animate、tailwind-merge、class-variance-authority、clsx | `^3.4.19`、`^1.0.7`、`^3.4.0`、`^0.7.1`、`^2.1.1` | 原子样式、动画、类名合并和组件变体 |
| 图标 | Lucide React | `^0.562.0` | Web 图标系统 |
| Markdown 与代码 | React Markdown、remark-gfm、rehype-highlight、highlight.js | `^10.1.0`、`^4.0.1`、`^7.0.2`、`^11.11.1` | 对话 Markdown、GFM 和代码高亮 |
| 图表 | Mermaid | `^11.16.0` | 对话及设计内容中的 Mermaid 图渲染 |
| 构建 | Vite、React Plugin、TypeScript、PostCSS、Autoprefixer | `^7.2.4`、`^5.1.1`、`~5.9.3`、`^8.5.6`、`^10.4.23` | Web 开发服务器、类型构建、打包和 CSS 处理 |

### 测试与部署

| 类别 | 技术或组件 | 仓库版本或入口 | 实际用途 |
| --- | --- | --- | --- |
| 单元与集成测试 | Vitest、Node.js 类型定义 | `^4.1.9`、`^25.9.3` | 后端与跨模块回归测试 |
| Checkpoint 兼容验证 | LangGraph Checkpoint Validation | `^1.1.0` | MySQL Checkpoint Saver 协议验证 |
| Web 类型定义 | `@types/node`、`@types/react`、`@types/react-dom` | `^24.10.1`、`^19.2.5`、`^19.2.3` | Web 构建期类型支持 |
| 数据库 | MySQL | `deploy/dev-k8s/mysql.yaml` 或外部实例 | 会话、用户、设置、调度、审计、Checkpoint 与 durable run 持久化 |
| 容器与编排 | Docker、Kubernetes、Nginx | `Dockerfile`、`web/Dockerfile`、`deploy/k8s/**` | 生产清单中每个 Pod 包含 Web/Nginx 8080 与 API 8081 两个容器，后端通过环境变量内嵌调度器 |
| 沙箱工作负载 | OpenSandbox 镜像与 Kubernetes 资源 | `deploy/opensandbox/**` | 浏览器、网络诊断、ServiceAccount 与运行模板 |

Web 的产品入口由 `web/src/app-data.ts` 明确为聊天、运行中心、技能、MCP、定时任务、沙箱环境、用户管理和设置；用户管理带管理员可见性限制。生产依赖与开发依赖的完整版本仍以两个 `package.json` 为准，本文用于说明它们在系统中的角色。

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
- `src/config/schema.ts` 定义 Anthropic/OpenAI 模型、三类 MCP transport、Local/E2B/OpenSandbox Provider 与 AIOS 生命周期约束、Local/OIDC/AIOS 认证、RBAC 角色、权限规则、Hook、下载和集群配置。
- `tests/**` 覆盖 Agent 行为与 Kernel parity、Run 协调和恢复、上下文、模型网关、工具策略、Skill/MCP、Sandbox、认证与 RBAC、Store/Checkpoint、调度、HTTP、下载、部署清单和 Web Run Center 等边界。

无法由上述来源确认的内容不得写成现状。设想、替代方案和未落地能力只能进入[演进路线](./11-evolution-roadmap.md)，并明确标为建议而非实现。

## 维护规则

- 影响模块职责、公共 API、持久化 Schema、配置字段、安全边界、部署拓扑或关键失败语义的代码变更，必须同步更新对应设计文档。
- 新增或移除生产依赖时，同步更新技术栈矩阵，并记录用途、封装位置、关键约束和替换影响。
- 新增数据库迁移时，更新数据设计中的迁移清单、实体关系、回滚/兼容说明，并调整本文的迁移范围。
- 新增 Web 一级页面、HTTP API、运行模式或 Sandbox Provider 时，更新本文的导航/源码映射及对应专题文档。
- 当前实现和演进建议必须分段表达；兼容代码、可选 Provider 和部署差异需注明启用条件。
- Mermaid 图应表达可由代码验证的结构或流程，并与正文使用相同组件名称。
- 文档内部使用相对链接；对外移交、评审或问题报告中的仓库文件路径使用绝对路径。
- 文档变更提交前检查相对链接、Mermaid 语法、事实引用、`git diff --check`，并搜索未完成标记和过期状态描述。
