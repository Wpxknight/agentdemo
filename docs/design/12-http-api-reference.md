# HTTP API Reference

> 状态：当前设计
> 验证基线：`b5425a0d2ae3ddc23ada4d3184d4a95e3a717bae`
> 最后核对：2026-08-03
> 适用范围：`pi-agent-platform-integration` 当前实现

本文是 AIoP **当前实现**的字段级 HTTP 调用参考，事实基线为 `src/server/http.ts`。它不是稳定外部 API 版本承诺；未在实现中定义的字段、状态码或错误码不得据本文推断。除特别说明外：

- Bearer API 使用 `Authorization: Bearer <bearer-token>`；认证失败返回 `401 application/json`，正文为 `{ "error": "..." }`。
- JSON 请求体默认上限 8 MB；非法 JSON 返回 `400`，超限返回 `413`。客户端建议发送 `Content-Type: application/json`，但当前 `readJson` 不检查该请求头。
- JSON 响应为 `application/json; charset=utf-8`。未捕获异常返回 `500 {"error":"内部错误"}`；未知路由返回 `404`。
- Store 查询始终携带 `tenantId/userId/role`。普通用户通常只见自己的资源；管理员的扩大范围由具体 Store/RBAC 实现决定。
- `tenant:manage` 仅 `platform_admin` 具备；`approve`、`audit:read` 为平台/租户管理员；`task:create` 三种角色均具备。完整矩阵见 `src/auth/rbac.ts`。
- 日期由 JSON 序列化为 ISO 8601 字符串。设置项的来源、环境变量和持久化规则见 [Configuration Reference](./13-configuration-reference.md)。

## 通用请求字段

Agent、append、sandbox/browser 的 `sessionId` 接受非空字符串或正安全整数；缺省时生成数字字符串。Agent 文本取 `task`、`text`、`message` 中首个字符串。`attachments` 最多取前 10 个对象；字段为 `name`、`type`、`size`、`data`，图片 `data:image/...;base64,...` 转成 image content block，其余 `data` 拼入文本。

## Health

### 存活检查

`GET /healthz`

- 认证：匿名
- 行为：同步
- 实现：`src/server/http.ts:948`
- Path / Query / Header：不适用
- Request Body：不适用
- Response：`200 application/json`，`{"ok":true}`
- 错误：实现未定义稳定业务错误契约
- 示例：`curl /healthz`

### 就绪检查

`GET /readyz`

- 认证：匿名
- 行为：同步；当前仅返回进程就绪，不探测依赖
- 实现：`src/server/http.ts:950`
- Path / Query / Header：不适用
- Request Body：不适用
- Response：`200 application/json`，`{"ok":true}`
- 错误：实现未定义稳定业务错误契约
- 示例：`curl /readyz`

## Authentication

### 本地登录

`POST /auth/login`

- 认证：匿名；仅本地认证 provider 实际可成功
- 行为：同步
- 实现：`src/server/http.ts:977`

#### Request Body

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `tenantId` | string | 否 | `default` | 租户 |
| `username` | string | 是 | — | 用户名 |
| `password` | string | 是 | — | 口令 |

#### Response / 错误

| 状态 | Content-Type | 说明 |
|---|---|---|
| 200 | application/json | `{token}` |
| 400 | application/json | 缺少 username/password |
| 401 | application/json | 用户名或口令错误 |

```bash
curl -X POST /auth/login -H 'content-type: application/json' \
  -d '{"tenantId":"default","username":"user","password":"<password>"}'
```

### AIOS token exchange

`POST /auth/aios/exchange`

- 认证：匿名入口；请求中的 AIOS token 由配置的 userinfo/JWKS 通道验证
- 行为：同步；成功后 JIT/刷新本地用户与凭据缓存并记录审计
- 实现：`src/server/http.ts:989`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `token` | string | 是 | — | AIOS access token |
| `refreshToken` | string | 否 | — | 下游刷新凭据 |
| `expiredTime` | string | 否 | — | 凭据过期时间 |

- Response：`200 {token,tenantId,userId,role,displayName}`。
- 错误：`400` 未启用或缺 token；`401` AIOS 校验/映射失败。

### 发起 OIDC 登录

`GET /auth/oidc/start`

- 认证：匿名
- 行为：同步；设置 10 分钟、HttpOnly、SameSite=Lax 的 state/PKCE 签名 cookie
- 实现：`src/server/http.ts:1019`
- Request Body：不适用
- Response：`200 {url}`，并返回 `Set-Cookie`
- 错误：`400` 未启用 OIDC；provider 错误未定义为稳定契约

### OIDC 回调

`GET /auth/callback`

- 认证：匿名；受 state cookie、PKCE 和 IdP 回调参数约束
- 行为：同步；成功清除 state cookie
- 实现：`src/server/http.ts:1032`

| 参数 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---:|---|---|
| IdP callback 参数 | query | string | 是 | 由 OIDC provider 定义 | handler 将完整 URL 交给 provider |
| `aiop_oidc` | cookie | JWT | 是 | 10 分钟有效 | 包含 state/codeVerifier |

- Response：`200 {token}`。
- 错误：`400` 未启用、缺 cookie、cookie 无效或过期；其他回调错误未定义稳定状态码。

### 当前身份

`GET /v1/me`

- 认证：Bearer
- 行为：同步
- 实现：`src/server/http.ts:1116`
- Response：`200 {tenantId,userId,role,username?,displayName?,authProvider?,homeDir}`。
- Request Body：不适用；稳定业务错误仅通用认证错误。

### 查询个人主目录绑定

`GET /v1/me/home-dir`

