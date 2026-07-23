# AIoP 设计文档

> 状态：文档体系设计已确认；后续模块文档将严格按当前代码实现编写。
>
> 基线：`feature/langgraph-dev` 分支当前实现，更新日期 2026-07-23。

## 1. 文档目标

本目录是 AIoP 当前系统设计的唯一事实来源。文档以实际代码、数据库迁移、运行配置和部署清单为依据，覆盖系统边界、模块职责、关键数据结构、运行流程、安全约束、故障处理和部署运维。

历史设计、调研、实施计划和测试记录不再作为现行设计依据；其中仍然有效的结论会合并到本目录，未落地设想只在演进路线中明确标注。

## 2. 编写原则

- 当前实现与演进方向分开描述，禁止将规划能力写成已实现能力。
- 模块边界以源码依赖、运行时组装和持久化接口为准。
- 每个大模块说明职责、关键组件、输入输出、主流程、异常路径、安全边界和测试关注点。
- 图表统一使用 Mermaid，按表达目的选择架构图、流程图、状态图、时序图或 ER 图。
- 所有技术栈和开源组件均说明版本来源、实际用途、封装位置、关键约束和替换影响。
- 文档内部使用相对链接，文档交付说明使用绝对路径。

## 3. 文档目录

| 文档 | 内容 |
| --- | --- |
| `01-system-overview.md` | 产品定位、系统边界、总体架构、运行形态、技术栈与开源组件全景 |
| `02-agent-runtime.md` | Agent Runtime、Legacy/LangGraph Kernel、Run 协调、持久恢复、交互与工具账本 |
| `03-model-and-context.md` | Anthropic/OpenAI 模型适配、提示词、上下文治理、Token 与成本统计 |
| `04-tools-skills-mcp.md` | 工具注册与执行、权限策略、Hook、Skill、MCP 和内置工具 |
| `05-sandbox-and-ops.md` | Local/E2B/OpenSandbox、AIOS 模板目录、桌面能力、文件导出和 kubectl 运维 |
| `06-auth-security-tenancy.md` | Local/OIDC/AIOS 认证、RBAC、多租户隔离、凭据和安全边界 |
| `07-data-and-persistence.md` | Store 抽象、MySQL、会话、Checkpoint、Run、审计、设置与数据关系 |
| `08-scheduler.md` | 定时任务、领取机制、无人值守策略、执行记录和失败处理 |
| `09-api-and-web.md` | HTTP/SSE API、React Web、聊天交互、管理页面和运行中心 |
| `10-deployment-observability.md` | CLI/Server/Scheduler 进程、Kubernetes 部署、配置、日志、指标和运维 |
| `11-evolution-roadmap.md` | 已知限制、技术债、兼容边界和后续演进路线 |

## 4. 图表规划

| 图表 | 所属文档 | 说明 |
| --- | --- | --- |
| 系统上下文图、总体组件架构图 | 系统总览 | 展示用户、AIOS、模型服务、MCP、沙箱、MySQL 与 AIoP 的边界 |
| Agent 请求主流程、Kernel 结构图 | Agent Runtime | 展示请求到模型、工具、Checkpoint、SSE 和会话提交的链路 |
| Run 状态图、恢复与取消时序图 | Agent Runtime | 展示 durable run、lease、interrupt、恢复和取消语义 |
| 模型调用与上下文压缩流程图 | 模型与上下文 | 展示消息转换、窗口治理、模型调用和 usage 汇总 |
| 工具决策流程图、MCP/Skill 加载时序图 | 工具、Skill 与 MCP | 展示权限、审批、Hook、Broker 和外部工具接入 |
| 沙箱生命周期状态图、工具执行时序图 | 沙箱与运维 | 展示 generation、profile、handle、回收与桌面能力 |
| 认证与授权时序图、信任边界图 | 认证与安全 | 展示 Local/OIDC/AIOS 登录和多租户授权链路 |
| ER 图、Run 持久化关系图 | 数据与持久化 | 展示迁移 0001～0014 对应的核心数据实体关系 |
| 调度任务领取与执行时序图 | 定时任务 | 展示 tick、claim、执行、记录和下次调度 |
| HTTP/SSE 聊天时序图、前端页面结构图 | API 与 Web | 展示浏览器、HTTP 服务、Agent Runtime 和存储的交互 |
| 部署拓扑图、启动与关闭流程图 | 部署与可观测性 | 展示 Kubernetes 服务、进程角色和外部依赖 |

## 5. 技术栈与开源组件记录要求

总览文档将提供完整组件矩阵，至少包括：

- 运行语言与构建：Node.js、TypeScript、tsx、Vite。
- 后端与协议：Node.js HTTP、SSE、Zod、JOSE、openid-client。
- Agent 与模型：LangChain Core、LangGraph、Anthropic SDK、OpenAI SDK。
- 数据：MySQL、mysql2、Kysely、LangGraph Checkpoint 接口。
- 扩展：Model Context Protocol SDK、Skill 文件协议及仓库内工具系统。
- 沙箱：Alibaba OpenSandbox、E2B Code Interpreter、E2B Desktop、本地 Provider。
- 调度：cron-parser 和数据库驱动的任务领取机制。
- 前端：React、Radix UI、Tailwind CSS、Lucide、React Markdown、Mermaid。
- 测试与质量：Vitest、TypeScript 类型检查、LangGraph Checkpoint Validation。
- 部署：Kubernetes 清单、容器镜像和外部 MySQL。

各模块文档还会明确组件是直接依赖、适配器后依赖还是可选 Provider，并记录关键配置、失败边界和替换成本。

## 6. 清理范围

新版模块文档完成并校验后，清理以下旧资料：

- `docs/DESIGN*.md`
- `docs/PLAN*.md`
- `docs/RESEARCH*.md`
- `docs/superpowers/`
- `docs/testing/`
- `docs/assets/` 中未被新版文档引用的素材

部署目录中的 README、源码注释、技能说明和测试代码不属于本次清理范围。

## 7. 完成标准

- 目录中的每份模块文档均有真实源码或配置依据。
- 技术栈和开源组件完整覆盖根目录及 Web 端生产依赖。
- 核心运行、恢复、安全、持久化、调度和部署链路均有对应图表。
- Mermaid 代码块可被 Mermaid CLI 或等效解析器解析。
- Markdown 内部链接不存在断链。
- 不包含未完成标记、过期实施状态或无法从仓库验证的结论。
- 清理后 `docs` 只保留现行设计文档及其确有引用的资产。
