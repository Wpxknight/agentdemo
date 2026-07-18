# 类 aiop Web 智能助手开源选型简报

> 调研日期：2026-07-18
>
> 目标：实现带 Web 对话、工具调用、MCP、任务、沙箱和企业接入能力的智能助手。
>
> 工作量为相对估算；假设可复用现有 AIOS 鉴权、模型网关和沙箱，范围是企业内 MVP，不是完整商业化版本。

## 1. 结论

推荐顺序：

1. **保留 aiop，自研控制面，按需引入开源组件**：总体风险最低。可引入 `assistant-ui`、`CopilotKit` 或 `agent-chat-ui` 加速前端，引入 Nanobot/Boclaw 的 Agent 能力时放入独立 Runner。
2. **Nanobot 二开**：最适合快速做单租户或小规模 Web Agent MVP，功能与 aiop 最接近；但项目年轻，企业多租户、RBAC、审计和强隔离需要补齐。
3. **LibreChat 二开**：最适合从成熟多用户 Web 聊天平台起步，许可证宽松、社区稳定；但运维工具、沙箱生命周期、审批审计需要自行接入。
4. **Boclaw 整体二开**：不推荐。适合复用 Agent SDK/Coding Agent 能力，不适合直接作为 Web 平台底座。

一句话建议：**已有 aiop 时不要换底座；新项目追求快选 Nanobot，重视企业 Web 能力选 LibreChat。**

## 2. 核心候选对比

GitHub 数据为 2026-07-18 快照；近 30 天提交数、贡献者数来自 GitHub API。

| 方案 | 开源热度/活跃度 | 许可证 | 与 aiop 匹配度 | 可维护性 | 企业 MVP 工作量 |
|---|---|---|---|---|---|
| **现有 aiop + 组件** | aiop 自有；组件：CopilotKit 36.1k、assistant-ui 11.1k stars | 组件均 MIT | **最高**：现有租户、RBAC、会话、MCP、任务、沙箱、审计可保留 | **高**：边界由团队掌控 | **低，约 1–2 人月** |
| **Nanobot** | 45.8k stars；近 30 天约 465 次提交；约 392 位贡献者 | MIT | **高**：已有 WebUI、工具、MCP、记忆、Cron、子代理、API | 中：核心清晰，但仅 v0.2.2/Alpha，变化很快 | **中，约 2–4 人月** |
| **LibreChat** | 40.9k stars；近 30 天约 196 次提交；约 381 位贡献者 | MIT | **中高**：多用户认证、Agent、MCP、Skills、Code Interpreter 完整 | **高**：成熟社区和清晰部署路径，但仓库较大 | **中，约 3–5 人月** |
| **AnythingLLM** | 63.5k stars；近 30 天约 162 次提交；约 215 位贡献者 | MIT | 中：Web、多用户、Agent、MCP、定时任务齐全，偏 RAG/知识库 | 中高：产品成熟，但模块和集成较多 | **中高，约 4–6 人月** |
| **Boclaw/BoBot** | 本地快照无 Git 历史，无法判断社区热度 | All Rights Reserved，需内部授权 | Agent 能力高，Web 平台匹配度低 | 中低：约 2,117 个 TS/TSX 文件、53 万行源码，CLI/Ink/本地状态耦合重 | **高，约 5–8 人月** |
| **Open WebUI** | 145.8k stars；近 30 天约 309 次提交；约 851 位贡献者 | 自定义许可证 | 技术匹配度中高，RBAC、MCP、工具、RAG、部署成熟 | 高，但升级跟随成本较高 | 技术上约 3–5 人月，**许可证先决** |
| **Dify** | 149.2k stars；近 30 天约 617 次提交；约 1,383 位贡献者 | 修改版 Apache 2.0 | 中：更偏工作流/RAG/应用开发平台 | 高，但系统重、二开面大 | **高，约 5–8 人月** |

## 3. 重点分析

### 3.1 Boclaw 是否适合开发网页端 AI 助手

**结论：适合作为 Agent Core/Runner，不适合作为整套 Web 产品底座。**

可复用部分：

- Agent Loop、模型路由、上下文压缩和失败恢复；
- 文件、Shell、Git、LSP、MCP、Skills、子代理等 Coding Agent 能力；
- `QueryEngine.submitMessage()` 异步事件流和 SDK 接口。

主要问题：

- 当前 UI 是 React + Ink 终端界面，不能直接复用为浏览器 DOM UI；
- 当前仓库明确没有浏览器前端、HTTP API、多用户会话、数据库持久化和 K8s 部署资产；
- cwd、Home、环境变量、JSONL 会话和本地工具与单用户进程耦合；
- Web 化需要新增认证、RBAC、REST/SSE、数据库、Runner 隔离、审计和部署体系；
- 许可证为“保留所有权利”，必须先确认内部二开和分发授权；
- 本地快照不是 Git 仓库，且构建脚本存在 `tsc ... || true`，升级和质量治理成本较高。

推荐接法：

```text
aiop Web/API/认证/审计
          |
          | 版本化事件与工具协议
          v
Boclaw Agent Runner（每会话独立沙箱/进程）
```

不要把完整 Boclaw 直接嵌入多租户 Web API 进程。

### 3.2 Nanobot 二开

**结论：本次候选中最适合快速二开的完整 Agent 项目。**