- 认证：Bearer，当前用户
- 行为：同步
- 实现：`src/server/http.ts:1131`
- Response：`200 {home_dir,mount_path,root}`；未绑定时 `home_dir` 为空串。
- Request Body：不适用。

### 更新个人主目录绑定

`POST /v1/me/home-dir`

- 认证：Bearer，当前用户
- 行为：同步；写用户记录并审计
- 实现：`src/server/http.ts:1140`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `home_dir` | string | 是 | — | 空串解绑；非空须为允许 root 下的规范绝对路径 |

- Response：`200 {home_dir,mount_path,root}`。
- 错误：`400` 缺字段或路径非法；`404` 用户不存在。

## Agent Runs / Run Center

### 启动 Agent run（实时 SSE）

`POST /v1/agent`

- 认证：Bearer；run 绑定当前 tenant/user/session
- 行为：实时 SSE；启动 durable Pi run
- 实现：`src/server/http.ts:1051`、`src/server/http.ts:2230`

| 参数 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---:|---|---|
| `Authorization` | header | string | 是 | Bearer | 当前身份 |
| `Content-Type` | header | string | 否 | 建议 `application/json` | 当前 handler 不校验；用于正确表达请求格式 |

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `sessionId` | string/number | 否 | 新生成 | 会话标识 |
| `task` / `text` / `message` | string | 条件必填 | — | 至少有文本或附件 |
| `attachments` | object[] | 否 | `[]` | 最多处理 10 项，见通用字段 |

Response 为 `200 text/event-stream; charset=utf-8`，并设置 `Cache-Control: no-cache, no-transform`、`Connection: keep-alive`。事件没有 `id` 字段：

| event | data 字段 | 产生条件 |
|---|---|---|
| `session` | `sessionId,runId` | 流建立后首个事件 |
| `text_delta` | `text` | message_update text delta；或成功结果未产生 delta 时补发全文 |
| `thinking_delta` | `text` | message_update thinking delta |
| `tool_call` | `call:{id,name,args}` | tool_call；无原始 input 时仅按 inputKeys 产生 `[redacted]` |
| `tool_output` | `toolId,stream:"stdout",text` | tool_execution_update 有文本 |
| `tool_result` | `toolId,name,isError` | tool_execution_end/tool_result |
| `context_compacted` | `summarizedMessages,beforeTokens,afterTokens` | session_compact 字段完整 |
| `stop` | `reason` | durable `abort` 事件投影 |
| `usage` | `inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,cost?` | assistant message_end |
| `done` | `sessionId,runId,steps,text,usage,context,cost` | succeeded 或 waiting；`usage` 内也含 `context,cost` |
| `terminated` | `sessionId,runId,reason?` | 最终状态 cancelled |
| `error` | `error,runId,status?` | failed/recovery_required 或流消费异常 |

断连语义：handler 未监听客户端断开去取消 durable run；`res` 不可写后仅停止向该连接输出，run 可继续并持久化。客户端应通过 Run Center 查询/回放；实时流自身不支持 `Last-Event-ID`。终止事件后服务端结束响应。

- 错误（建立 SSE 前）：`400` task/附件无有效内容或 JSON 非法；`401` 未认证；`409` 同一用户会话已有 queued/running/waiting run。建流后的失败作为 `error` SSE，不再改变 HTTP 状态。

### 列出 runs

`GET /v1/agent/runs`

- 认证：Bearer；普通用户仅自己的 run，管理员按 Store 授权范围
- 行为：同步
- 实现：`src/server/http.ts:1053`、`src/agent/run-center.ts:148`

| 参数 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---:|---|---|
| `status` | query | enum | 否 | queued/running/waiting/succeeded/failed/cancelled/recovery_required | 状态过滤 |
| `sessionId` | query | string | 否 | — | 会话过滤 |
| `limit` | query | integer | 否 | 1..100，默认 50 | 分页 |
| `offset` | query | integer | 否 | 0..1,000,000 | 分页 |

- Response：`200 {runs,total,limit,offset,hasMore}`。每个 run 含公开 run 字段、`leaseActive`（不暴露 leaseOwner）、`attemptSummary:{count,latest}`、`turnSummary:{count,latest}`。
- 错误：`400` 无效 status。

### Run 详情

`GET /v1/agent/runs/{runId}`

- 认证：Bearer；tenant/user scope，不可见等同不存在
- 行为：同步
- 实现匹配：`^/v1/agent/runs/([^/]+)$`；`src/agent/run-center.ts:171`
- Path：`runId` 必填，单路径段，URL decode。
- Response：`200 {run,events,interactions,tools,attempts,turns,canCancel,canResume,recoveryBlockedReason}`。interaction 不含 payload/resolution，tool 不含 args/result，run 不含 leaseOwner。
- 错误：`404` run 不存在/不可见。

### Run durable events 有限回放

`GET /v1/agent/runs/{runId}/events`

- 认证：Bearer；同 Run 详情 scope
- 行为：**有限 SSE 回放**，写完当前持久化事件立即 `end()`，不是实时订阅
- 实现匹配：`^/v1/agent/runs/([^/]+)/events$`

| 参数 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---:|---|---|
| `runId` | path | string | 是 | 单路径段 | run |
| `after` | query | integer | 否 | >=0 | 只返回 sequence 严格大于该值；优先于 header |
| `Last-Event-ID` | header | integer | 否 | >=0 | `after` 缺省时作为游标；非法值回退 0 |

