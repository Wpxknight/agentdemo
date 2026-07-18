# 类 aiop Web 智能助手开源选型简报

> 调研日期：2026-07-18
>
> 目标：实现带 Web 对话、工具调用、MCP、任务、沙箱和企业接入能力的智能助手。
>
> 工作量为相对估算；GitHub 数据为 2026-07-18 快照。

## 1. 开源组件与可二开项目

### 1.1 推荐顺序

1. **Nanobot**：最适合快速做完整 Agent MVP。
2. **LibreChat**：最适合从成熟多用户 Web 产品起步。
3. **AnythingLLM**：适合知识库、工作区和 Agent 并重的场景。
4. **Open WebUI / Dify**：功能和社区很强，但白标、多租户存在许可证限制。
5. **CopilotKit / assistant-ui / agent-chat-ui**：只复用前端组件，不替换现有后端。

### 1.2 项目对比

| 项目 | 热度与活跃度 | 许可证 | 适合方向 | 主要风险 | 企业 MVP 工作量 |
|---|---|---|---|---|---|
| **Nanobot** | 45.8k stars；近 30 天约 465 次提交 | MIT | Web Agent、工具、MCP、Skills、Cron、记忆、子代理 | v0.2.2/Alpha；个人 Agent 定位；缺少完整多租户、RBAC 和审计 | **中，约 2–4 人月** |
| **LibreChat** | 40.9k stars；近 30 天约 196 次提交 | MIT | 多用户 AI Chat、Agent、MCP、Skills、代码解释器 | 运维策略、沙箱编排、审批审计需另建 | **中，约 3–5 人月** |
| **AnythingLLM** | 63.5k stars；近 30 天约 162 次提交 | MIT | RAG、工作区、多用户、Agent、MCP、定时任务 | 偏知识助手，强工具执行改造较多 | **中高，约 4–6 人月** |
| **Open WebUI** | 145.8k stars；近 30 天约 309 次提交 | 自定义许可证 | RBAC、SSO、MCP、工具、RAG、自托管 | 超过 50 个最终用户后去品牌需书面或企业授权 | 技术上约 3–5 人月，**许可证先决** |
| **Dify** | 149.2k stars；近 30 天约 617 次提交 | 修改版 Apache 2.0 | 工作流、RAG、Agent、模型管理、LLMOps | 未授权多租户和去 Logo 受限；系统较重 | **高，约 5–8 人月** |

### 1.3 Nanobot

Nanobot 是完整项目中最适合快速二开的候选：

- MIT，已有 React/Vite/Tailwind/shadcn WebUI；
- 已有 WebSocket/REST、会话、文件预览、工具轨迹、MCP、Skills、Cron、记忆、子代理和多模型；
- Agent 核心约 1.2 万行，Channel → Bus → Agent Loop → Runner → Tools 的边界较清晰；
- 有 Docker、部署文档、前后端测试和 75% 覆盖率门槛。

不足也比较明确：WebUI 主要使用共享 token，会话和记忆主要落本地 Workspace/JSONL；安全文档承认审计能力有限，Shell 隔离主要依赖 bwrap 或容器。它适合先做单租户或小团队 MVP，企业化需要补身份、租户、数据库、审计和沙箱编排。

### 1.4 其他完整项目

- **LibreChat**：MIT；支持 OAuth2、LDAP、Email、多用户、Agent、MCP、Skills、子代理和 Code Interpreter。企业 Web 基础最好，但需要外接运维工具和安全控制面。
- **AnythingLLM**：MIT；多用户、RAG、Workspace、Agent、MCP、定时任务和 Developer API 完整，更适合企业知识助手。
- **Open WebUI**：产品和部署成熟，支持 RBAC、SSO、MCP、工具和独立 Terminal 组件；白标前必须先解决许可证。
- **Dify**：更适合搭建 AI 工作流平台，不适合作为实时运维助手的轻量底座；多租户和前端品牌也有许可证限制。

### 1.5 前端组件路线

| 组件 | Stars | 许可证 | 用途 |
|---|---:|---|---|
| CopilotKit | 36.1k | MIT | Agent 前端、生成式 UI、AG-UI 协议 |
| assistant-ui | 11.1k | MIT | React AI Chat、流式消息和工具交互组件 |
| LangChain agent-chat-ui | 3.0k | MIT | 轻量 Agent Chat 页面参考 |

这类组件不能提供租户、Agent Runtime、沙箱和审计，但适合已有后端时降低前端开发量。

## 2. Boclaw / BoBot

### 2.1 结论

**Boclaw 适合作为 Agent Core 或隔离 Runner，不适合作为整套 Web 产品底座。**

可复用能力：

- Agent Loop、模型路由、上下文压缩和失败恢复；
- 文件、Shell、Git、LSP、MCP、Skills、子代理等 Coding Agent 能力；
- `QueryEngine.submitMessage()` 异步事件流和 SDK 接口。

