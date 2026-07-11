# AIOS 嵌入集成设计方案：身份打通 · 用户级隔离 · 技能权限

> aiop 以 iframe 页面嵌入 AIOS 平台。AIOS 已有用户体系与权限 token。
> 本方案解决三个问题：
> 1. 不同用户使用 aiop 时使用各自的身份与 token，且聊天框无法冒充他人越权；
> 2. 技能（skill）执行时如何拿到**当前用户**的 AIOS token；
> 3. 技能所有权模型：管理员上传全员可见，普通用户上传默认私有、可共享，仅所有者可改删。
>
> 设计约束：aiop 用户体系独立于 AIOS，AIOS 只是一种可插拔的登录方式（§2.5）——独立部署（本地账密/OIDC）与嵌入 AIOS 两种形态共用同一套代码与数据模型。
>
> 配套现状见 [`DESIGN.md`](./DESIGN.md)、[`PLAN.md`](./PLAN.md)（S7~S9 已交付多租户/RBAC/OIDC）。

---

## 1. 现状与差距分析

| 能力 | 现状 | 差距 |
|---|---|---|
| 认证 | JWT 会话（`src/auth/session.ts`，HS256，payload 含 `sub/tenant/role`）；本地账密 + OIDC SSO（JIT 建号，`src/auth/oidc.ts`）；RBAC 三角色（`src/auth/rbac.ts`） | 无"被 iframe 嵌入 + 宿主身份透传"的免登录通道 |
| 用户表 | `users(id, tenant_id, username, role, password_hash)`（`src/db/schema.ts`），`(tenant_id, username)` 可查 | 无外部身份来源标记、无显示名 |
| 会话隔离 | `sessions`/`messages` 仅按 `tenant_id` 隔离（`src/db/migrations/0004_sessions.sql`，`src/db/store.ts`） | **无 `user_id`，同租户用户互见会话** |
| 请求上下文 | `RequestContext{tenantId,userId,role}` 已贯穿到 agent 与工具层（`src/server/http.ts` 构造 `toolCtx`） | `userId` 未参与数据过滤与凭据注入 |
| 技能存储 | 文件系统目录 `skills/<name>/`，`SkillRegistry`（`src/skill/registry.ts`）；导入需 `tenant:manage` 权限 | **无 owner / 可见性概念**，普通用户不能上传 |
| 沙箱凭据 | `skills.sandboxEnv` 全局静态注入且**禁止凭据**（`src/config/schema.ts`）；`aios-request` 技能运行时向用户索要账密换 token 存 `token.json` | 无 per-user 动态凭据通道；聊天里要密码在嵌入场景不可接受 |

三条改造互相依赖：**身份打通是地基**（提供可信的 AIOS userId），会话隔离、技能 owner、凭据注入都建立在其上。

---

## 2. 方案一：AIOS ↔ aiop 身份打通

### 2.1 总体流程（token exchange）

```
AIOS 宿主页                     aiop iframe                    aiop 后端                      AIOS 后端
    │                               │                              │                              │
    │  <iframe src=aiop>            │                              │                              │
    │◀── postMessage('aiop:ready') ─│                              │                              │
    │── postMessage({aiosToken}) ──▶│                              │                              │
    │        (校验 origin)           │── POST /auth/aios/exchange ─▶│                              │
    │                               │        {aiosToken}           │── 验证 token / 取 userinfo ──▶│
    │                               │                              │◀── {userId, name, roles} ────│
    │                               │                              │  JIT 建号(users 表)           │
    │                               │                              │  缓存用户 AIOS token(服务端)   │
    │                               │◀──── {aiopJwt} ──────────────│                              │
    │                               │  存 localStorage, 之后所有请求 │                              │
    │                               │  Authorization: Bearer <jwt> │                              │
```

要点：