Response：`200 text/event-stream; charset=utf-8`、`Cache-Control: no-cache`。每条为 `id: <sequence>`、`event: <持久化 type>`、`data: <完整公开 AgentRunEvent JSON>`。事件字段可含 `sequence,type,status,id,tenantId,runId,attemptId,turnNo,kernel,kernelVersion,correlationId,node,detail,createdAt`；实际字段由已提交事件决定，不承诺固定 type 枚举。`run/running` 事件 detail 会被收敛为仅 `leaseToken`。

- 错误：`404` run 不存在/不可见。

### 取消 run

`POST /v1/agent/runs/{runId}/cancel`

- 认证：Bearer；run scope
- 行为：同步提交 durable cancellation，并尝试中止本实例 live stream
- 实现匹配：`^/v1/agent/runs/([^/]+)/cancel$`
- Request Body：不适用（可发送空对象）
- Response：`200 {ok:true,abortedLocal}`。
- 错误：`404` 不存在/不可见；`409` 仅 queued/running/waiting 可取消。

### 恢复 run

`POST /v1/agent/runs/{runId}/resume`

- 认证：Bearer；run scope
- 行为：异步恢复；返回后 detached supervisor 消费事件与结果，并写 recovery requested/started/succeeded/failed
- 实现匹配：`^/v1/agent/runs/([^/]+)/resume$`
- Request Body：不适用
- Response：`202 {ok:true}`，不代表恢复已成功。
- 错误：`404` 不存在；`409` 非 failed/recovery_required、仍有活动 lease、不确定工具执行或 pending interaction。异步失败通过 run 状态/events 暴露，错误文本会做凭据模式脱敏。

## Sessions

### 会话列表

`GET /v1/sessions`

- 认证：Bearer；当前身份 scope
- 行为：同步
- 实现：`src/server/http.ts:1166`

| 参数 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---:|---|---|
| `limit` / `pageSize` | query | integer | 否 | 1..100，默认 50 | `limit` 优先 |
| `page` | query | integer | 否 | >=0 | >0 时 offset=(page-1)*limit |
| `offset` | query | integer | 否 | 0..1,000,000 | page 未启用时使用 |

- Response：`200 {sessions,total,limit,offset,hasMore}`；summary 字段为 `sessionId,title,lastMessage?,messageCount,updatedAt?`。

### 创建会话

`POST /v1/sessions`

- 认证：Bearer
- 行为：同步
- 实现：`src/server/http.ts:1186`
- Body：`sessionId?: string|number`，`title?: string`（默认“新会话”）。
- Response：`201 {session}`；错误未定义稳定业务契约。

### 会话消息

`GET /v1/sessions/{sessionId}/messages`

- 认证：Bearer；Store 强制身份 scope
- 行为：同步
- 实现匹配：`^/v1/sessions/([^/]+)/messages$`
- Response：`200 {messages}`；消息字段由 Store `Msg` 当前实现定义（至少含 `role,text`，可含 content blocks/tool 信息）。
- 错误：handler 未额外定义稳定 404 语义。

### 追加/引导消息

`POST /v1/sessions/{sessionId}/append`

- 认证：Bearer；session/run 必须属于当前身份
- 行为：同步入队；若有 queued/running/waiting durable run 则调用 append，否则直接写 session message
- 实现匹配：`^/v1/sessions/([^/]+)/append$`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `task` / `text` / `message` | string | 条件必填 | — | 至少文本或附件 |
| `attachments` | object[] | 否 | `[]` | 同通用规则 |
| `mode` | enum | 否 | `steer` | 仅精确 `follow_up` 时为 follow_up |
| `idempotencyKey` | string | 否 | UUID | header 未给时采用 |

Header `Idempotency-Key` 优先于 body。Response：`200 {ok:true,sessionId,queued}`。`queued=true` 表示已交给 durable append，并非已执行。

### 会话上下文占用

`GET /v1/sessions/{sessionId}/context`

- 认证：Bearer；显式校验当前用户会话
- 行为：同步
- 实现匹配：`^/v1/sessions/([^/]+)/context$`
- Response：`200 {sessionId,usedTokens,maxTokens,estimated}`；Pi session store 可用时来自已提交 SessionStats。
- 错误：`404` 会话不存在/不属于当前用户。

### 会话累计用量

`GET /v1/sessions/{sessionId}/usage`

- 认证：Bearer；显式当前用户 scope
- 行为：同步
- 实现匹配：`^/v1/sessions/([^/]+)/usage$`
- Response：`200 {sessionId,totalTokens}`。
- 错误：`404` 会话不存在/不属于当前用户。

### 终止会话运行

`POST /v1/sessions/{sessionId}/terminate`

- 认证：Bearer；只枚举当前用户会话的 run
- 行为：同步发出 cancellation；本地 abort 与 durable cancel 均执行
- 实现匹配：`^/v1/sessions/([^/]+)/terminate$`
- Response：`200 {ok:true,sessionId,aborted}`，`aborted` 仅本实例被中止的 live run 数。
- 错误：handler 未显式定义会话不存在错误；底层错误非稳定契约。

### 删除会话

`DELETE /v1/sessions/{sessionId}`

- 认证：Bearer；当前身份 scope
- 行为：同步删除；清 compaction watermark，best-effort 异步销毁会话沙箱
- 实现匹配：`^/v1/sessions/([^/]+)$`
- Request Body：不适用
- Response：`200 {ok:true}`。
- 错误：`404` 会话不存在。

## Approvals / Questions

### 待审批列表

`GET /v1/approvals`

- 认证：Bearer + `approve`
- 行为：同步
- 实现：`src/server/http.ts:1690`
- Response：`200 {approvals}`；数组元素是持久化 interaction 的原始 `payload`。
- 错误：`403` 无 approve 权限。

