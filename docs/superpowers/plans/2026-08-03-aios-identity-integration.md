# AIOS 统一身份与 iframe 集成开发计划

> 本计划仅用于评审和后续实施；本次不执行代码、构建、部署或 AIOS 平台配置修改。

**目标：** 将 AIOS 设为 AIOP 生产环境唯一身份、用户、租户、角色和权限权威源，并通过安全 iframe 协议完成无感登录、续期和退出。

**设计依据：** `docs/superpowers/specs/2026-08-03-aios-identity-integration-design.md`

**前置条件：** AIOS 团队确认菜单/URL 配置、JWT `postMessage` 协议、RS256 公钥或 JWKS、tenant/project、roleIds、permission codes、退出机制和 AIOP 最终 origin。

---

### Task 1：冻结 AIOS 对接契约与测试夹具

**文件：**

- 新增：`tests/fixtures/aios/identity.json`
- 新增：`tests/fixtures/aios/tenant-account.json`
- 新增：`tests/fixtures/aios/permissions.json`
- 修改：`docs/design/06-auth-security-tenancy.md`

- [ ] 定义菜单/URL 配置、JWT 消息、claims、公钥轮换、租户、项目、角色、权限、退出和错误响应契约。
- [ ] 对现场响应做脱敏夹具，禁止保存 token、refresh token、私钥和真实 sessionId。
- [ ] 固化 `sub/accountId/name/sessionId/exp` 字段语义，补充公钥/JWKS 和 `kid` 轮换规则。
- [ ] 明确 AIOP permission code 和 AIOS permission code 的映射表。
- [ ] 明确一期允许的 AIOS tenant 范围和最终 iframe origin。

验收：契约经过 AIOP 与 AIOS 双方评审，字段和错误码无占位项。

### Task 2：先写身份与权限失败测试

**文件：**

- 修改：`tests/aios-integration.test.ts`
- 新增：`tests/contracts/aios-authoritative-auth.test.ts`
- 修改：`tests/frontend.test.ts`

- [ ] 增加 AIOS-only 模式禁用本地登录和用户写 API 的测试。
- [ ] 增加伪造签名、错误算法、过期 JWT、claims 缺失、错误 origin/source 和 nonce 不一致测试。
- [ ] 增加不同 roleIds/permission codes 映射为不同 AIOP permissions 的测试。
- [ ] 增加 AIOS 禁用、退出、权限收回和跨 tenant 拒绝测试。
- [ ] 增加前端不使用 `targetOrigin='*'`、不通过 URL 传 token、不存储 refresh token 的静态契约测试。

运行：

```bash
npx vitest run tests/aios-integration.test.ts tests/contracts/aios-authoritative-auth.test.ts tests/frontend.test.ts
```

预期：当前实现失败，且失败点对应权威边界、安全消息和权限模型。

### Task 3：重构 AIOS Identity Adapter 与数据模型

**文件：**

- 修改：`src/auth/aios.ts`
- 修改：`src/auth/provider.ts`
- 修改：`src/auth/types.ts`
- 修改：`src/auth/session.ts`
- 修改：`src/config/schema.ts`
- 修改：`src/db/migrations/0001_baseline.sql`
- 修改：`src/db/schema.ts`
- 修改：`src/db/store.ts`
- 修改：`src/db/memory.ts`
- 修改：`src/db/mysql.ts`

- [ ] 将 `auth.provider` 扩展为生产可选 `aios`，AIOS 权威模式不再依赖 Local/OIDC provider。
- [ ] 实现 RS256 JWT verifier：固定算法、公钥/JWKS 验签、`exp` 和必填 claims 校验。
- [ ] 按 `aios-common-server/pkg/common/jwt.go` 的字段结构解析 claims，但禁止复制其跳过签名校验的实现。
- [ ] 使用已验签 access token 查询 AIOS tenant/roleIds/permissions；接口需要 refresh token 时推动 AIOS 提供 AIOP 专用服务端契约，不向 iframe 索取 refresh token。
- [ ] 将用户表改为 AIOS 影子用户，使用 provider + external tenant + external user id 唯一约束。
- [ ] 新增外部会话记录，绑定 AIOS sessionId、identityVersion、权限快照和撤销状态。
- [ ] 在同一事务中 upsert 影子用户并创建外部会话，成功后再签发 AIOP JWT。
- [ ] 为 Memory/MySQL Store 实现相同的身份与会话语义。

验收：同一 AIOS 用户多次登录复用 AIOP user id；显示名变化不改变业务数据归属；伪造、过期或算法不符的 JWT 被拒。