1. **前端取身份用 `postMessage`，不用 URL query**（token 会进浏览器历史/访问日志），不依赖跨域 cookie（SameSite 限制在 iframe 场景不可靠）。iframe 加载完成后向 `window.parent` 发 `{type:'aiop:ready'}`；宿主监听后回发 `{type:'aiop:auth', token}`。**双向校验 `event.origin`**：aiop 侧维护宿主域名白名单（配置项 `auth.aios.allowedParentOrigins`），宿主侧校验 iframe origin。
2. **后端换发**：新增 `POST /auth/aios/exchange`。aiop 服务端拿 `aiosToken` 调 AIOS 的用户信息接口（upmstreeapi userinfo 或等价端点）验证真伪、获取 `userId/username/角色`。验证通过后用现有 `signSession`（`src/auth/session.ts`）签发 aiop JWT。
   - 若 AIOS token 本身是标准 JWT 且提供 JWKS 公钥端点，可直接本地验签省去回调（实现为 `AiosAuthProvider` 的可配置校验策略：`introspect | jwks`）。
3. **token 续期**：aiop JWT 短 TTL（如 2h）。前端在过期前重新走 ready→postMessage→exchange 静默续期；AIOS 侧用户登出后，下一次 exchange 自然失败，aiop 会话随之失效。
4. **嵌入安全**：aiop 静态资源响应头加 `Content-Security-Policy: frame-ancestors <AIOS域名列表>`（替代过时的 `X-Frame-Options`），防止其他站点嵌入钓鱼。
5. **双模运行**：aiop 用户体系不依赖 AIOS，可独立部署运行，详见 §2.5。

### 2.2 用户映射：JIT 建号（复用 OIDC 模式）

**不做全量用户同步，不新建映射表**——沿用 `src/auth/oidc.ts:resolveIdentity` 的 JIT 模式：

1. exchange 验证通过后拿到 AIOS 稳定唯一标识（userId/工号，**不用可变显示名**）；
2. `getUserByUsername(tenantId, <aios标识>)`，不存在则 `createUser({passwordHash: 'aios'})`（哨兵值，同 OIDC 的 `'oidc'`）；
3. 用 aiop 本地 `user.id` 签发 JWT（`sub`）。所有内部外键（`sessions.user_id`、`skills_meta.owner_user_id`、已有的 `scheduled_tasks.user_id`）都锚定这个本地 id。

`users` 表可选增强（非必须，锦上添花）：

```sql
ALTER TABLE users
  ADD COLUMN auth_provider VARCHAR(16) NOT NULL DEFAULT 'local',  -- local | oidc | aios
  ADD COLUMN display_name  VARCHAR(128) NULL;                     -- 前端展示中文名
```

角色映射：AIOS 管理员 → `tenant_admin`，普通用户 → `user`；每次 exchange 以 AIOS 最新角色为准刷新（同 OIDC 现有注释语义）。租户映射：单租户部署固定 `tenantId`；多租户则从 AIOS 组织字段映射，配置化（复用 `mapClaims` 思路）。

三个"不要存"：
- **不存 AIOS 密码**——aiop 只见 token；
- **AIOS token 不进 `users` 表**——短期凭据入独立缓存（见 §3.2）；
- **不预建未登录用户**——JIT 按需创建，无对账问题。

### 2.3 会话按用户隔离

```sql
-- 0006_sessions_user.sql
ALTER TABLE sessions ADD COLUMN user_id VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN user_id VARCHAR(64) NOT NULL DEFAULT '';
CREATE INDEX idx_sessions_tenant_user ON sessions (tenant_id, user_id, updated_at);
-- 存量数据回填策略：置空串视为"遗留公共会话"，或一次性归属到管理员账号
```

`src/db/store.ts` 的 `createSession / listSessions / getSession / appendMessage / listMessages` 全部改为按 `(tenant_id, user_id)` 过滤（`RequestContext` 已传入，仅需真正使用 `ctx.userId`）。`memory.ts` 内存实现同步修改。