### 批准审批

`POST /v1/approvals/{interactionId}/approve`

- 认证：Bearer + `approve`
- 行为：同步 resolve，随后异步恢复可信绑定的 Pi run
- 实现匹配：`^/v1/approvals/([^/]+)/(approve|deny)$`
- Body：不适用；resolution 固定为 `true`。
- Response：`200 {ok:true}`。
- 错误：`404` 不存在/类型错误；`403` 无权；`409` 已过期、已处理或与既有 resolution 冲突。同值重复 resolve 幂等。

### 拒绝审批

`POST /v1/approvals/{interactionId}/deny`

- 认证、行为和匹配同 approve；resolution 固定为 `false`。
- Response：`200 {ok:true}`；错误同 approve。

可信恢复边界：服务端先读取 interaction，再使用其持久化 `sessionId/runId` resolve；客户端不能覆盖绑定。恢复 resolution 为 `{interactionId,value}`。只有新 resolve，或 run 已为 `recovery_required` 时才调度恢复。

### 待回答问题列表

`GET /v1/questions`

- 认证：Bearer；返回自己的 interaction，具 `approve` 权限者也可见当前租户 pending interaction
- 行为：同步
- 实现：`src/server/http.ts:1721`
- Response：`200 {questions}`；包含 question 与 plan 的原始 payload。

### 回答问题/计划确认

`POST /v1/questions/{interactionId}/answer`

- 认证：Bearer；所有者可处理，非所有者不能借 approve 权限处理 question/plan
- 行为：同步 resolve，随后异步恢复绑定 run
- 实现匹配：`^/v1/questions/([^/]+)/answer$`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `answers` | object | 是 | — | `{问题: [选中项字符串]}`；非数组值规范化为空数组，数组内非字符串被过滤 |

- Response：`200 {ok:true}`。
- 错误：`400` answers 形状错误；`404/403/409` 语义同 interaction resolve。

## Tools

### 工具目录

`GET /v1/tools`

- 认证：Bearer；MCP 与 Skill 均按当前 tenant/user 可见性过滤
- 行为：同步
- 实现：`src/server/http.ts:1196`
- Response：`200 {tools,groups}`。普通工具项含 `name,description,category,inputSchema`；Skill 投影含 `name,description,category,source,enabled,status,owner,visibility,canManage,files,fileEntries`。`groups` 为 category 到数量。
- 错误：实现未定义稳定业务错误契约。

### 直接调用工具

`POST /v1/tools/call`

- 认证：Bearer；策略、MCP capability/ledger、tenant identity 均生效
- 行为：同步等待工具结果
- 实现：`src/server/http.ts:1440`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `name` | string | 是 | — | 工具名 |
| `args` | JSON value | 否 | `{}` | 必须是有限 JSON 值 |
| `sessionId` | string/number | 否 | 新生成 | 工具上下文 |

- Response：普通非 MCP 工具始终由 handler 返回 `200 {ok,sessionId,result}`；`result` 为当前 ToolResult。即使 `result.isError=true`，HTTP 仍为 200，且 `ok=false`，工具错误文本位于 result，不映射为 HTTP 409。MCP 成功当前投影为 `200 {ok:true,sessionId,result:{id,content}}`。
- 错误：`400` 参数；`403` 普通/MCP policy deny；`409` 工具未启用、普通工具需审批，或 MCP outcome 为 waiting、recovery_required、MCP ToolResult error。recovery_required body 可含 `recoveryRequired,correlationId`，waiting 可含 `interactionId`。普通非 MCP ToolResult error 不属于此 HTTP 错误列表。

## MCP

MCP 身份固定为 `{tenantId,actorId:userId,roles:[role]}`。

### MCP server 列表

`GET /v1/mcp/servers`

- 认证：Bearer；tenant identity scope
- 行为：同步
- 实现：`src/server/http.ts:1388`
- Response：`200 {servers}`。每个 server 当前字段为 `name`、`transport`、`command?`、`args?`、`url?`、`status`、`error?`、`connectedAt?`、`tools`；`tools` 是加上 server namespace 后的工具名数组。`command/args/url` 可能暴露进程命令、参数或连接端点元数据，调用方须按管理面敏感信息处理。
- 错误：`409` MCP 未启用。

### 新建 MCP server

`POST /v1/mcp/servers`

- 认证：Bearer + `tenant:manage`（当前仅 platform_admin）
- 行为：同步新增并持久化当前租户配置；持久化失败仅记日志，不回滚 runtime add
- 实现：`src/server/http.ts:1394`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `name` | string | 是 | — | 字母/数字开头，后续字母/数字/`-`/`_`，且不得含 `__` |
| `config.transport` | enum | 是 | — | `stdio`/`sse`/`http`；也可将 config 字段放顶层 |
| `config.command` | string | stdio 是 | — | stdio 命令 |
| `config.args` | string[] | 否 | — | 参数 |
| `config.url` | string | sse/http 是 | — | 端点 |
| `config.headers` / `env` | object<string,string> | 否 | — | 连接配置 |
| `config.timeoutMs` | positive integer | 否 | — | 超时 |
| `config.reconnect` | object | 否 | — | `maxAttempts,backoffMs,retryOnTimeout,retryOnDisconnect` |
| `config.toolCapabilities` | object | 否 | — | 工具到 read/retryable_write/non_idempotent_write |

- Response：`201 {server}`；server 字段为 `name,transport,command?,args?,url?,status,error?,connectedAt?,tools`，并可能暴露连接元数据。
- 错误：`400` 名称/Schema/transport 必填字段；`403` 权限；`409` 未启用或重名。

