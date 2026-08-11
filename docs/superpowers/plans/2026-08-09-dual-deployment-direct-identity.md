# AIoP 双部署与 AIOS 直连身份开发计划

> 状态：待评审
> 日期：2026-08-09
> 设计依据：`docs/superpowers/specs/2026-08-09-dual-deployment-direct-identity-design.md`
> 本计划仅识别和编排开发任务；本次不实施代码、数据库或部署变更。

## 1. 实施原则

1. 先冻结跨仓库身份和页面宿主契约，再修改数据库和业务代码。
2. 先建立正整数 ID 类型、迁移和失败测试，再切换认证写路径。
3. AIOS 集成与独立部署共用业务 API、Store 和 Runtime；仅身份 Provider 与 Web Shell 分叉。
4. 迁移采用扩展—回填—切换—收口，删除旧列和旧登录链路放在观察期之后。
5. 所有镜像构建和测试环境部署通过 Make 目标执行。

## 2. 开发任务

### 2.1 优先级总览

| 优先级 | 任务 | AIoP 责任域 | 目标 | 阻塞关系 |
| --- | --- | --- | --- | --- |
| **P0 必须先完成** | Task 1–6 | 后端 / 数据库 / 跨团队契约 | 冻结核心契约，完成双模式身份、正整数 ID、独立部署兼容及 AIOS 历史归属 | 阻塞所有集成页面和发布工作 |
| **P1 一期交付** | Task 7–10 | 前端 / 后端 / 部署 / 跨仓库 | 交付共享 Web Core、paas-web 原生页面、权限审计和双模式部署 | 依赖 P0 全部通过 |
| **P2 后续增强** | Task 11 | 后端 / AIOS 外部依赖 | AIOS 集成模式离线定时任务 Token 续约与执行 | 不阻塞一期实时请求、历史查询及独立部署调度 |

一期完成定义为 **P0 + P1 全部验收**。P2 只登记 TODO，不在本期开发、测试和发布门禁中启用。AIOS 集成模式在 P2 完成前必须明确拒绝离线 Fire 外部执行。

### 2.2 AIoP 当前可执行范围

| 范围 | 归属 | 当前状态 |
| --- | --- | --- |
| 双模式配置、身份类型和 Provider 装配 | **后端** | AIoP 仓库可直接开发 |
| 正整数用户 ID、迁移脚本和一致性检查 | **后端/数据库** | 可开发和本地验证；测试库执行需确认 |
| Local/OIDC 独立部署兼容 | **后端** | AIoP 仓库可直接开发 |
| AIOS 无影子用户认证 Adapter | **后端** | 可基于契约开发；真实联调依赖 AIOS 接口 |
| Session、Task、Fire、Run 和历史归属 | **后端/数据库** | AIoP 仓库可直接开发 |
| Standalone Web 与共享 Web Core | **前端** | AIoP 仓库可直接开发 |
| paas-web 原生路由、登录态和 Nginx 代理 | **前端/跨仓库** | 需要 paas-web 仓库和团队配合 |
| 权限、审计和模式门禁 | **后端为主，前端配合** | AIoP 服务端和独立 Web 可直接开发 |
| AIoP 镜像、Make 和独立/后端部署 | **部署/测试** | 可开发；共享环境执行需确认 |
| AIOS 离线 Token 续约 | **后端/P2** | 等待 AIOS 受控续约接口，不进入一期 |

### Task 1【P0】【跨团队契约】：冻结 AIOS 与 paas-web 核心对接契约

**AIoP 当前可做：** 编写契约草案、字段校验、错误码、脱敏夹具和合约测试。

**外部依赖：** AIOS 团队确认身份/JWKS/权限接口；paas-web 团队确认 Token、路由和构建边界。

**范围：** AIOS 团队、paas-web 团队、AIoP

**文档/夹具：**

- 修改：`docs/design/14-aios-unified-auth.md`
- 修改：`docs/design/15-aiop-access-control.md`
- 新增：`tests/fixtures/aios/direct-identity.json`
- 新增：`tests/fixtures/aios/tenant-permissions.json`