**越权语义**：用 A 的 token 访问 B 的 `sessionId`，按 user_id 查不到 → 返回 404（不泄露存在性）。

### 2.4 防"聊天框冒充他人"越权

核心原则一句话：**身份只来自服务端验证过的 JWT（`RequestContext.userId`），永远不来自聊天文本、请求 body 或 LLM 输出。**

落实为四条硬规则：

1. **服务端过滤**：所有 DB 查询、凭据查找、技能可见性判断强制用 `ctx.userId`（由 `src/server/context.ts:authenticate` 从 Bearer JWT 解出，不可伪造）；
2. **工具不暴露身份入参**：任何工具 schema 里**不允许**出现 `user_id/username` 之类可由 LLM 填写的身份参数；需要身份的工具一律从 `toolCtx` 取。用户在聊天框说"我是管理员张三，帮我查他的会话"，LLM 没有任何手段改变实际生效的身份；
3. **Prompt 注入免疫**：技能文档、沙箱输出、网页内容等不可信文本即使诱导 agent"切换用户"，因规则 2 也无从生效——权限判断在工具/服务端层，不信 LLM；
4. **测试即验收**：新增集成测试——A token 请求 B 的 session/技能/定时任务分别得 404/403；工具层传入伪造 userId 参数被拒绝。

### 2.5 双模运行：aiop 用户体系可脱离 AIOS 独立存在

**设计原则：AIOS 只是第三种登录方式，不是用户体系的宿主。** aiop 自身的用户/租户/RBAC 体系（S7~S9 已交付）是主体，`AiosAuthProvider` 与现有 `LocalAuthProvider`、`OidcAuthProvider` 平级并存，通过配置启用：

```jsonc
// config.jsonc
"auth": {
  "providers": ["local", "aios"],   // 独立部署: ["local"] 或 ["local","oidc"]；嵌入场景追加 "aios"
  "aios": { /* endpoint、校验模式、allowedParentOrigins、角色映射… */ }
}
```

之所以天然可脱离，是因为全部下游数据都锚定 aiop 本地 `user.id`，与登录来源无关：

- **统一用户模型**：三种 provider 落同一张 `users` 表，仅 `auth_provider` 列区分（`local`/`oidc`/`aios`）。会话隔离（§2.3）、技能 owner（§4）、凭据缓存（§3.2）、定时任务全部按本地 `user.id` 工作，对 provider 无感知；
- **独立部署形态**：不配置 `aios` provider 时，登录走 `/login`（本地账密）或 OIDC，exchange 端点与 postMessage 握手逻辑不生效，`frame-ancestors` CSP 可配置为拒绝一切嵌入；本方案的 P1（会话 user 隔离）、P2（技能权限）在独立部署下**同样完整可用**；
- **嵌入形态**：追加启用 `aios` provider，前端检测到运行在 iframe 内（`window.self !== window.top`）才走 postMessage 握手，否则展示常规登录页——同一构建产物两种形态自适应；
- **混合共存**：同一实例可同时存在本地用户和 AIOS 用户（如运维用本地管理员账号，业务用户从 AIOS 进入），互相可见性遵循同一套租户/权限规则。

唯一与 provider 相关的差异在**技能下游凭据**：AIOS token 凭据缓存只有 `aios` 来源的用户天然拥有；本地/OIDC 用户使用 `aios-request` 技能时走技能内置的备用取凭据路径（见 §3.4）。

---

## 3. 方案二：技能执行传递当前用户 token

### 3.1 目标与约束

- `aios-request` 等技能在沙箱内调 AIOS API 时，使用**当前聊天用户**的 AIOS token；
- 废除"聊天里问账密"（`skills/aios-request/aios-base/SKILL.md` 现行为）——嵌入场景不可接受，且聊天收密码本身是钓鱼隐患；
- 不违反 `skills.sandboxEnv` 禁凭据的既有设计（`src/config/schema.ts`）——静态配置通道继续只放 `AIOS_BASE_URL` 等非敏感项。