### 重连 MCP server

`POST /v1/mcp/servers/{name}/reconnect`

- 认证：Bearer + `tenant:manage`
- 行为：同步
- 实现匹配：`^/v1/mcp/servers/([^/]+)/reconnect$`
- Response：`200 {server}`；server 字段为 `name,transport,command?,args?,url?,status,error?,connectedAt?,tools`，并可能暴露连接元数据。
- 错误：`404` server 不存在；`409` MCP 未启用；`403` 权限。

### 删除 MCP server

`DELETE /v1/mcp/servers/{name}`

- 认证：Bearer + `tenant:manage`
- 行为：同步删除并 best-effort 持久化
- 实现匹配：`^/v1/mcp/servers/([^/]+)$`
- Response：`200 {ok:true}`。
- 错误：`404` 不存在；`409` 未启用；`403` 权限。

## Skills

### 导入 Skill zip

`POST /v1/skills/import`

- 认证：Bearer；所有用户可上传，服务端按身份落 tenant/user 目录并设为待审核 private
- 行为：同步；受全局/租户并发许可和配额约束
- 实现：`src/server/http.ts:1227`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `filename` | string | 是 | — | 必须 `.zip` |
| `data` | string | 是 | — | 严格 base64 或 `data:*;base64,...`；解码后最大 10 MB |

- Response：`201 {product,pendingReview:true}`；product 移除内部 `id,path,description`。
- 错误：`400` 字段/base64/归档路径；`409` 目录未启用/冲突；`413` 请求/zip/配额字节；`422` zip 或 Pi Skill 校验；`429` 并发/数量配额；`507` 空间不足；其他 `500`。

### 审核 Skill

`POST /v1/skills/{name}/review`

- 认证：Bearer；tenant_admin/platform_admin；`global=true` 仅 platform_admin
- 行为：同步发布并审计
- 实现匹配：`^/v1/skills/([^/]+)/review$`
- Body：`reviewed` 必须为 `true`；`global?: boolean` 默认 false。
- Response：`200 {product}`。
- 错误：`400` reviewed；`403` 角色、自审或全局权限；`404/409/422/429/413/507/500` 按 Skill 错误映射。

### 共享 Skill

`POST /v1/skills/{name}/share`

- 认证：Bearer；仅所有者，无主存量技能可由具管理能力管理员代管
- 行为：同步 private→shared
- 实现匹配：`^/v1/skills/([^/]+)/(share|unshare)$`
- Response：`200 {skill}`。
- 错误：不可见 `404`；可见非所有者 `403`；公共技能等错误当前可能映射 `500`，不视为稳定契约。

### 取消共享 Skill

`POST /v1/skills/{name}/unshare`

- 认证/响应/错误同 share；行为 shared→private。

### 浏览 Skill 文件

`GET /v1/skills/{name}/files`

- 认证：Bearer；public/shared/自己的 private 可见，不可见返回 404
- 行为：同步
- 实现匹配：`^/v1/skills/([^/]+)/files$`
- Query `path?: string`，默认根目录。
- Response：目录为 `{path,parentPath,entries}`；若 path 不是目录则读取文件，返回 `{path,parentPath,entry,content}`。
- 错误：`404` 不可见/不存在；`400` 非法路径、非目录且不可读；其他按 Skill 映射。

### 启用 Skill

`POST /v1/skills/{name}/enable`

- 认证：Bearer；仅可管理者
- 行为：同步
- 实现匹配：`^/v1/skills/([^/]+)/(enable|disable)$`
- Response：`200 {skill}`；错误为 `403/404` 或 Skill 映射错误。

### 禁用 Skill

`POST /v1/skills/{name}/disable`

- 认证/响应/错误同 enable；行为设 `enabled=false`。

### 删除 Skill

`DELETE /v1/skills/{name}`

- 认证：Bearer；仅可管理者
- 行为：同步删除并审计
- 实现匹配：`^/v1/skills/([^/]+)$`
- Body：`confirm` 必须为 `true`。
- Response：`200 {ok:true}`。
- 错误：`400` 未确认；`403/404` 管理/可见性；其他 Skill 映射。

## Sandbox / Browser

本组调用复用“直接调用工具”的返回契约：普通非 MCP ToolResult 即使 `isError=true` 仍返回 HTTP `200`、body `ok=false`；只有 handler 显式映射的参数、策略、未启用、审批/MCP waiting/recovery 等条件使用 4xx。

### Sandbox 列表

`GET /v1/sandboxes`

- 认证：Bearer；runtime 以当前身份过滤
- 行为：同步
- 实现：`src/server/http.ts:1450`
- Response：`200 {sandboxes,profiles}`；具体项由所选 sandbox runtime/profile 配置定义。

### 运行代码

`POST /v1/sandbox/run-code`

- 认证：Bearer；直接工具策略生效
- 行为：同步等待工具
- 实现：`src/server/http.ts:1458`
- Body：`code:string` 必填；`language?:string`；`profile` 或 `sandboxProfile` 可选；`sessionId` 可选。
- Response/错误：同直接工具调用。指定 profile 调 `sandbox_run_code`，否则 `sbx__run_code`；缺 code 为 `400`。

### 运行命令

`POST /v1/sandbox/run-command`

- 认证：Bearer；直接工具策略生效
- 行为：同步等待工具
- 实现：`src/server/http.ts:1477`
- Body：`command:string` 必填；`profile`/`sandboxProfile`、`sessionId` 可选。
- Response/错误：同直接工具；指定 profile 调 `sandbox_run_command`，否则 `sbx__run_command`。

### Browser 预览页