主要问题：

- 当前 UI 是 React + Ink 终端界面，不能直接复用为浏览器 DOM UI；
- 当前仓库没有浏览器前端、HTTP API、多用户会话、数据库持久化和 K8s 部署资产；
- cwd、Home、环境变量、JSONL 会话和本地工具与单用户进程耦合；
- 约 2,117 个 TS/TSX 文件、53 万行源码，CLI、SDK、桌面和原生依赖共仓，改造和回归面大；
- 本地快照不是 Git 仓库，构建脚本还存在 `tsc ... || true`；
- 许可证为 All Rights Reserved，二开和分发必须先确认内部授权。

建议的使用方式：

```text
Web 平台 / 认证 / 数据 / 审计
              |
              | 版本化事件与工具协议
              v
Boclaw Agent Runner（每会话独立沙箱或进程）
```

不要把完整 Boclaw 直接嵌入共享的多租户 Web API 进程。

## 3. 功能对比

以当前 aiop 已实现能力为基准。`✅` 表示内置支持，`△` 表示部分支持或依赖外部组件，`—` 表示不是项目当前核心能力。

| aiop 当前功能基准 | aiop | Boclaw | Nanobot | LibreChat | AnythingLLM | Open WebUI | Dify |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Web 对话与流式输出 | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| 多用户、租户、RBAC、SSO | ✅ | — | △ | ✅ | ✅ | ✅ | △ |
| 会话持久化与历史管理 | ✅ | △ 本地 JSONL | △ 本地 JSONL | ✅ | ✅ | ✅ | ✅ |
| 多模型与 OpenAI/Anthropic 接入 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP 服务与工具管理 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Skills 管理与执行 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | △ 插件/工作流 |
| 定时任务 | ✅ | △ | ✅ | — | ✅ | △ | △ |
| 代码、Shell 沙箱执行 | ✅ | △ 本地执行 | △ bwrap/容器 | △ Code Interpreter | △ Agent 工具 | △ 独立 Terminal | ✅ Code Sandbox |
| 浏览器/桌面沙箱操作 | ✅ | ✅ | — | — | △ 独立组件 | △ 独立组件 | — |
| Kubernetes 多集群运维工具 | ✅ | — | — | — | — | — | — |
| Policy、审批、Hook、审计 | ✅ | △ 本地权限 | △ 限制与日志 | △ | △ | △ | △ 工作流观测 |
| 图片/附件和多模态消息 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Token、上下文与执行用量展示 | ✅ | ✅ | △ | ✅ | △ | ✅ | ✅ |

功能数量不等于选型结果。Nanobot 和 Boclaw 的 Agent 能力更强，LibreChat/Open WebUI 的通用 Web 能力更成熟；但 Kubernetes 策略、审批、审计和沙箱生命周期仍需要专门的平台控制面。

## 4. 证据与口径

- Boclaw 本地源码：`/home/opt/develop/aicoding/boclaw/bocloud-ai-boclaw`
- Nanobot：https://github.com/HKUDS/nanobot
- LibreChat：https://github.com/danny-avila/LibreChat
- AnythingLLM：https://github.com/Mintplex-Labs/anything-llm
- Open WebUI：https://github.com/open-webui/open-webui
- Dify：https://github.com/langgenius/dify
- UI 组件：https://github.com/CopilotKit/CopilotKit 、https://github.com/assistant-ui/assistant-ui 、https://github.com/langchain-ai/agent-chat-ui

Stars、提交和贡献者数据会变化；许可证结论只用于技术选型预警，不替代正式法务意见。

## 5. 结合当前 aiop 的最终建议

当前 aiop 已经具备 Web/SSE、会话持久化、Local/OIDC/AIOS 登录、租户与 RBAC、MCP、Skills、定时任务、代码和浏览器沙箱、kubectl、Policy/审批/Hook/审计、附件及用量指标。整体替换底座会重复建设这些平台能力。

因此推荐：

1. **继续以 aiop 为控制面和 Web 产品底座。**
2. 前端按需参考或引入 assistant-ui、CopilotKit、agent-chat-ui，不整体迁移大型平台。
3. 需要更强通用 Agent 时，先用 Nanobot 做独立 Runner PoC。
4. 需要最强 Coding Agent 时，把 Boclaw 放入独立 Runner，通过版本化协议接入。
5. 若必须另起新项目，快速 MVP 选 Nanobot，成熟多用户 Web 选 LibreChat。

建议用 1 周分别完成 Nanobot 和 LibreChat 的小型 PoC：接入 AIOS 登录、模型网关和一个 E2B/OpenSandbox 工具，以集成代码量、侵入文件数、测试难度和升级冲突作为最终决策依据。