### 3.2 服务端用户凭据缓存

exchange 时后端已拿到该用户的 AIOS token，将其存入**独立的服务端凭据缓存**（与用户档案分离）：

- 结构：`user_credentials(tenant_id, user_id, provider='aios', token_encrypted, expires_at, updated_at)`，MySQL 表或内存 Map（单实例可先内存，多副本部署用表）；
- 静态加密：用服务端密钥 AES-GCM 加密落库（密钥来自 env，复用现有 secret 管理方式）；
- 生命周期：随前端静默续期刷新；过期后凭据查找失败 → 工具返回明确错误"请在 AIOS 平台重新登录"。

### 3.3 注入时机：运行时写文件，而非创建期 env

**创建期 env 注入不可行**：warmpool（`src/sandbox/warmpool.ts`）预创建沙箱时没有用户上下文；OpenSandbox 的 env 在创建时固化（`src/sandbox/opensandbox.ts` `spec.envs`）。

**采用运行时文件注入**：

1. agent 执行 `skill__sync_to_sandbox`（`src/tools/skill.ts`）同步 `aios-request` 技能时，工具层检测到该技能声明需要用户凭据（技能 frontmatter 新增 `credentials: [aios]` 字段），用 `toolCtx.userId` 查凭据缓存；
2. 将 token 以文件形式写入沙箱：`/workspace/skills/aios-request/aios-base/scripts/token.json`——**`AIOS_TOKEN_FILE` 机制已存在**（`config.py`），技能脚本零改动即可读到；
3. 非敏感项（`AIOS_BASE_URL`、`AIOS_CLUSTER_NAME` 等）继续走 `sandboxEnv` 静态注入。

**沙箱不跨用户复用**（前提约束）：

- 沙箱生命周期与 session 绑定（`src/sandbox/lifecycle.ts`），session 归属 user（§2.3 后成立）→ 天然 per-user；
- warmpool 沙箱一旦被领取并**写入过凭据**，释放时销毁不回池（lifecycle 加"已污染"标记）；未写凭据的可正常回池。

### 3.4 技能侧改造（aios-request）

按当前用户的登录来源分两条路径：

- **AIOS 用户（嵌入场景）**：读平台注入的 `token.json` → 有效则用；缺失/过期 → 输出明确指引"请在 AIOS 平台重新登录后重试"，**绝不在聊天中索要密码**；
- **本地/OIDC 用户（独立部署，§2.5）**：无平台注入凭据，保留现有备用路径——`auth.py` 的 `login_with_credentials`（需 env 开关 `AIOS_ALLOW_PASSWORD_LOGIN=1` 显式启用）或 `setup_auth_browser.py`（浏览器 localStorage 取 token）；拿到的 token 同样写入该用户的服务端凭据缓存（§3.2），后续复用，仍然 per-user 隔离。

`SKILL.md` 改造为：优先 `token.json` → 缺失时按部署模式给出对应指引；`auth.py` 保留 token 刷新逻辑（若 AIOS token 支持 refresh）。

### 3.5 进阶（二期）：后端代理模式，token 不落沙箱

沙箱内执行的是技能代码 + LLM 生成的代码，token 落入沙箱存在被打印/外带的面。更安全的演进：

- aiop 后端提供受限代理端点 `POST /v1/proxy/aios/*`；
- 沙箱创建/领取时注入**一次性短时 sandbox token**（只标识"哪个 session"，不含 AIOS 凭据）；
- 技能调代理端点，aiop 服务端按 session→user 查凭据缓存，附加 AIOS token 转发下游，并可做审计与端点白名单。

改造量较大（技能脚本需改 base_url 指向代理），建议在文件注入方案跑通后作为安全加固项。

---

## 4. 方案三：技能所有权与共享模型

### 4.1 权限规则