`GET /v1/browser/stream-view`

- 认证：匿名 HTML 外壳；页面自身从 localStorage 读取 `aiop_token`，以 Bearer 每 2 秒调用 screenshot
- 行为：同步 HTML
- 实现：`src/server/http.ts:951`、`src/server/http.ts:646`
- Query `sessionId?: string`，默认 `default`。
- Response：`200 text/html; charset=utf-8`。此 URL 本身不提供浏览器图像流。
- 错误：实现未定义稳定业务错误契约。

### 获取 Browser stream 地址

`POST /v1/browser/stream`

- 认证：Bearer
- 行为：同步调用 `desktop_stream_url`
- 实现：`src/server/http.ts:1494`
- Body：`sessionId?: string|number`。
- Response：`200` 直接工具 payload；若工具 content 含 `data:text/html`，服务端替换为 `/v1/browser/stream-view?sessionId=...` 文本。
- 错误：同直接工具。

### Browser 导航

`POST /v1/browser/navigate`

- 认证：Bearer；同步调用 `browser_navigate`
- 实现：`src/server/http.ts:1509`
- Body：`url:string` 必填，`sessionId` 可选。
- Response/错误：同直接工具；缺 url 为 `400`。

### Browser 点击

`POST /v1/browser/click`

- 认证：Bearer；同步调用 `browser_click`
- 实现：`src/server/http.ts:1517`
- Body：`x:number,y:number` 必填且有限，`sessionId` 可选。
- Response/错误：同直接工具；非法坐标 `400`。

### Browser 输入

`POST /v1/browser/type`

- 认证：Bearer；同步调用 `browser_type`
- 实现：`src/server/http.ts:1526`
- Body：`text:string` 必填（空串允许），`sessionId` 可选。
- Response/错误：同直接工具；缺字段 `400`。

### Browser 截图

`POST /v1/browser/screenshot`

- 认证：Bearer；同步调用 `browser_screenshot`
- 实现：`src/server/http.ts:1534`
- Body：`sessionId?: string|number`。
- Response：工具 payload；截图通常在 `result.contentBlocks` 的 `{type:"image",mimeType,data}`，确切 ToolResult 由 runtime 定义。
- 错误：同直接工具。

### Browser 当前 URL

`POST /v1/browser/url`

- 认证：Bearer；同步调用 `browser_current_url`
- 实现：`src/server/http.ts:1540`
- Body：`sessionId?: string|number`。
- Response/错误：同直接工具。

## LLM / Sandbox / Scheduler Settings

所有设置接口字段含义和配置优先级见 [Configuration Reference](./13-configuration-reference.md)。

### 查询 LLM 设置

`GET /v1/settings/llm`

- 认证：Bearer + `tenant:manage`
- 行为：同步
- 实现：`src/server/http.ts:1547`
- Response：`200 {config,options?}`。config 为 `id,protocol,base_url,model,api_key,api_key_set,api_key_preview,allow_insecure_tls,context_window_tokens,context_keep_images,effort?`。注意：当前实现 **会返回完整 `api_key`**；调用方必须按敏感数据处理。
- 错误：`403` 权限。

### 更新 LLM 设置

`POST /v1/settings/llm`

- 认证：Bearer + `tenant:manage`
- 行为：同步持久化并热更新模型
- 实现：`src/server/http.ts:1553`
- Body：可用 `id/model_id` 选 option；或 `protocol` (`anthropic|openai`)、`base_url/baseURL`、`api_key/apiKey`、`model`、`allow_insecure_tls/allowInsecureTls` boolean、`context_window_tokens/contextWindowTokens` 正整数、`context_keep_images/contextKeepImages` >=0、`effort`。未知 effort 当前静默保留旧值。`allow_insecure_tls=true` 仅用于可信内网的自签名/不受信任证书 HTTPS LLM。
- Response：`200 {config,options?}`。
- 错误：`400` 未知模型、protocol、必填连接字段、token 配置；`403` 权限。

### 测试 LLM 设置

`POST /v1/settings/llm/test`

- 认证：Bearer + `tenant:manage`
- 行为：同步流式调用模型，要求其回复 OK；非空 body 仅测试候选配置，不持久化
- 实现：`src/server/http.ts:1566`
- Body：空对象使用当前模型；非空字段同更新接口。
- Response：`200 {ok:true,text,config,options?}`。
- 错误：`400/403` 同上；模型调用失败 `502`，错误消息来自 provider，未定义稳定错误码。

### 查询 Sandbox Runtime 设置

`GET /v1/settings/sandbox`

- 认证：Bearer + `tenant:manage`
- 行为：同步；scope 固定 `platform`
- 实现：`src/server/http.ts:1591`
- Response：`200 {scope:"platform",settings,runtime?}`。settings 公共字段为 `enabled,mode,api_key_set`，按 mode 增加：standard_e2b `domain?`；aios_lifecycle `lifecycle_url,placement:{cluster_id,namespace}`；opensandbox `domain?,protocol,default_image?`；local 无 key。runtime 可含 `enabled,mode,status,template_count,last_successful_refresh_at`。

### 更新 Sandbox Runtime 设置

`POST /v1/settings/sandbox`

- 认证：Bearer + `tenant:manage`
- 行为：同步应用平台全局 runtime 并写 sandbox audit
- 实现：`src/server/http.ts:1607`

