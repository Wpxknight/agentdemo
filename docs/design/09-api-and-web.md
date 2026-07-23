# HTTP API 与 Web 设计

## 1. HTTP 服务

`src/server/http.ts` 使用 Node.js HTTP Server 实现静态资源、健康检查、认证回调、JSON API、文件下载和 Agent SSE。没有引入 Express/Fastify 路由层。

~~~mermaid
flowchart TB
  Browser[React Web]
  HTTP[Node HTTP Server]
  Auth[Auth Context]
  API[JSON API Handlers]
  SSE[Agent SSE Handler]
  Runtime[Runtime Services]
  Static[Web dist]
  Download[Download Store]

  Browser --> HTTP
  HTTP --> Static
  HTTP --> Auth
  Auth --> API
  Auth --> SSE
  API --> Runtime
  SSE --> Runtime
  HTTP --> Download
~~~

`/healthz` 用于存活探针，`/readyz` 用于就绪探针。Web 资产由 Server 返回或由部署中的 Web 容器反向代理。

## 2. API 分组

主要接口族：

| 分组 | 能力 |
| --- | --- |
| Auth | Local 登录、OIDC 登录与 callback、AIOS exchange、当前用户 |
| Sessions | 创建、列表、消息、上下文/用量、追加、终止、删除 |
| Agent | SSE 执行、pending interaction、approval/question/plan 解析 |
| Runs | 运行中心列表、详情、事件、取消、恢复 |
| Skills | 列表、文件树、导入、启停、共享、删除 |
| MCP | Server 列表、新增、删除、重连、工具测试 |
| Schedule | 任务 CRUD、启停、立即运行、运行记录 |
| Sandbox | 实例、Profile、截图、会话回收、模板刷新 |
| Settings | LLM、Scheduler、Sandbox、MCP 等租户/平台设置 |
| Admin | 用户、租户、状态和生命周期 |
| Files | 短期能力 URL 下载 |
| Audit/Tools | 审计查询和当前工具信息 |

精确方法、路径和响应体以 `src/server/http.ts` 与 `web/src/api.ts` 为事实源。

## 3. Agent SSE 时序

~~~mermaid
sequenceDiagram
  actor U as User
  participant W as Web
  participant H as HTTP
  participant S as Store
  participant A as Agent Runtime
  participant M as Model and Tools

  U->>W: send message
  W->>H: authenticated POST
  H->>S: create or touch session and load history
  H->>A: run with AbortSignal
  A->>M: stream execution
  loop events
    M-->>A: neutral event
    A-->>H: StreamEvent
    H-->>W: SSE event
  end
  alt success
    A-->>H: result
    H->>S: commit success and usage
  else failure or terminate
    H->>S: commit partial output and reason
    H-->>W: error or stop event
  end
~~~

客户端断开、终止接口或 Agent Run 取消会触发 AbortSignal。SSE 已经发送不代表最终消息已持久化，前端需等待终止事件或重新读取会话。

## 4. Web 页面结构

React 应用的一级页面：

- Chat：会话历史、Markdown 消息、工具状态、Sandbox 终端和浏览器预览。
- Runs：Agent Run 筛选、详情、节点时间线、Interaction、Tool Ledger、取消与恢复。
- Skills：Skill 列表、文件树、导入和共享管理。
- MCP：连接状态、Server CRUD、重连和工具测试。
- Schedule：任务与运行记录。
- Sandbox：运行实例和模板/Profile。
- Users：管理员用户生命周期。
- Settings：LLM、Scheduler、Sandbox 和用户目录等设置。

~~~mermaid
flowchart LR
  App[App]
  Nav[Sidebar Navigation]
  Chat[Chat Workspace]
  Runs[Run Center]
  Ext[Skills and MCP]
  Ops[Schedule and Sandbox]
  Admin[Users and Settings]

  App --> Nav
  Nav --> Chat
  Nav --> Runs
  Nav --> Ext
  Nav --> Ops
  Nav --> Admin
~~~

当前 `App.tsx` 集中了多数页面和状态，是现状而非推荐的长期模块边界；运行中心已拆为独立组件。

## 5. Markdown、Mermaid 与终端

`react-markdown`、`remark-gfm` 和 `rehype-highlight` 渲染模型输出。Mermaid 由独立组件按需解析和渲染，失败时应展示可读的源文本或错误，而不是破坏整条消息。

Sandbox 输出按 stdout、stderr、命令和结果解析；终端预览来自 tool_output SSE，不应被当作审计事实。

浏览器截图和文件下载使用受控 API，不直接暴露 Sandbox 内任意路径。

## 6. 前端状态与错误

- Token 用于认证请求，401 清除登录态。
- 页面数据按导航按需加载。
- SSE 状态包括流式文本、思考、工具调用、重试回滚、用量、Todo 和下载。
- 运行中心数据来自持久表，因此刷新后仍可查看。
- 确认对话框用于删除、清密钥等显式破坏操作。
- 后端错误信息需要脱敏；前端不展示密钥或 MCP header。

## 7. 契约与兼容

后端以中立事件和 JSON shape 为契约。新增事件应保持旧前端可忽略；修改字段需同时更新 `web/src/types.ts`、解析逻辑和 HTTP 测试。

管理 API 的授权必须在服务端执行，隐藏按钮只改善体验，不是安全控制。

## 8. 测试重点与源码依据

- HTTP 鉴权、租户隔离、路由方法和状态码。
- SSE 事件顺序、断开、终止、模型重试回滚和失败提交。
- Run 取消/恢复、Interaction 解析。
- Web build、类型、关键页面状态和 Mermaid 错误回退。
- 下载能力、截图和敏感字段隐藏。

源码：

- `src/server/http.ts`
- `src/server/context.ts`
- `src/server/downloads.ts`
- `web/src/App.tsx`
- `web/src/api.ts`
- `web/src/types.ts`
- `web/src/components/run-center-page.tsx`
- `web/src/components/mermaid-diagram.tsx`