- [ ] 确认 `accountId` 类型、范围、唯一性和正整数规范。
- [ ] 确认 tenant、账号状态、角色和 permission code 的可信来源。
- [ ] 确认 JWT/JWKS、issuer、audience、kid 轮换和 userinfo 失败语义。
- [ ] 确认 paas-web 每请求 Token 或无 JIT Exchange 二选一的协议。
- [ ] 确认 paas-web 源码仓库、路由、构建产物和 `/aiop-api` 代理边界。
- [ ] 明确一期契约：AIOS 集成模式离线 Fire 外部执行返回 `aios_offline_scheduling_unavailable`，Token 续约移入 P2 TODO。

**验收：** 一期所需字段、端点、错误码、实时 Token 生命周期和跨仓库责任人明确；离线续约不作为一期阻塞项。

### Task 2【P0】【后端】：建立双模式配置和身份类型

**AIoP 当前可独立完成。**

**文件：**

- 修改：`src/config/schema.ts`
- 修改：`src/auth/types.ts`
- 修改：`src/auth/provider.ts`
- 修改：`src/runtime.ts`
- 修改：`config.example.jsonc`
- 修改：相关配置测试

- [ ] 增加 `deploymentMode=standalone|aios-integrated`，并允许 `auth.provider=local|oidc|aios`。
- [ ] 校验合法组合：集成模式只允许 AIOS；独立模式允许 Local/OIDC。
- [ ] 引入 `PrincipalId` 正整数十进制字符串解析器，禁止 `0`、负数、小数、前导零和超出 BIGINT 的值。
- [ ] 为 `RequestContext` 增加 `provider`，更新公共 contracts 和 Runtime 装配。
- [ ] 增加配置失败测试，禁止隐式回退到 Local。

**验收命令：**

```bash
npm run typecheck
npx vitest run tests/auth.test.ts tests/runtime.test.ts tests/config.test.ts
```

### Task 3【P0】【后端/数据库/部署】：实现数据库迁移及预检工具

**AIoP 当前可独立完成代码和本地测试；执行测试库迁移前需单独确认。**

**文件：**

- 新增：`src/db/migrations/0003_positive_user_ids.sql` 或等价版本化迁移
- 修改：`src/db/migrations/0001_baseline.sql`
- 修改：`src/db/schema.ts`
- 修改：`src/db/index.ts`
- 修改：`tests/runtime-migrations.test.ts`
- 修改：`tests/db.test.ts`
- 新增：`scripts/check-user-id-migration.ts`
- 修改：`Makefile`

- [ ] 将 `users.id` 迁移为 `BIGINT UNSIGNED AUTO_INCREMENT`。
- [ ] 迁移 8 个用户语义列，并重建 `sessions`、`user_credentials` 主键和相关索引。
- [ ] 为旧字符串 ID 建立确定性映射并回填所有直接关联表。
- [ ] 增加行数、孤儿、链路一致性和非法 ID 检查。
- [ ] 迁移支持空表、存量数据、重复用户名、不同租户同名用户和中断重试。
- [ ] 基线安装直接创建目标结构；升级路径运行增量迁移。
- [ ] 增加 `make check-user-id-migration` 和受保护的 `make migrate-user-id-staging`。

**验收：** 全新库、存量夹具库和重复执行均通过；失败不会留下部分切换结构。

### Task 4【P0】【后端】：改造 Local/OIDC 独立身份路径

**AIoP 当前可独立完成。**

**文件：**

- 修改：`src/db/store.ts`
- 修改：`src/db/mysql.ts`
- 修改：`src/db/memory.ts`
- 修改：`src/auth/local.ts`
- 修改：`src/auth/oidc.ts`
- 修改：`src/auth/oidc-map.ts`
- 修改：`src/auth/session.ts`
- 修改：`src/auth/admin.ts`
- 修改：Local/OIDC/用户管理测试

- [ ] Local 创建用户改用数据库 `insertId`，应用层返回 decimal string。
- [ ] OIDC 保留 JIT，但关联到新的内部自增 ID。
- [ ] Session JWT 写入 `provider`，验证后恢复完整 RequestContext。
- [ ] 用户状态、禁用、恢复、凭据清理和定时任务暂停继续按本地 users 行执行。
- [ ] 证明现有独立 Web、登录和用户管理行为不回归。