公共 body：`enabled:boolean`、`mode` 必填（`standard_e2b|aios_lifecycle|opensandbox|local`）、`api_key?:string`、`clear_api_key?:boolean`。mode 专属：standard_e2b `domain?`；aios_lifecycle `lifecycle_url`、`placement:{cluster_id,namespace}`；opensandbox `domain?`,`protocol?`,`default_image?`。传入当前 mode 不支持字段会 `400`；api_key 与 clear 互斥，local 禁止 key；启用 standard_e2b/aios_lifecycle 时清 key 被拒。

- Response：同查询。
- 错误：`400` Schema/凭据目标；`403`；`503` runtime 不支持动态设置；应用失败通常 `500`。

### 刷新 Sandbox 模板

`POST /v1/settings/sandbox/refresh-templates`

- 认证：Bearer + `tenant:manage` 且角色必须 `platform_admin`
- 行为：同步刷新 AIOS Lifecycle 模板目录并审计
- 实现：`src/server/http.ts:1633`
- Body：不适用。
- Response：`200` sandbox settings body 加 `refresh:{changed,template_count}`。
- 错误：`403`；`409` 当前非已启用 aios_lifecycle；`503` 不支持刷新；`502` 上游刷新失败。

### 查询 Scheduler 设置

`GET /v1/settings/scheduler`

- 认证：Bearer + `tenant:manage`
- 行为：同步
- 实现：`src/server/http.ts:1670`
- Response：`200 {settings:{max_run_minutes}}`。

### 更新 Scheduler 设置

`POST /v1/settings/scheduler`

- 认证：Bearer + `tenant:manage`
- 行为：同步
- 实现：`src/server/http.ts:1678`
- Body：`max_run_minutes` 或 `maxRunMinutes`，>=1，向下取整。
- Response：`200 {settings:{max_run_minutes}}`。
- 错误：`400` 数值无效；`403` 权限。

## Scheduled Tasks

ScheduledTask 字段：`id,tenantId,userId,sessionId,cron,title,task,preApproved,enabled,nextRunAt,lastRunAt?`。

### 任务列表

`GET /v1/schedule`

- 认证：Bearer；当前身份 scope
- 行为：同步
- 实现：`src/server/http.ts:1849`
- Response：`200 {tasks}`。

### 创建任务

`POST /v1/schedule`

- 认证：Bearer + `task:create`；`preApproved=true` 另需 `approve`
- 行为：同步创建
- 实现：`src/server/http.ts:1853`
- Body：`sessionId?`、`cron:string` 必填、`task:string` 必填、`title?:string` 默认空、`preApproved?:boolean` 默认 false、`enabled?:boolean` 默认 true。handler 仅检查 cron 非空；cron 细验可能由 Store 负责，未定义稳定错误状态。
- Response：`201 {task}`。
- 错误：`400` cron/task 缺失；`403` preApproved 权限。

### 任务执行记录

`GET /v1/schedule/{taskId}/runs`

- 认证：Bearer；Store scope
- 行为：同步
- 实现匹配：`^/v1/schedule/(\d+)/runs$`
- Path `taskId` 为十进制数字。
- Response：`200 {runs}`；TaskRun 字段 `id?,taskId,status:"success"|"error",detail?,steps?,createdAt?`。
- 错误：handler 未定义稳定 404。

### 启用任务

`POST /v1/schedule/{taskId}/enable`

- 认证：Bearer + `task:create`
- 行为：同步
- 实现匹配：`^/v1/schedule/(\d+)/(enable|disable)$`
- Response：`200 {ok:true}`；不存在或无权访问的任务返回 `404`。

### 禁用任务

`POST /v1/schedule/{taskId}/disable`

- 认证/响应同 enable；行为设 enabled=false。

### 更新任务

`PATCH /v1/schedule/{taskId}`

- 认证：Bearer + `task:create`；把 preApproved 改为 true 另需 `approve`
- 行为：同步
- 实现匹配：`^/v1/schedule/(\d+)$`
- Body 可含 `cron`（须通过 `isValidCron`）、`title`、`task`（非空）、`preApproved:boolean`、`enabled:boolean`；至少一项。
- Response：`200 {task}`。
- 错误：`400` 字段/cron/空 patch；`403`；`404` 不存在。

### 删除任务

`DELETE /v1/schedule/{taskId}`

- 认证：Bearer + `task:create`
- 行为：同步软删除；停止后续调度，但保留已存在的 Fire 与 Run 历史，且不取消已绑定 Run。
- 实现匹配：`^/v1/schedule/(\d+)$`
- Response：`200 {ok:true}`。
- 错误：`404` 不存在；`403` 权限。

### 立即执行任务

`POST /v1/schedule/{taskId}/run`

- 认证：Bearer + `task:create`；请求头必须带不超过 128 字符的 `Idempotency-Key`
- 行为：异步；先持久化 `triggerKind=manual` 的 Fire，再由 Scheduler 领取、绑定并执行 Durable Run。新 Fire 会 best-effort 唤醒本机内嵌 Worker；客户端可轮询 runs。
- 实现匹配：`^/v1/schedule/(\d+)/run$`
- Response：`202 {ok:true,taskId,fireId,runId,state,replayed}`，仅表示 Fire 已持久化，不代表执行成功。相同幂等键返回相同 Fire/Run 且 `replayed=true`。
- 错误：`400` 缺少或过长的 `Idempotency-Key`；`404` 不存在；`403` 权限。

## Audit

### 查询审计

`GET /v1/audit`

- 认证：Bearer + `audit:read`；tenant scope 强制
- 行为：同步
- 实现：`src/server/http.ts:1941`

| 参数 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---:|---|---|
| `sessionId` | query | string | 否 | — | 会话过滤 |
| `kind` | query | string | 否 | — | 类型过滤 |
| `limit` | query | number | 否 | 默认 100 | handler 不做上下界收敛；非有限数回退 100 |