### Task 4：从三角色授权迁移到 permission guard

**文件：**

- 修改：`src/auth/rbac.ts`
- 修改：`src/server/context.ts`
- 修改：`src/server/http.ts`
- 修改：`src/runtime.ts`
- 修改：`src/tools/governance.ts`
- 修改：相关权限测试

- [ ] 为 `RequestContext` 增加外部身份、permissions、identityVersion 和 externalSessionId。
- [ ] 保留派生 role 兼容 UI，但服务端动作改为 permission guard。
- [ ] 将现有用户管理、设置、审计、审批、集群写操作逐项映射到稳定 permission。
- [ ] 未映射权限默认拒绝；高风险动作使用更短权限快照 TTL 或实时核验。
- [ ] 修复运行态固定 default 租户的身份相关读取；若一期单租户则增加明确 tenant allowlist。

验收：角色相同但权限不同的 AIOS 用户在 AIOP 中得到不同授权；客户端自报角色或 tenant 无效。

### Task 5：收口用户生命周期与管理界面

**文件：**

- 修改：`src/auth/admin.ts`
- 修改：`src/auth/lifecycle.ts`
- 修改：`src/server/http.ts`
- 修改：`web/src/App.tsx`
- 修改：`web/src/types.ts`

- [ ] AIOS 模式下删除或禁用本地建号、改角色、禁用、恢复、删除 API。
- [ ] 用户列表改为只读影子目录，并显示 AIOS 来源与最近同步时间。
- [ ] 页面提供 AIOS 权限中心跳转，地址来自配置而非硬编码。
- [ ] AIOS 禁用/删除同步后撤销会话、清凭据、暂停定时任务并保留审计。
- [ ] 生产关闭常规 Local/OIDC 登录入口；破窗机制独立设计和审计。

验收：AIOP 无任何可造成 AIOS 用户/角色双写的生产入口。

### Task 6：加固 iframe bridge 与会话续期

**文件：**

- 修改：`web/src/App.tsx`
- 修改：`web/src/api.ts`
- 修改：`src/server/http.ts`
- 修改：`web/nginx.conf`
- 修改：`deploy/dev-k8s/aiop-deployment.yaml`
- 修改：`deploy/k8s/deployment-server.yaml`
- 修改：对应测试

- [ ] 生成握手 nonce，严格校验 `event.origin`、`event.source` 和协议版本。
- [ ] 父子页面使用精确 `targetOrigin`，删除 `postMessage(..., '*')`。
- [ ] AIOP 会话仅存内存；刷新 iframe 后重新向 AIOS paas-web 请求当前 JWT。
- [ ] 实现 `aiop:logout`、`aiop:auth-required` 和短会话续期。
- [ ] 配置精确 CSP `frame-ancestors`、`frame-src`、`connect-src` 和 `Referrer-Policy`。
- [ ] 日志、审计和错误响应统一脱敏。

验收：非 AIOS origin 无法驱动登录；AIOS 退出后 AIOP 会话在约定窗口内失效；浏览器存储中无 AIOS refresh token 和持久 AIOP bearer token。

### Task 7：集成验证、镜像和测试环境

**文件：**

- 修改：`Makefile`
- 修改：`deploy/dev-k8s/aiop-configmap.yaml`
- 修改：`deploy/dev-k8s/aiop-secret.example.yaml`
- 修改：`deploy/dev-k8s/README.md`
- 修改：`docs/design/06-auth-security-tenancy.md`
- 修改：`docs/design/09-api-and-web.md`
- 修改：`docs/design/10-deployment-observability.md`

- [ ] 增加 AIOS 合约测试和测试环境部署 Make 目标；不得把 token/secret 写进 ConfigMap。
- [ ] 覆盖普通用户、管理员、不同租户、权限变化、禁用、退出、JWT 伪造/过期/算法降级、公钥轮换和 AIOS 不可达场景。
- [ ] 验证 CSP、iframe、API、审计、会话隔离和历史数据归属。
- [ ] 完成全量类型检查、Web 构建和测试。

建议命令：

```bash
npm run typecheck
npm test
npm --prefix web run build
make image
make deploy-staging
```

验收：测试环境从 AIOS 菜单进入 AIOP，无二次登录；权限与 AIOS 一致；退出和禁用生效；无 token 泄漏。

## 实施停点

进入 Task 2 前必须确认设计文档第 11 节的第 1、2、4、6、8 项。本计划经用户确认后再进入开发；当前不执行任何任务。