**验收：** Local/OIDC 全套认证和跨用户隔离测试通过，用户 ID 均为正整数。

### Task 5【P0】【后端】：实现 AIOS 无影子用户直连认证

**AIoP 当前可完成 Provider、接口门禁和测试；真实身份/权限联调依赖 AIOS 契约。**

**文件：**

- 修改：`src/auth/aios.ts`
- 修改：`src/auth/credentials.ts`
- 修改：`src/server/context.ts`
- 修改：`src/server/http.ts`
- 修改：`src/runtime.ts`
- 修改：`tests/aios-integration.test.ts`
- 新增：`tests/contracts/aios-direct-identity.test.ts`

- [ ] 删除 AIOS `resolveIdentity()` 中的 `createTenant/createUser/updateUser` 路径。
- [ ] 后端验证 Token 并将可信 `accountId` 规范化为 `PrincipalId`。
- [ ] 从可信来源取得 tenant、账号状态和角色/权限，禁止采用页面自报值。
- [ ] `/v1/me` 不再依赖 `Store.getUser()`，直接返回已验证身份摘要。
- [ ] 集成模式关闭 Local 登录和本地用户管理写接口。
- [ ] 把当前统一 `assertUserActive()` 拆为按 Provider 的状态验证，禁止“找不到 users 行即 active”。
- [ ] 保留 AIOS 凭据加密存储，主键直接使用 `tenant_id + accountId + aios`。

**验收：** AIOS 登录前后 `users` 行数不变；同一 accountId 可读回自己的历史，不同 accountId/tenant 无法越权。

### Task 6【P0】【后端/数据库】：贯通业务 Store、Run 与 Scheduler 身份

**AIoP 当前可独立完成。**

**文件：**

- 修改：`src/db/store.ts`
- 修改：`src/db/mysql.ts`
- 修改：`src/db/memory.ts`
- 修改：`packages/control-contracts/src/*`
- 修改：`packages/pi-runtime/src/store/mysql.ts`
- 修改：`packages/scheduler-runtime/src/mysql.ts`
- 修改：`src/scheduler/*`
- 修改：相关 Session/Run/Scheduler 测试

- [ ] 所有业务写入和查询接受规范化 decimal-string `userId`，由 mysql2 安全写入 BIGINT。
- [ ] 保持 `scheduled_tasks.user_id → scheduler_fires.actor_id → agent_runs.user_id` 完全一致。
- [ ] Run 明细继续通过 `tenant_id + run_id` 间接关联用户，不重复写身份列。
- [ ] 独立模式定时执行前按 Provider 复核本地/OIDC 用户状态。
- [ ] AIOS 集成模式保留 Task/Fire 历史归属，但离线 Fire 在 P2 完成前以 `aios_offline_scheduling_unavailable` 拒绝启动 Run。
- [ ] 增加跨用户 Session、Run、Interaction、Task、Fire 历史隔离测试。

**验收：** 两种部署模式下历史归属一致；独立模式定时执行正常；AIOS 集成模式离线执行被明确、可观测地阻断。

### Task 7【P1】【前端】：提取共享 AIoP Web Core

**AIoP 当前可独立完成 Standalone Shell、Host Adapter 接口和共享业务组件；最终产物格式需与 paas-web 团队确认。**

**文件：**

- 修改：`web/src/App.tsx`
- 修改：`web/src/api.ts`
- 修改：`web/src/types.ts`
- 新增：`web/src/host/host-adapter.ts`
- 新增：`web/src/host/standalone-host.ts`
- 新增/调整：共享页面和状态模块
- 修改：`web/package.json`
- 修改：前端静态契约和构建测试

- [ ] 将登录 Shell、宿主导航与聊天/会话/Run/定时任务页面分离。
- [ ] 定义 `WebHostAdapter`，独立 Web 实现 Local/OIDC Token、API Base URL 和 401 处理。
- [ ] 输出可被 paas-web 消费的共享包或静态子应用产物，具体形式在 Task 1 冻结。
- [ ] 移除 Web Core 对 iframe、固定 origin 和 Local 登录页的硬依赖。
- [ ] 保证现有 AIoP Standalone Web 构建和交互不变。

**验收命令：**

