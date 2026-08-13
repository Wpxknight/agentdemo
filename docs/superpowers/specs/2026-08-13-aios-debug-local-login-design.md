# AIOS 集成测试环境本地调试登录设计

> 日期：2026-08-13  
> 状态：待实现  
> 适用范围：`10.241.0.166` 的 `aios-integrated` 测试环境；生产默认不启用

## 1. 背景与目标

当前 `aios-integrated` 强制使用 `auth.provider=aios`，`POST /auth/login` 返回 404，Web 只等待 AIOS 宿主注入登录态。测试环境需要在保留 AIOS 主认证和 `/auth/aios/exchange` 的同时，允许已有本地调试账号使用用户名、密码登录。

目标：

1. AIOS 继续是主认证源，现有 AIOS 用户行为不变。
2. 本地登录是显式、默认关闭的测试能力，生产配置不变。
3. 本地 JWT 与 AIOS JWT 严格按 `provider` claim 和用户来源校验，不互相降级或串身份。
4. 只有数据库中 `auth_provider='local'` 且状态正常的用户可以走调试登录。
5. 166 部署可安全创建、重置调试账号密码，并可一键关闭和回滚。

## 2. 方案对比

| 方案 | 概述 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. AIOS 主 Provider + 可选 Local 辅助 Provider | Runtime 保留 `AiosAuthProvider`，显式增加 `debugLocalAuth` | 改动小、边界清晰、不改变主认证配置 | HTTP 认证需要按 token provider 路由 |
| B. 通用 CompositeAuthProvider | 把多个 Provider 注册到统一组合器 | 后续可扩展更多认证源 | 容易形成“逐个尝试”的降级语义，本次范围过大 |
| C. 将 166 改为 standalone/local | 使用现有本地登录 | 无需开发 | AIOS 主认证和集成行为丢失，不满足需求 |

推荐方案 A。该方案只给 AIOS 集成测试模式增加一个明确辅助入口，不引入通用混合认证框架。

## 3. 开关与运行时组合

新增进程环境变量：

```text
AIOP_AIOS_DEBUG_LOCAL_LOGIN=false
```

规则：

- 缺失、空值和 `false` 均为关闭；只接受明确的 `true` 开启。
- 仅允许 `deploymentMode=aios-integrated` 且 `auth.provider=aios` 时开启；其他组合设置为 `true` 应启动失败，避免误以为开关生效。
- 生产 Deployment、通用 ConfigMap、镜像和代码默认值均不设置或设置为 `false`。
- 仅 166 的 `deploy/aiop/deployment-aios-integrated.yaml` 测试清单设置为 `true`。若该清单也用于生产发布，应改为独立 overlay/Make 参数，禁止把测试开关固化到通用生产 manifest。

Runtime 目标结构：

```ts
interface Runtime {
  authProvider: AiosAuthProvider;       // 主认证，不变
  aiosAuth: AiosAuthProvider;           // exchange，不变
  debugLocalAuth?: LocalAuthProvider;   // 仅显式调试开关启用
}
```

两个 Provider 可以复用现有 `AIOP_JWT_SECRET` 和 TTL，但仍依靠 JWT 的 `provider` claim 进行分流；共享签名密钥不等于共享身份来源。

启动时若开启调试登录，必须输出一次 `warn`：

```text
AIOS integrated debug local login is enabled; test environment only
```

日志包含 deployment mode 和环境标识，不包含密码、JWT 或密码哈希。

## 4. 登录与 Bearer 认证

### 4.1 本地登录

`POST /auth/login` 的启用条件改为：

```text
standalone + LocalAuthProvider
或
aios-integrated + debugLocalAuth 已启用
```

AIOS 集成调试模式下只调用 `debugLocalAuth.login`。`LocalAuthProvider` 已校验密码和账号状态；还必须继续保证用户记录的 `auth_provider` 严格等于 `local`。AIOS direct identity、OIDC 用户或 provider 不匹配的同名账号一律失败，不尝试其他 Provider。

成功登录记录：