| 角色 | 上传后可见性 | 可修改/删除 | 可共享 |
|---|---|---|---|
| 管理员（`tenant_admin`/`platform_admin`） | `public`（全员可见可用） | 仅自己上传的 | —（已是 public） |
| 普通用户（`user`） | `private`（默认仅自己） | 仅自己上传的 | 点"共享"→ `shared`（租户内全员可见可用） |

原则贯彻：**只有 owner 能修改、删除、共享自己的技能**——管理员也不能改删他人技能。如需运维兜底清理，另开 `platform_admin` 专属显式接口，默认关闭。

> 共享粒度先做"租户内全员"（`shared` 一个状态），若后续要精确到指定用户，追加 `skill_shares(skill_name, shared_to_user_id)` 表即可，模型兼容。

### 4.2 存储设计：文件保留 + 元数据表管权限

技能内容仍是文件目录（渐进式披露机制不变），权限元数据入库：

```sql
-- 0007_skills_meta.sql
CREATE TABLE skills_meta (
  tenant_id     VARCHAR(64)  NOT NULL,
  skill_name    VARCHAR(128) NOT NULL,
  owner_user_id VARCHAR(64)  NOT NULL,
  visibility    ENUM('public','private','shared') NOT NULL DEFAULT 'private',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, skill_name)
);
```

目录分层（防不同用户同名冲突）：

```
skills/
├── _public/<name>/          # 管理员上传（visibility=public）
└── users/<userId>/<name>/   # 个人上传（private/shared）
```

- `SkillRegistry`（`src/skill/registry.ts`）改为多根扫描，`Skill` 接口增加 `owner/visibility` 字段（从 meta 表联查或启动时加载）；
- 同名解析：public 命名空间内唯一；用户技能与 public 同名时，列表展示带所有者标识，工具名内部用 `<name>@<owner>` 消歧（对 LLM 暴露的工具描述里注明来源）；
- 存量技能迁移：现有 `skills/*` 一次性移入 `_public/`，owner 记为管理员账号。

### 4.3 API 变更（均在 `src/server/http.ts` 现有路由改造）

| 路由 | 变更 |
|---|---|
| `POST /v1/skills/import` | 放开给所有登录用户（去掉 `tenant:manage` 门槛）；按角色决定落 `_public/` 或 `users/<uid>/`；写 `skills_meta` |
| `GET /v1/tools` 及技能列表 | 服务端按 `ctx.userId` 过滤：`public` ∪ 自己的 ∪ `shared` |
| `POST /v1/skills/:name/share` `unshare` | **新增**，仅 owner；`private ↔ shared` |
| `POST /v1/skills/:name/(enable|disable)` | 仅 owner |
| `DELETE /v1/skills/:name` | 仅 owner |
| `GET /v1/skills/:name/files` | 可见性检查（public/shared/owner） |

**执行链路同样过滤（易漏关键点）**：`load_skill`、`skill__sync_to_sandbox`（`src/tools/skill.ts`）在工具层做同一套可见性检查——否则用户可在聊天里让 agent"加载 xxx 技能"绕过列表过滤，读到他人私有技能。与 §2.4 同理：**权限判断在工具/服务端，不信 LLM**。

### 4.4 前端

- 技能列表卡片显示：所有者（`display_name`）、可见性徽标（公共/私有/已共享）；
- owner 视角出现"共享/取消共享""删除"按钮；非 owner 只读；
- 上传入口对所有用户开放，上传后提示可见性状态。

---

## 5. 变更汇总

### 5.1 数据库迁移

| 迁移 | 内容 |
|---|---|
| `0006_sessions_user.sql` | `sessions`/`messages` 加 `user_id` + 索引，存量回填 |
| `0007_skills_meta.sql` | 技能元数据表 |
| `0008_users_provider.sql` | `users` 加 `status`（软删除必需）；`auth_provider`/`display_name`（可选） |
| `0009_user_credentials.sql`（多副本时） | 用户 AIOS token 加密缓存表 |