- Response：`200 {events}`；事件字段由 Audit Store 当前记录定义。
- 错误：`403` 权限；无公开稳定分页错误契约。

## Tenant / User Administration

### 租户列表

`GET /v1/admin/tenants`

- 认证：Bearer + `tenant:manage`（platform_admin）
- 行为：同步
- 实现：`src/server/http.ts:1954`、`src/auth/admin.ts:20`
- Response：`200 {tenants}`，tenant 为 `{id,name}`。
- 错误：`403` 权限。

### 创建租户

`POST /v1/admin/tenants`

- 认证：Bearer + `tenant:manage`
- 行为：同步
- 实现：`src/server/http.ts:1958`
- Body：`id:string` 必填；`name?:string` 默认 id。
- Response：`201 {ok:true}`。
- 错误：`400` 缺 id；`403`；底层冲突未映射为稳定 HTTP 契约。

### 创建本地用户

`POST /v1/admin/users`

- 认证：Bearer；platform_admin 可任意租户，tenant_admin 仅本租户；tenant_admin 不能创建 platform_admin
- 行为：同步创建、可更新 displayName、审计
- 实现：`src/server/http.ts:1966`、`src/auth/admin.ts:25`
- Body：`tenantId?:string` 默认当前租户，`username:string`、`password:string` 必填，`role?:string` 默认 `user`，`displayName?:string`。期望角色值为 `user`、`tenant_admin`、`platform_admin`，但当前 handler 仅做 TypeScript cast，**没有运行时 enum 校验**；调用方不得依赖服务端拒绝未知值。
- Response：`201 {user}`；User 字段 `id,tenantId,username,role,status,authProvider,displayName?,homeDir?,createdAt?`。
- 错误：`400` OIDC provider 或缺字段；`403` 管理范围/角色；`409` 同名 active/disabled 用户已存在。

### 用户列表

`GET /v1/admin/users`

- 认证：Bearer；platform_admin 任意租户，tenant_admin 本租户，普通用户无权
- 行为：同步
- 实现：`src/server/http.ts:1993`
- Query `tenantId?: string`，默认当前租户。
- Response：`200 {users}`。
- 错误：`403` 管理范围。

### 禁用用户

`POST /v1/admin/users/{userId}/disable`

- 认证：Bearer；管理范围规则；不能操作自己；tenant_admin 不能操作管理员
- 行为：同步禁用、清凭据、审计，并立即失效本进程用户状态缓存
- 实现匹配：`^/v1/admin/users/([^/]+)/(disable|enable)$`
- Query `tenantId?:string` 默认当前租户。
- Response：`200 {user}`。
- 错误：`404` 用户不存在；`403` 范围/目标护栏。

### 启用用户

`POST /v1/admin/users/{userId}/enable`

- 认证和目标护栏同 disable；行为恢复 active，不恢复已清凭据。
- Response：`200 {user}`；错误同 disable。

### 软删除用户

`DELETE /v1/admin/users/{userId}`

- 认证：Bearer；目标护栏同 disable
- 行为：同步软删除：禁用、清凭据、暂停其定时任务、审计；不硬删关联数据
- 实现匹配：`^/v1/admin/users/([^/]+)$`

| 参数 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---:|---|---|
| `tenantId` | query | string | 否 | 管理范围内 | 默认当前租户 |
| `tombstone` | query | string | 否 | 仅精确 `true` 生效 | true 时重命名释放 username；默认保留 username 防 JIT 复活 |

- Response：`200 {user}`。
- 错误：`404` 不存在；`403` 自己/范围/管理员目标护栏。

## Signed Downloads

### 下载 capability URL

`GET /v1/files/{token}`

- 认证：匿名，不需要 Bearer；**token 本身就是能力凭据**
- 行为：流式文件响应
- 实现匹配：`^/v1/files/([^/]+)$`；`src/server/downloads.ts`

| 参数 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---:|---|---|
| `token` | path | signed JWT string | 是 | 单路径段、签名有效、未过期、fid 合法且文件存在 | URL decode 后验证 |

- Response：`200`；`Content-Type` 为签发元数据 mime（缺省 octet-stream），`Content-Length` 为文件大小，`Cache-Control: private, no-store`。image/audio/video 使用 `Content-Disposition: inline`，其他使用 `attachment`；同时提供 ASCII `filename` 和 RFC 5987 `filename*`。
- 错误：`404` 下载功能未启用，或 token 无效/签名错误/过期/文件不存在；这些条件故意不区分。
- 安全边界：URL 可被任何持有者使用，应像短期 secret 一样避免日志、Referer、聊天转发泄露；默认签发有效期当前为 24 小时，但可配置，调用方不得依赖该默认值。签名 secret 从不出现在响应或本文示例中。

```bash
curl '/v1/files/<signed-download-token>' -o download.bin
```

## 路由实现映射说明

动态路由文档参数与源码匹配规则：

| 文档参数 | 源码规则 |
|---|---|
| `{runId}`、`{sessionId}`、`{interactionId}`、`{name}`、`{userId}`、`{token}` | `([^/]+)`，随后按需要 `decodeURIComponent` |
| `{taskId}` | `(\d+)`，转为 Number |
| 动作路径 | `(approve|deny)`、`(share|unshare)`、`(enable|disable)` 展开为独立方法+路径 |

静态 SPA `/`、`/index.html`、`/login`、`/assets/*`、`/favicon.ico` 是 Web 资产分发，不计入 HTTP API Reference 路由清单。所有其他未匹配路径返回 `404 {error:"未知路由: METHOD /path"}`。