```bash
npm --prefix web run build
npx vitest run tests/frontend.test.ts
```

### Task 8【P1】【前端/跨仓库】：在 paas-web 增加原生 AIoP 页面

**AIoP 当前不能在本仓库独立完成。** 可提供 Web Core、`AiosHostAdapter` 契约、API 联调服务和验收用例；页面路由、登录态接入、Nginx 代理和 paas-web 发布需要 paas-web 仓库及团队配合。

**仓库：** paas-web，实际路径在 Task 1 确认

- [ ] 注册 AIoP 菜单和路由，不使用 iframe。
- [ ] 实现 `AiosHostAdapter`，从 paas-web 受控登录态取得 Token。
- [ ] 接入 AIoP Web Core，提供聊天、会话和 Run 页面；定时任务页面展示历史，并明确标识 AIOS 离线执行暂不可用。
- [ ] 配置 `/aiop-api` 同源反向代理及超时、SSE、上传大小规则。
- [ ] 401 触发平台重新认证；403 展示权限不足，不自动换账号。
- [ ] 禁止 Token 进入 URL、localStorage、日志和前端埋点。
- [ ] 添加 paas-web 单元、构建和端到端测试。

**验收：** 从 paas-web 菜单进入原生页面，无 iframe、无二次登录，页面看到的历史只属于当前 AIOS 用户。

### Task 9【P1】【后端/前端】：双模式权限、审计和配置收口

**AIoP 当前可独立完成服务端权限、审计和 Standalone Web 收口；paas-web 菜单收口依赖 Task 8。**

**文件：**

- 修改：`src/auth/rbac.ts`
- 修改：`src/tools/governance.ts`
- 修改：`src/server/http.ts`
- 修改：审计与日志模块
- 修改：`web/src/*`
- 修改：权限测试

- [ ] AIOS 模式按可信角色/permission 映射授权；Local/OIDC 保留现有角色语义。
- [ ] 用户管理菜单和 API 按模式显式开关，不靠前端隐藏代替服务端门禁。
- [ ] 审计增加 deployment mode、provider、tenant/user、run/correlation ID，不记录 Token。
- [ ] 清理旧 iframe `postMessage`、AIOS JIT 和影子同步代码；仅在观察期结束后执行。
- [ ] 更新认证、数据持久化、API、权限和部署设计文档。

**验收：** 客户端伪造用户/租户/角色无效；两种模式未出现不适用的入口和菜单。

### Task 10【P1】【部署/测试/前后端集成】：构建、部署、灰度与回滚演练

**AIoP 当前可完成 AIoP 镜像、Make 目标、独立部署和 AIoP 后端测试部署；paas-web 镜像和菜单发布依赖其仓库与发布责任人。任何测试环境数据库迁移和共享环境发布需执行前确认。**

**文件：**

- 修改：`Makefile`
- 修改：`deploy/dev-k8s/*`
- 修改：`deploy/aiop/*`
- 修改：部署契约测试和运维文档

- [ ] 增加 `make test-dual-auth`，覆盖两种模式测试矩阵。
- [ ] 增加 `make image` 对共享 Web Core、Standalone Web 和 AIoP Server 的构建校验。
- [ ] 增加 `make deploy-standalone-staging`。
- [ ] 增加 `make deploy-aios-integrated-staging`，只更新 AIoP 和经确认的 paas-web 交付单元。
- [ ] 增加迁移前备份、预检、迁移、验证和失败停止步骤。
- [ ] 演练应用回滚、paas-web 菜单关闭、数据库兼容期回滚和 Token 失效场景。

**验收命令：**

```bash
make test-dual-auth
make check-user-id-migration
make image
make deploy-standalone-staging
make deploy-aios-integrated-staging
```

### Task 11【P2 TODO】【后端/AIOS 外部依赖】：AIOS 集成模式离线定时任务 Token

**AIoP 后续可实现凭据服务和 Scheduler 接入，但当前依赖 AIOS 提供受控续约接口。**

**状态：** 后续开发，不纳入一期交付门禁。

**预期范围：**