- `warn` 日志：调试本地登录被使用，记录 tenantId、userId、role 和 correlationId；不记录密码或 token。
- 审计事件：`kind=auth`、`action=aios-debug-local-login`、`provider=local`、`deploymentMode=aios-integrated`。

失败仍统一返回 401，不对外区分用户不存在、来源不匹配、禁用或密码错误；内部日志也不得记录密码。

### 4.2 Bearer token 共存

禁止使用“先 AIOS authenticate，失败后再 Local authenticate”的通用降级循环。推荐先验证 JWT 签名并读取受信的 `provider` claim，再按来源选择唯一 Provider：

```text
provider=aios  -> 仅 AiosAuthProvider.authenticate
provider=local -> 仅 debugLocalAuth.authenticate；未开启则 401
provider=oidc  -> 在 aios-integrated 中始终 401
缺失/未知      -> 401
```

随后继续执行现有状态复核：

- AIOS JWT 必须存在有效 AIOS 凭据，重新验证后的 tenantId、userId、role 必须一致；禁止 `platform_admin`。
- Local JWT 必须能查到相同 tenantId/userId 的 active 用户，且 `auth_provider='local'`、role 与 token 一致。
- AIOS 身份不创建本地影子行；本地用户也不读取或继承 AIOS 凭据。
- 一个 Provider 返回失败后不得换另一个 Provider 重试。

这样即使本地用户 ID 与 AIOS accountId 文本相同，`provider` 仍是身份键的一部分，不会串身份。业务数据现有的 tenantId/userId 隔离语义不变；测试账号应使用专门 ID 和租户，避免与真实 AIOS 用户共享业务数据。

## 5. Web 能力与登录入口

登录页面显示发生在取得 `/v1/me` 之前，不能依赖已认证响应中的 `features.localLogin` 作为唯一事实源。新增匿名可读、无敏感信息的认证能力接口：

```http
GET /v1/auth/capabilities

200 {
  "deploymentMode": "aios-integrated",
  "authProvider": "aios",
  "capabilities": {
    "aiosExchange": true,
    "localLogin": true
  }
}
```

`localLogin` 只由服务端实际存在 `debugLocalAuth` 决定，不能仅由前端环境变量决定。响应不包含用户、租户、密钥或上游认证地址。

Web Core 启动时获取 capabilities：

- `localLogin=false`：保持现有 `HostAuthenticationPending` 和 AIOS token exchange。
- `localLogin=true`：在等待 AIOS 主认证的页面提供“本地调试登录”入口，提交到现有 `/auth/login`。
- AIOS Host Adapter 需要提供本地 `login(credentials)` 实现或 Web Core 使用同一 API client；成功后仍通过 `host.setToken` 保存 token。
- `/v1/me.features.localLogin` 同步返回相同值，供登录后 UI 和诊断使用；`localUserManagement` 在 `aios-integrated` 中继续为 `false`，不得因调试登录开放用户管理 API。
- UI 必须显示“测试环境调试登录”警示，不伪装成正式 AIOS 登录。

## 6. 密码设置与重置

禁止把调试密码写入 Git、ConfigMap、镜像层、Makefile 参数默认值或普通日志。

推荐运维方式：

1. 在 `aiop-secrets` 中保存一次性初始化密码，例如 `AIOP_DEBUG_LOCAL_ADMIN_PASSWORD`；通过 stdin、受控 Secret 管理或现有密钥平台写入。
2. 开启调试登录时允许专用 bootstrap 流程创建一个 `auth_provider='local'` 的调试账号；已存在时不覆盖密码，避免每次 Pod 重启重置凭据。
3. 新增 Make 目标执行受控密码重置，例如：

```bash
make reset-aios-debug-local-password \
  DEBUG_LOCAL_TENANT=debug \
  DEBUG_LOCAL_USERNAME=aiop-debug
```

Make 目标从终端隐藏输入或 stdin 读取新密码，在服务容器内调用专用命令生成现有 scrypt 哈希并更新目标用户；不得把明文放入命令行参数。命令必须先校验目标用户 `auth_provider='local'`，禁止修改 AIOS/OIDC 用户，且只允许操作 AIoP 数据库。
4. 重置成功后记录操作者、目标账号和时间的审计/warn，不记录密码或哈希。必要时先禁用账号再重置，完成后显式恢复。