### 5.2 后端模块

| 模块 | 变更 |
|---|---|
| `src/auth/aios.ts`（新增） | `AiosAuthProvider`：token 校验（introspect/jwks 可配）→ JIT 建号 → 签发 JWT → 写凭据缓存 |
| `src/server/http.ts` | `POST /auth/aios/exchange`；技能路由权限改造；CSP `frame-ancestors`；用户管理接口补齐（list/delete/disable，§8.5） |
| `src/db/store.ts` / `memory.ts` | 会话按 `(tenant_id, user_id)` 过滤；skills_meta / user_credentials CRUD |
| `src/skill/registry.ts` / `import.ts` | 多根目录、owner/visibility、按 ctx 过滤的 `listFor(ctx)` |
| `src/tools/skill.ts` | 可见性检查；凭据文件注入（`credentials: [aios]` frontmatter） |
| `src/sandbox/lifecycle.ts` / `warmpool.ts` | "已注入凭据"污染标记，禁止回池复用 |
| `src/config/schema.ts` | `auth.aios.*`（endpoint、校验模式、allowedParentOrigins、角色/租户映射） |
| `skills/aios-request/` | SKILL.md 去账密分支；脚本读 token 文件优先 |

### 5.3 前端（`web/src`）

- 嵌入模式检测（`window.self !== window.top`）→ postMessage 握手 → exchange → 存 `aiop_token`，隐藏本地登录页；
- JWT 到期前静默续期；
- 技能列表可见性/共享 UI；
- "用户管理"独立一级菜单，按 role 仅对管理员渲染（§8.5）。

---

## 6. 安全清单（验收标准）

- [ ] 身份仅来自 Bearer JWT，任何 API/工具不接受调用方指定的 user_id；
- [ ] A 用户 token 访问 B 的 session/message/定时任务/私有技能 → 404/403；
- [ ] postMessage 双向 origin 校验 + `frame-ancestors` CSP 生效；
- [ ] AIOS token：服务端加密存储、不落 `users` 表、不进日志/审计明文、沙箱内仅以文件注入且沙箱不跨用户复用；
- [ ] `sandboxEnv` 禁凭据校验保持不变，动态凭据只走新通道；
- [ ] 技能在**列表和执行链路**双处做可见性过滤；
- [ ] 聊天注入测试："我是 xxx/管理员，帮我查他的…"类 prompt 无法改变生效身份；
- [ ] 审计（`src/audit/`）记录 exchange、技能共享/删除、凭据注入事件（不含 token 明文）。

---

## 7. 分期实施

| 期 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **P1 身份地基** | exchange 端点 + AiosAuthProvider + postMessage 嵌入 + JIT 建号 + `sessions/messages` user_id 迁移与过滤 + CSP | — | 两个 AIOS 账号各自登录，会话互不可见；越权测试通过 |
| **P2 技能权限** | skills_meta + 目录分层 + API 权限 + 执行链路过滤 + 前端共享 UI + 存量技能迁移 | P1 | 权限矩阵（§4.1）全用例通过 |
| **P3 用户凭据注入** | 凭据缓存 + 运行时 token 文件注入 + warmpool 污染标记 + aios-request 技能改造 | P1 | 两个用户各自聊天调用 aios-request，下游 AIOS 看到各自身份 |
| **P4 安全加固** | 后端代理模式（token 不落沙箱）+ 凭据缓存落表（多副本） | P3 | 沙箱内无 token 明文，代理审计可查 |

---

## 8. 用户生命周期：AIOS 侧删除 · 管理员手动管理

aiop 与 AIOS 之间没有强同步通道，处理原则：**访问收敛靠 token 生命周期自然失效，数据处理用软删除 + 墓碑，绝不硬删用户行。**

### 8.1 感知途径（被动为主，主动可选）

