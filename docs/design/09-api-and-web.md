# HTTP API 与 Web 设计

本文描述当前 Pi-only Durable Run 的 HTTP/SSE 与 React Web 行为。

## 1. HTTP 服务

`src/server/http.ts` 使用 Node.js HTTP Server 提供静态资源、健康检查、认证回调、JSON API、文件下载和 Agent SSE。精确方法、路径和 DTO 以该文件、`web/src/api.ts` 与 HTTP tests 为准。

主要接口族：

| 分组 | 能力 |
| --- | --- |
| Auth | Local、OIDC、AIOS exchange 与当前用户 |
| Sessions | 会话、消息、上下文/用量、append、terminate |
| Agent | 创建 Durable Pi Run 与 SSE 事件 |
| Runs | 列表、详情、事件 replay、取消、恢复 |
| Interactions | approval/question/plan 查询与解析 |
| Skills/MCP/Sandbox | 产品扩展与运行设置 |
| Schedule | 任务 CRUD、Fire 与 Run 记录 |
| Admin/Settings/Audit | 多租户控制面 |

`/healthz` 用于存活探针，`/readyz` 用于就绪探针。staging 的 Web 容器把 API/SSE 反向代理到同 Pod backend。

## 2. Agent SSE 与 Durable Run

```mermaid
sequenceDiagram
  actor U as User
  participant W as Web
  participant H as HTTP
  participant R as Durable Pi Runtime
  participant D as Durable Store

  U->>W: send message
  W->>H: authenticated POST /v1/agent
  H->>R: create Run and Attempt
  R->>D: persist ordered events
  loop live events
    R-->>H: durable event
    H-->>W: SSE projection
  end
  R->>D: commit terminal state and Pi leaf
  H-->>W: done / terminated / error
```

SSE 客户端断开只会 detach 响应；HTTP handler 停止向已销毁 response 写数据，但 Durable Run、Pi Session 和事件持久化继续执行。断开本身不会请求取消，也不会触发 Agent AbortSignal。

只有显式 session terminate、Run cancel、deadline、shutdown 或 durable fencing 才进入取消/中止语义。断线客户端可通过 `GET /v1/agent/runs/{runId}/events`，结合 `Last-Event-ID` 或 `?after=<sequence>` 补发持久事件。

对应行为由 `tests/http.test.ts` 中 “detaches a closed SSE response while the durable run continues and remains replayable” 锁定。

## 3. Append、取消与恢复

- 活跃同 Worker Run 可由 Pi `steer`/`followUp` 接收 append。
- 跨 Worker append 写入 durable inbox，由当前 lease owner 领取。
- terminate/cancel 是持久状态，不依赖原 SSE 连接仍存在。
- recover 创建受 fencing 保护的新 Attempt；未知非幂等副作用仍保持 `recovery_required`。
- Interaction 解析必须匹配 tenant、actor、run、interaction 与 pending state。

## 4. Web 页面

React 应用位于 `web/src/`：

- Chat：消息、流式事件、Tool 状态、append 与 terminate；
- Runs：Attempt、Turn、Timeline、Interaction、Ledger、取消与恢复；
- Skills、MCP、Schedule、Sandbox：扩展与运维入口；
- Users、Settings：管理控制面。

Run Center 组件是 `web/src/components/run-center-page.tsx`。Markdown/Mermaid 渲染属于展示层；Tool output、终端预览和模型文本都不是审计事实。

## 5. 前端状态与安全

- 认证失败清理登录态；权限必须由服务端再次校验。
- 新 SSE 事件应允许旧前端忽略；字段变更同步更新 `web/src/types.ts`、parser 和 HTTP tests。
- 运行中心从持久化数据恢复，不能只依赖浏览器内存中的 live stream。
- API error、Tool output、MCP header、Sandbox 路径和 Credential 必须脱敏。
- 文件下载与截图使用受控 capability URL，不暴露任意文件系统路径。

## 6. 测试与源码

- HTTP/SSE：`tests/http.test.ts`、`tests/http-agent-runs.test.ts`
- DTO projection：`tests/contracts/http-projection.test.ts`
- Web source/interaction：`tests/frontend.test.ts`、`tests/web-run-center-source.test.ts`
- Server：`src/server/http.ts`、`src/server/context.ts`、`src/server/downloads.ts`
- Web：`web/src/App.tsx`、`web/src/api.ts`、`web/src/types.ts`