优点：

- MIT；已有 React/Vite/Tailwind/shadcn WebUI；
- 已有 WebSocket/REST、会话、文件预览、工具轨迹、MCP、Skills、Cron、记忆、子代理和多模型；
- Agent 核心约 1.2 万行，架构分为 Channel → Bus → Agent Loop → Runner → Tools，扩展边界较清晰；
- 测试较多，并设置 75% 覆盖率门槛；Docker 和部署文档可用；
- 活跃度非常高，中文社区和文档较完整。

风险：

- 当前 GitHub 仓库历史较短，且仍是 v0.2.2/Alpha，接口变化可能较快；
- 定位是“个人 AI Agent”，WebUI 主要用共享 token，不是完整用户/租户模型；
- 会话、配置和记忆主要在本地 Workspace/JSONL；
- 安全文档明确指出审计能力有限，Shell 隔离主要依赖 bwrap/容器；
- 45.8k stars 与约 875 个开放 Issue/PR 同时说明热度高、维护压力也高。

适用场景：内部单租户、快速验证、个人/团队 Agent。若用于企业平台，需要重做身份、租户、持久化、审计和沙箱编排。

### 3.3 其他开源方案

#### LibreChat：企业 Web 起点首选

- MIT，多用户认证支持 OAuth2、LDAP、Email；
- 已有 Agent、MCP、Skills、子代理、文件、代码解释器、Docker Compose；
- UI 和企业 Web 能力成熟，适合接 AIOS SSO；
- 缺点是运维 Policy、审批、Kubernetes 沙箱和任务审计不是核心，需要对接 aiop/AIOS 能力。

#### AnythingLLM：知识库与工作区优先

- MIT，支持多用户、Agent、MCP、定时任务、模型路由和 Developer API；
- 部署简单，RAG、文档和 Workspace 能力强；
- 更像“企业知识助手”，若目标是强工具执行和运维 Agent，改造量高于 LibreChat/Nanobot。

#### Open WebUI：功能强，但许可证不适合直接白标

- 社区、RBAC、SSO、MCP、工具、RAG、Docker/K8s 能力最成熟之一；
- 当前许可证要求保留 Open WebUI 品牌；滚动 30 天超过 50 个最终用户时，去品牌需要书面或企业授权；
- 因此可做技术参考，商业/企业白标二开前必须完成法务确认。

#### Dify：适合搭建 AI 工作流平台

- 社区最大，工作流、RAG、Agent、模型管理、可观测性完整；
- 但它是应用开发平台，不是以“实时工具执行助手”为中心；
- 自定义许可证限制未经授权的多租户服务，并限制移除前端 Logo；不建议作为 aiop 的直接 fork。

#### 前端组件路线

如果后端继续使用 aiop，可只引入 UI 层：

| 组件 | Stars | 许可证 | 用途 |
|---|---:|---|---|
| CopilotKit | 36.1k | MIT | Agent 前端、生成式 UI、AG-UI 协议 |
| assistant-ui | 11.1k | MIT | React AI Chat 组件和流式消息交互 |
| LangChain agent-chat-ui | 3.0k | MIT | 轻量 Agent Chat 页面参考，Nanobot WebUI 也借鉴了它 |

它们不能替代后端 Agent、租户、沙箱和审计，但能降低 UI 开发量，也不会迫使平台迁移到另一个大型产品。

## 4. 最终建议

| 场景 | 建议 |
|---|---|
| 继续演进当前 aiop | **aiop 控制面 + UI 组件 + 可插拔 Agent Runner** |
| 1–2 个月快速做内部 MVP | **Fork Nanobot**，先单租户，后补企业能力 |
| 从成熟多用户聊天产品起步 | **Fork LibreChat**，接 AIOS SSO 和沙箱工具服务 |
| 需要最强 Coding Agent | **Boclaw 放入独立 Runner**，不要整体 Web 化 |
| 主要做知识库/RAG 助手 | AnythingLLM 或 Dify |
| 需要白标商业产品 | 优先 MIT 项目；Open WebUI/Dify/LobeHub 先做许可证评审 |

建议做两个短 PoC 再定最终底座：

1. Nanobot 接 AIOS 登录、模型网关和一个 E2B/OpenSandbox 工具；
2. LibreChat 接同一套能力，对比会话流、MCP、权限和部署复杂度。

以 1 周 PoC 的集成代码量、侵入文件数、测试难度和升级冲突作为最终决策依据。

## 5. 主要证据

- Boclaw 本地源码：`/home/opt/develop/aicoding/boclaw/bocloud-ai-boclaw`
- Boclaw Web 差距说明：`docs/BoClaw_Web与容器化改造方案.md`
- Nanobot：https://github.com/HKUDS/nanobot
- LibreChat：https://github.com/danny-avila/LibreChat
- AnythingLLM：https://github.com/Mintplex-Labs/anything-llm
- Open WebUI：https://github.com/open-webui/open-webui
- Dify：https://github.com/langgenius/dify
- Agent UI 组件：https://github.com/CopilotKit/CopilotKit 、https://github.com/assistant-ui/assistant-ui 、https://github.com/langchain-ai/agent-chat-ui

> Stars、提交和贡献者数据会持续变化；许可证结论仅用于技术选型预警，不替代正式法务意见。