不建议直接手写 SQL 密码哈希，也不建议长期保留 bootstrap 明文 Secret。账号创建或完成首次重置后应删除一次性密码键；后续只使用受控重置命令。

## 7. 部署、测试与回滚

### 7.1 166 部署

- 在 166 专用 overlay 或测试 Deployment 中设置 `AIOP_AIOS_DEBUG_LOCAL_LOGIN=true`。
- `aiop-web` 不单独设置开关；Web 以服务端 capabilities 为准。
- 部署仍通过 Make 命令完成，例如现有 `make deploy-aios-integrated ...`；若通用 manifest 同时面向生产，应新增测试 overlay Make 目标，而非改变生产默认。
- 部署后检查启动 warn、capabilities、AIOS exchange、本地登录和 `/v1/me.authProvider`。

### 7.2 测试矩阵

| 场景 | 预期 |
| --- | --- |
| 开关缺失/false | `/auth/login` 404，capabilities.localLogin=false，AIOS 登录不变 |
| 非 AIOS 模式设置 true | 启动失败并给出安全配置错误 |
| AIOS 模式设置 true | AIOS exchange 与本地登录均可用 |
| local 用户正确密码 | 返回 provider=local JWT，`/v1/me.authProvider=local` |
| local 用户错误密码/禁用 | 401，不尝试 AIOS |
| AIOS/OIDC 用户提交本地密码 | 401，不颁发 local JWT |
| AIOS JWT | 只由 AiosAuthProvider 校验，AIOS 凭据失效即 401，不降级 local |
| local JWT | 只由 debugLocalAuth 校验；关闭开关或用户来源/状态/role 不匹配即 401 |
| 相同 tenantId/userId、不同 provider | 不串身份、不继承对方凭据 |
| 本地调试用户访问用户管理 API | `aios-integrated` 原有 404/权限边界不变 |
| 日志与审计 | 有启动 warn 和成功登录审计，无密码、哈希、JWT |
| 多副本 | 所有副本读取同一开关、JWT Secret 和数据库，行为一致 |

### 7.3 回滚

1. 将 `AIOP_AIOS_DEBUG_LOCAL_LOGIN` 删除或设为 `false`，重新部署；本地 JWT 随即不能通过 Provider 路由，即使尚未过期也返回 401。
2. 保留 AIOS 主认证、AIOS exchange 和数据库结构，不需要数据库 migration 回滚。
3. 禁用或删除专用本地调试账号，并删除一次性密码 Secret。
4. 验证 capabilities.localLogin=false、`/auth/login` 恢复 404、AIOS 登录正常。

## 8. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 测试开关误入生产 | 默认关闭；仅专用 overlay 设置；启动 warn；发布检查禁止生产值为 true |
| AIOS 失败后降级成本地身份 | 按受信 provider claim 唯一路由，失败即 401 |
| 本地账号冒充 AIOS 用户 | Local Provider 强制 `auth_provider=local`；测试账号使用专用租户/ID |
| 本地管理员权限过高 | 默认创建普通 `user`；确需管理员时单独审批并限时启用 |
| 密码泄露 | Secret/stdin 管理、scrypt 哈希、日志脱敏、首次使用后删除 bootstrap Secret |
| 调试入口长期遗留 | 启动 warn、成功使用审计、回滚步骤和生产清单断言 |

## 9. 工时估算

| 工作包 | 常规估算（人天） |
| --- | ---: |
| Runtime 双认证与 token 路由 | 0.75 |
| 登录、capabilities、审计 | 0.5 |
| Web 调试登录入口 | 0.5 |
| 安全建号/密码重置 Make 命令 | 0.5 |
| 自动化测试、166 部署与回滚验证 | 0.75 |
| **合计** | **3.0** |

估算包含开发、自测、相关回归和一次 166 部署，不包含等待外部 Secret 管理审批的自然时间。实现不需要数据库 schema 变更；若要求通用多 Provider 框架或生产级自助密码管理，应另行设计和估算。