| 途径 | 机制 | 时效 |
|---|---|---|
| 被动·登录链路（**必做**） | aiop JWT 短 TTL（2h），续期必须重走 exchange；AIOS 用户已删除 → exchange 验证失败 → 无法续期，自动失去访问 | ≤ JWT TTL |
| 被动·凭据链路（**必做**） | 凭据缓存中该用户 AIOS token 过期/刷新失败 → 技能调用报错；连续失败即触发本地禁用流程 | ≤ AIOS token TTL |
| 主动·对账任务（可选） | 复用现有 scheduler 跑周期任务，对近期活跃用户逐个调 AIOS userinfo 校验，失效者本地禁用 | 可配（如每小时） |
| 主动·webhook（可选） | 若 AIOS 提供用户变更回调，aiop 开接收端点即时禁用 | 实时 |

最大风险窗口 = aiop JWT TTL（已删用户手里未过期的 JWT 仍可用最多 2h）。若业务要求更快收敛：认证中间件在解出 JWT 后校验 `users.status`（结果短 TTL 内存缓存，如 60s，避免每请求打库），窗口缩到分钟级。

### 8.2 本地处置：软删除 + 墓碑

检测到用户失效后执行"本地禁用"流程（幂等）：

1. **`users.status` 置 `disabled`**（`users` 表加 `status` 列，`active | disabled`）——**不硬删行**：`sessions.user_id`、`skills_meta.owner_user_id`、`scheduled_tasks.user_id`、审计记录都外键锚定它；
2. **立即清除凭据缓存**中该用户的 AIOS token；
3. **暂停其名下 `scheduled_tasks`**（置 disabled 并记录原因）——不暂停也会因无凭据而失败，显式暂停语义更清晰；
4. **username 打墓碑**：改写为 `<原名>#deleted#<时间戳>`。这一步防**账号复用串数据**：若 AIOS 日后把同一用户名/工号分配给新人，JIT 按 `(tenant_id, username)` 匹配会命中旧行、继承旧人的会话和技能——打墓碑后新人 exchange 时匹配不到，走 JIT 新建干净账号。（前提再强调：映射标识必须用 AIOS 的**稳定不可复用 ID**；若 AIOS 连 userId 都会复用，墓碑是唯一防线。）

### 8.3 遗留数据归属

| 数据 | 策略 |
|---|---|
| 会话/消息 | 保留（审计与留存策略决定期限），任何普通用户不可见；如需导出由 `platform_admin` 运维接口处理 |
| 私有技能（`private`） | 冻结不可见；随留存策略清理 |
| 共享/公共技能（`shared`/`public`） | **保持可用**（他人可能依赖），但进入"无主冻结"态——无人可修改删除；通过 §4.1 提到的 `platform_admin` 显式运维接口做**所有权转移**给在职用户，或下架 |
| 定时任务 | 已暂停；可由运维接口转移 owner 后恢复 |
| 审计记录 | 不动 |

### 8.4 误删恢复

AIOS 侧恢复该用户后：exchange 按稳定 ID 匹配不到墓碑行（username 已改写）会 JIT 新建账号。若需找回旧数据，由 `platform_admin` 运维接口把墓碑账号的数据（会话/技能/任务 owner）转移到新账号——不做自动合并，避免复用串号风险。

### 8.5 管理员手动创建 / 删除用户

现有基础：`POST /v1/admin/users`（创建本地用户）与 RBAC 权限 `user:manage:any`（platform_admin，跨租户）/ `user:manage:own`（tenant_admin，本租户）均已交付（`src/server/http.ts:1209`、`src/auth/rbac.ts`），本方案补齐列表与删除，并与 §8.2 的软删除流程统一。

**API：**

