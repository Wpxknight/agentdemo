# 认证、安全与多租户设计

## 1. 安全目标

AIoP 的安全控制面必须保证：

- 身份由服务端验证并映射为 tenant、user、role。
- 所有业务数据按租户，用户私有数据进一步按 user 隔离。
- 模型和工具参数不能提升权限。
- 平台设置、用户下游凭据和下载能力不会以明文公开。
- 外部 URL、Webhook、文件路径和 iframe 嵌入受边界控制。
- 高风险运维动作经过 RBAC、Policy、审批和审计。

## 2. 认证方式

~~~mermaid
flowchart LR
  Browser[Browser or AIOS Host]
  HTTP[HTTP Server]
  Local[Local Auth]
  OIDC[OIDC Provider]
  AIOS[AIOS Token Verification]
  Users[(users)]
  Creds[(user_credentials)]
  JWT[AIoP JWT]

  Browser --> HTTP
  HTTP --> Local
  HTTP --> OIDC
  HTTP --> AIOS
  Local --> Users
  OIDC --> Users
  AIOS --> Users
  AIOS --> Creds
  Local --> JWT
  OIDC --> JWT
  AIOS --> JWT
~~~

### 2.1 Local Auth

用户名和密码按 tenant 查询。密码使用 `scrypt` 派生并带随机 salt。禁用或软删除用户不能登录。`seed-admin` 仅在 Local Provider 下由运维人员执行。

### 2.2 OIDC

`openid-client` 处理授权码流程，`jose` 用于 Token/JWT。OIDC claims 经可配置字段映射到 tenant、username 和 role；不存在的用户可 JIT 创建。state/nonce 和回调必须绑定当前登录流程。

### 2.3 AIOS 嵌入认证

AIOS 支持 userinfo 或 JWKS 验证，使用固定系统 id、允许的父页面 origin 和字段映射。验证后的用户可 JIT 创建；交换得到的下游凭据按用户加密存储并设置 TTL，用于 Skill/Sandbox 内的受控请求。

## 3. 请求上下文与授权

`RequestContext` 包含 tenantId、userId、role。HTTP 层从已验证 Token 构建上下文；客户端提交的 tenant/user 字段不能覆盖它。

角色权限：

| 权限 | platform_admin | tenant_admin | user |
| --- | --- | --- | --- |
| 管理租户 | 是 | 否 | 否 |
| 管理任意租户用户 | 是 | 否 | 否 |
| 管理本租户用户 | 是 | 是 | 否 |
| 集群写操作 | 是 | 是 | 否 |
| 审批 | 是 | 是 | 否 |
| 创建定时任务 | 是 | 是 | 是 |
| 查看审计 | 是 | 是 | 否 |

`requirePermission` 用于 API 动作，`canManageUsersOf` 防止租户管理员跨租户管理用户。

## 4. 多租户数据隔离

~~~mermaid
flowchart TD
  Req[Authenticated Request]
  Ctx[tenantId userId role]
  API[API Handler]
  Store[Store Method]
  DB[(MySQL)]

  Req --> Ctx --> API --> Store --> DB
  Store -->|tenant key| DB
  Store -->|user key for private data| DB
~~~

主要隔离键：

- 会话与消息：tenant + user + session。
- Agent Run：tenant + run，并校验 user/session binding。
- Interaction、Tool Ledger、Checkpoint：tenant/run/thread 组合。
- 定时任务：tenant + 创建用户。
- 用户凭据：tenant + user + provider。
- 租户设置：tenant + setting key。
- Sandbox：tenant + user + session + profile/cluster。

Memory Store 必须保持与 MySQL Store 相同的授权语义，不能因开发模式放宽。

需要区分“表结构支持 tenant key”和“当前运行态按租户实例化”。模型、Sandbox Controller 与 MCP Manager 都是进程级单实例，启动时主要读取 `default` 租户设置；当前并未为每个 tenant 创建独立运行时。

## 5. 凭据与密钥

`SecretBox` 使用 AES-256-GCM。密钥通过 SHA-256 从独立 secret 和 domain 派生，密文包含版本、IV、tag 和 ciphertext。

- `AIOP_SETTINGS_SECRET` 是平台设置密钥首选。
- 开发环境可回退 `AIOP_JWT_SECRET`，生产必须分离。
- API Key 更新使用 keep/set/clear 语义，避免空值误删。
- 公开响应只返回是否设置和掩码预览。
- 用户下游凭据存储于 `user_credentials`，按用户与 provider 隔离。
- 日志和 Agent Run 错误在落库前做敏感字段脱敏。

## 6. 外部请求与 SSRF

`assertPublicUrl` 解析目标并拒绝 loopback、私网、链路本地等地址。Web Fetch 和 Webhook 默认使用该检查；只有显式配置的开发场景可放宽。

安全要求包括：

- 当前 Web Fetch 与 Webhook 使用 `redirect: 'error'`，直接禁止重定向，避免跳转绕过 SSRF 与域名检查。
- 超时和响应大小受限。
- 允许域名优先于任意 URL。
- MCP HTTP header 不进入公开状态。
- OIDC issuer、userinfo 和 JWKS 地址由平台管理员配置。

## 7. 文件、下载与路径

- Skill 文件读取进行根目录 containment 校验。
- 导入和同步限制路径、文件数与字节数。
- Download Store 只写配置目录，文件名规范化。
- 下载 URL 是短期能力，不等同于公开静态文件。
- 用户主目录挂载必须落在平台允许根路径下。

## 8. iframe 与浏览器安全

AIOS 嵌入场景通过 `frame-ancestors` 限制允许的父页面 origin；未配置时仅同源。CORS 或消息通信不能替代 CSP 嵌入边界。

SSE、Markdown、代码高亮和 Mermaid 都处理不可信内容。前端不执行模型输出中的任意 HTML 或脚本。

## 9. 工具安全链

~~~mermaid
sequenceDiagram
  participant M as Model
  participant B as Tool Broker
  participant R as Permission Rules
  participant P as Ops Policy
  participant A as Approval
  participant H as Hook
  participant T as Tool
  participant D as Audit

  M->>B: ToolCall
  B->>R: evaluate
  R-->>B: deny ask allow or none
  B->>P: hard and domain policy
  P->>D: decision audit
  opt approval required
    B->>A: request
    A-->>B: approved or denied
  end
  B->>H: PreToolUse
  H-->>B: allow or deny
  B->>T: dispatch only after checks
~~~

Prompt、模型选择和 Sandbox 内用户身份都不能跳过此链路。

## 10. 审计与生命周期

审计记录包含 kind、action、tenant、session、cluster、tool 和结构化 detail。Policy 判定、kubectl、usage 等写入 Audit Sink/Store。

用户禁用或软删除时：

- 后续登录被拒绝。
- 关联定时任务被禁用。
- 下游用户凭据被删除。
- 历史审计保留用于追踪。

## 11. 已知边界

- Hook 为 fail-open，不适合作为唯一合规控制。
- 内存 Store 只适合开发，重启丢失数据。
- JWT 默认开发密钥会记录告警，生产必须显式设置。
- Sandbox 隔离不能替代平台 RBAC。
- AIOS/JIT 身份映射依赖管理员配置，错误映射可能造成越权，必须测试 claims 样例。

## 12. 源码依据

- `src/auth/`
- `src/auth/rbac.ts`
- `src/auth/aios.ts`
- `src/auth/oidc.ts`
- `src/auth/credentials.ts`
- `src/security/secret-box.ts`
- `src/net/ssrf.ts`
- `src/server/context.ts`
- `src/server/downloads.ts`
- `src/config/schema.ts`
- `src/db/store.ts`