- [ ] 与 AIOS 冻结受控 Token 续约接口、服务身份、绝对续约窗口和撤销语义。
- [ ] 实现 `AiosCredentialService`，按 `tenant_id + user_id + provider` 加密保存用户凭据。
- [ ] 使用数据库锁或 CAS 合并同一用户并发续约，旧 Token 不得覆盖新 Token。
- [ ] Fire 执行前复核用户状态、任务归属、Token 和最新权限。
- [ ] AIOS API 返回 401 时只允许受控续约后重试一次；403 直接失败。
- [ ] Token 不进入 URL、Prompt、Run Event、Transcript、日志或普通审计字段。
- [ ] 增加续约成功、过期、撤销、并发、重放、用户禁用和服务不可用测试。
- [ ] P2 上线后才解除 `aios_offline_scheduling_unavailable` 门禁。

**验收：** AIOS 用户离线时，定时任务只以该用户有效 Token 执行；任何失败都不会降级为服务账号或其他用户身份。

## 3. 测试矩阵

| 维度 | 必测场景 |
| --- | --- |
| 配置 | 合法双模式组合；非法 Provider/模式组合启动失败 |
| AIOS 认证 | 正常、伪造签名、过期、错误算法、缺失/非法 accountId、IAM 不可达 |
| 独立认证 | Local 登录/禁用/恢复；OIDC 登录/JIT/角色映射 |
| 数据隔离 | 同租户不同用户、不同租户同 ID、管理员范围、会话和消息隔离 |
| Run 历史 | 实时 Run、恢复、Interaction、Tool Ledger、事件和 Turn 查询 |
| Scheduler | 独立模式 Task→Fire→Run 身份一致；AIOS 模式历史归属正确且离线 Fire 明确拒绝 |
| 数据迁移 | 空库、存量库、多租户、重复执行、中断、孤儿检测、回滚兼容 |
| 前端 | Standalone Shell、paas-web Shell、401/403、SSE、上传、刷新和退出 |
| 安全 | 客户端身份伪造、Token 泄漏扫描、跨租户访问、服务账号降级禁止 |
| 部署 | 两种镜像/清单、健康检查、版本标识、回滚、菜单关闭 |

全量门禁：

```bash
npm run typecheck
npm test
npm run verify:packages
npm --prefix web run build
make test-dual-auth
make image
```

## 4. 发布与回滚

### 4.1 发布波次

1. **W1 / P0 契约与测试基线**：Task 1–2，不改变流量。
2. **W2 / P0 数据层兼容**：Task 3–4，完成迁移和独立模式回归。
3. **W3 / P0 AIOS 直连后端**：Task 5–6，仅在测试环境启用。
4. **W4 / P1 双宿主前端**：Task 7–8，paas-web 小范围菜单开放。
5. **W5 / P1 权限与交付收口**：Task 9–10，全量回归、灰度和回滚演练。
6. **后续 / P2 离线调度增强**：Task 11，独立立项，不阻塞 W1–W5。

每个波次只部署一次集成版本，测试结果绑定同一镜像/commit。上一波验收失败不得进入下一波。

### 4.2 回滚点

- W1：纯测试与配置，可直接回滚代码。
- W2：保留旧 ID 列和映射时，可回滚到兼容应用；禁止直接回滚到迁移前且继续写入。
- W3：关闭 `aios-integrated` 配置，保留 standalone；不得恢复会创建新字符串影子 ID 的旧 AIOS 写路径。
- W4：关闭 paas-web 菜单/代理，独立 Web 继续服务。
- W5：旧列和旧链路删除前建立最终备份；删除属于独立确认的不可逆收口。

## 5. 实施门禁

开发开始前必须确认：

1. AIOS `accountId` 的唯一性、范围和 BIGINT 兼容性；
2. tenant、状态、角色和权限的可信接口；
3. paas-web 仓库、技术栈、构建发布责任和 Token 提供方式；
4. AIOS Token 验签/JWKS 和轮换契约；
5. OIDC 是否接受本期继续使用本地 JIT 用户；
6. 每个实例是否明确保证单一主身份源；
7. 数据库迁移维护窗口、备份位置和最终旧列删除审批。

AIOS 离线定时任务 Token 已明确列为 P2 TODO，不再作为一期开发门禁。

设计和计划经确认后，从 Task 1 开始实施；不得跳过契约与迁移测试直接修改测试库。