| 路由 | 权限 | 说明 |
|---|---|---|
| `POST /v1/admin/users` | `user:manage:own/any` | 已有；创建本地账密用户（`auth_provider='local'`）。AIOS/OIDC 用户不手动建，由 JIT 产生 |
| `GET /v1/admin/users` | `user:manage:own/any` | **新增**；列本租户（或指定租户）用户：username/display_name/role/auth_provider/status |
| `DELETE /v1/admin/users/:id` | `user:manage:own/any` | **新增**；执行软删除（下述语义） |
| `POST /v1/admin/users/:id/(disable\|enable)` | `user:manage:own/any` | **新增**；临时禁用/恢复，不动数据归属 |

**删除语义 = 复用 §8.2 软删除流程**（置 `disabled`、清凭据缓存、暂停定时任务、数据归属按 §8.3），但与 AIOS 侧删除有一个关键差异——**是否打 username 墓碑**：

| 触发来源 | username 处理 | 效果 |
|---|---|---|
| AIOS 侧删除（§8.1 检测到） | 打墓碑（改写） | 同名新人可 JIT 建新号，防串数据 |
| **管理员手动删除** | **不打墓碑，保留原名** | 该用户下次 exchange 仍命中此行 → `status='disabled'` 校验拒绝登录，**实现封禁**。若打墓碑，AIOS 用户下次登录会 JIT 重建新号，管理员的删除形同虚设 |

即：手动删除 AIOS 来源用户 = 封禁（阻止其经 JIT 复活）；本地用户删除后同样保留行与原名（`(tenant_id, username)` 占用，防止新建同名账号继承视觉身份）。如管理员确认要释放该用户名（如确认是离职且工号回收），在删除接口加 `?tombstone=true` 显式参数打墓碑。

**护栏规则：**

1. 不能删除/禁用**自己**；
2. 角色层级约束：`tenant_admin` 不能删除 `platform_admin` 或其他 `tenant_admin`（仅 `platform_admin` 可以）；
3. 删除操作写审计（`src/audit/`），含操作者、目标、tombstone 与否；
4. JIT 建号与手动删除的竞态：JIT 前先按 username 查行（含 disabled 行）——命中 disabled 即拒绝，不新建。

**前端**：**"用户管理"独立为一级菜单**（与聊天、技能等并列，不放进设置页 tabs），**仅管理员可见**：

- 可见性由 JWT 里的 `role` 决定——`tenant_admin`/`platform_admin` 显示菜单项，`user` 角色不渲染；`platform_admin` 额外带租户切换/筛选；
- 页面内容：用户列表（username/display_name/角色/来源/状态/创建时间）+ 创建表单（仅本地账号，AIOS/OIDC 来源注明"由平台登录自动创建"）+ 禁用/启用/删除操作（删除带二次确认，含 tombstone 选项）；
- **前端隐藏只是 UX，不是安全边界**——真正的防线是后端每个 `/v1/admin/users*` 路由的 `user:manage:own/any` RBAC 校验，普通用户直接调 API 一律 403。

---

## 9. 风险与开放问题

1. **AIOS token 校验方式**：需确认 AIOS 是否提供 userinfo/introspect 接口或 JWKS——决定 `AiosAuthProvider` 实现分支（对接前置沟通项）；
2. **AIOS token 有效期与刷新**：若无 refresh 机制，只能依赖前端静默续期链路，长任务（定时任务、长 agent run）中途过期需明确失败语义；
3. **定时任务的用户凭据**：`scheduled_tasks` 已有 user_id，但任务在无前端会话时执行，届时用户缓存 token 可能已过期——P3 先明确"定时任务中 aios-request 可能失败需重登"，长期解法依赖 AIOS 提供长期授权（如 offline token / 服务账号代理）；
4. **存量会话归属**：`user_id` 回填策略需与使用方确认（归管理员 or 保持公共只读）；
5. **多副本部署**：凭据缓存与技能目录需共享存储（凭据落表解决前者；技能目录多副本时需 PV 共享或改对象存储，现阶段单副本不受影响）。
