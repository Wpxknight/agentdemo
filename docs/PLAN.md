# 开发计划（后端，分阶段）

> 配套设计见 [`DESIGN.md`](./DESIGN.md)。本计划**仅后端**（暂不开发前端）。
> 语言 TypeScript + Node.js；包管理 npm；测试 vitest；类型检查 tsc。
> 每个阶段可独立验收、可运行。

## 阶段总览

| 阶段 | 名称 | 产出 | 依赖 |
|---|---|---|---|
| **S0** | 项目脚手架 | 工程结构、config、日志、构建/测试链 | — |
| **S1** | 模型层 + Agent 循环 | 双协议 adapter、agentic loop、工具注册/dispatch | S0 |
| **S2** | 工具系统 + E2B 沙箱 | 内置工具、E2B `run_code`（新建/连接/动态拉起） | S1 |
| **S3** | MCP + Skill | MCP client（多 transport）、Skill 渐进式加载 | S1 |
| **S4** | 多集群运维 + Policy | 集群注册表、`SandboxManager`、`kubectl` 工具、Policy 中间件、审计 | S2 |
| **S5** | 持久化（MySQL） | env 配置（密码 base64）、`mysql2`+`kysely`、Store、迁移 | S0 |
| **S6** | 定时任务 | `scheduled_tasks`/`task_runs`、`schedule_task` 工具、调度器 tick（SKIP LOCKED） | S5 |
| **S7** | 多租户 + 会话隔离 + 本地认证（P1） | tenants/users、各表 tenant_id、`AuthProvider`/Local、`RequestContext` | S5 |
| **S8** | RBAC 三角色 + 授权融合（P2） | 权限矩阵、RBAC 中间件、Policy 融合、用户/租户管理 | S4, S7 |
| **S9** | SSO 对接（P3） | `OidcAuthProvider`、claims→tenant/role 映射、JIT 建号 | S8 |
| **S10** | 增强 | E2B Desktop/浏览器、审批门交互、warm pool | S4 |

API 通过 HTTP + SSE 暴露（前端后续接入）；本阶段以服务端 + CLI/集成测试驱动验收。

---

## S0 项目脚手架

- 目录结构（见 DESIGN §12）、`package.json`、`tsconfig.json`、`.gitignore`、`.env.example`。
- 公共设施：`config`（zod 校验 + env 注入）、`logger`（pino）、错误类型。
- 脚本：`build`(tsc)、`dev`(tsx)、`test`(vitest)、`typecheck`、`lint`。
- **验收**：`npm run typecheck` 通过；`npm test` 跑通占位测试。

## S1 模型层 + Agent 循环

- `model/types.ts` 内部中立格式（Msg/ToolDef/StreamEvent/ChatModel）。
- `model/anthropic.ts`、`model/openai.ts` 双协议 adapter（含流式）；`model/factory.ts`。
- `agent/tools.ts` ToolRegistry（注册 + dispatch + 命名空间路由）。
- `agent/core.ts` agentic loop（text/tool_call 收集 → dispatch → 回填）。
- `agent/policy.ts` Policy 接口占位（S4 充实）。
- **验收**：用 mock 模型驱动 loop 完成一次"模型→工具→回填→结束"；adapter 单测覆盖格式转换。

## S2 工具系统 + E2B 沙箱

- `sandbox/lifecycle.ts` `SandboxManager`（新建/`connect`/动态拉起、缓存、idle GC）。
- `tools/builtin.ts` `run_code`/`run_command`。
- **验收**：`SandboxManager` 单测（mock E2B）；`run_code` 端到端（有 E2B key 时）。

## S3 MCP + Skill

- `mcp/manager.ts` 连接 stdio/SSE/HTTP、`listTools`→ToolDef（`mcp:server:tool`）、dispatch。
- `skill/registry.ts` 扫描 `SKILL.md`、注入摘要、`load_skill` 工具展开。
- **验收**：接一个 stdio MCP server 列出并调用工具；加载一个示例 skill。

## S4 多集群运维 + Policy

- `config/clusters.ts` 集群注册表；`tools/kubectl.ts` `kubectl(cluster,args,dryRun)`。
- `agent/policy.ts` 充实：读写分离、危险命令拦截、生产审批钩子。
- `audit/sink.ts` 审计事件（kubectl/sandbox/policy）。
- **验收**：ro 集群拦截变更、危险命令拦截、审计落库的单测。

## S5 持久化（MySQL）

- `config/mysql.ts` env 读取 + 密码 base64 解码。
- `db/index.ts` `mysql2`+`kysely`；`db/schema.sql` 迁移；`db/store.ts` Store 实现。
- **验收**：连真实 MySQL（docker）跑迁移；messages/audit 读写单测（可用 testcontainers 或本地实例）。

## S6 定时任务

- `db` 加 `scheduled_tasks`/`task_runs`；`tools/schedule.ts` `schedule_task` 等工具（`cron-parser`）。
- `scheduler/ticker.ts` tick（`FOR UPDATE SKIP LOCKED`）→ `runAgent` → 写 `task_runs`。
- **验收**：创建任务→到点触发→记录结果；多副本（并发两 ticker）不重复执行的测试。

## S7 多租户 + 会话隔离 + 本地认证（P1）

- `db` 加 `tenants`/`users`；各表加 `tenant_id`；Store 方法签名带 `ctx`，强制过滤。
- `auth/provider.ts` `AuthProvider` 接口 + `auth/local.ts`（argon2 + 会话 JWT，`jose`）。
- `server/context.ts` 认证中间件 → `RequestContext{tenant,user,role}`。
- **验收**：跨租户数据不可见的测试；登录签发/校验 token。

## S8 RBAC 三角色 + 授权融合（P2）

- `auth/rbac.ts` 角色权限矩阵 + API 鉴权中间件。
- Policy 融合：审批权=管理员、集群 ACL=`tenant_clusters`；定时变更授权按角色。
- 管理接口：租户管理员管本租户用户、平台管理员管租户。
- **验收**：各角色越权被拒、审批权限正确的测试。

## S9 SSO 对接（P3）

- `auth/oidc.ts` `OidcAuthProvider`（`openid-client`，Authorization Code + PKCE）。
- claims/groups → tenant/role 映射配置；JIT 建号；本地/SSO 配置切换。
- **验收**：用测试 IdP（如 keycloak/dex）走通登录回调与映射。

## S10 增强

- E2B Desktop/浏览器工具（computer-use → CDP）。
- 审批门交互（暂停 loop、推 diff、确认续跑）。
- warm pool 预热沙箱。

---

## 当前进度

- [x] S0 项目脚手架 — package.json/tsconfig/config 加载(JSONC+env)/pino 日志/vitest
- [x] S1 模型层 + Agent 循环 — 双协议 adapter、ToolRegistry、runAgent loop；typecheck 通过、5 测试通过
- [x] S2 工具系统 + E2B 沙箱 — SandboxProvider 抽象、E2bProvider、SandboxManager（缓存/并发去重/idle GC）、sbx__run_code/run_command 工具；config 加 sandbox 段；13 测试通过
- [x] S3 MCP + Skill — McpManager（stdio/sse/http、mcp__server__tool 命名、单 server 失败隔离）、SkillRegistry（扫描 SKILL.md、frontmatter、summaries 注入、load_skill 渐进式展开）；示例 skill；21 测试通过
- [x] S4 多集群运维 + Policy — ClusterRegistry、classifyKubectl（读写/危险分类，前置 flag 跳过）、kubectl 工具（in-cluster 沙箱执行/dryRun）、OpsPolicy（读写分离/危险拦截/生产审批/preApproved/危险 shell）、AuditSink（Log/Memory）；35 测试通过
- [x] S5 持久化（MySQL）— config/mysql.ts（env+base64）、Store 抽象、MemoryStore 回落、MysqlStore（Kysely+mysql2）、schema.sql 迁移；audit tee 到日志+Store；config/mysql 与 MemoryStore 单测 + DB 集成测试（MYSQL_HOST 时运行）；42 通过/1 跳过
- [x] S6 定时任务 — scheduled_tasks/task_runs 表、cron 工具（UTC）、schedule_task/list/cancel 工具、Scheduler ticker（claimDueTasks 原子领取，MySQL FOR UPDATE SKIP LOCKED）、runtime.ts 抽取、scheduler 常驻模式；并发不重复/错误记录等单测；50 通过/1 跳过
- [x] S7 多租户 + 会话隔离 + 本地认证 — RequestContext 贯穿 Store（各表 tenant_id、强制按租户过滤）、tenants/users 表、scrypt 口令哈希、LocalAuthProvider（jose HS256 JWT login/authenticate）、server/context 认证中间件；跨租户隔离 + 登录签发/校验/伪造拒绝单测；59 通过/1 跳过（注：用 scrypt 替代 argon2 以免原生依赖）
- [x] S8 RBAC 三角色 + 授权融合 — auth/rbac.ts（权限矩阵 + can/requirePermission/canManageUsersOf）、auth/admin.ts（租户/用户管理带 RBAC）、OpsPolicy 融合（cluster:write 权限、管理员审批权自动放行、集群 ACL 按租户）、schedule preApproved 限管理员；越权/审批/ACL 单测；67 通过/1 跳过
- [x] S9 SSO 对接 — auth/session.ts（共享会话 JWT，Local/Oidc 复用）、auth/oidc-map.ts（claims→tenant/role 纯映射）、auth/oidc.ts（OidcAuthProvider：openid-client Authorization Code+PKCE、JIT 建号、本系统会话 token）、config.auth 切换 local/oidc；映射/JIT/会话单测（真实 IdP 流程留待联调）；73 通过/1 跳过
- [x] S10 增强 — 审批门（ApprovalGate：AutoApprove/AutoDeny/Callback，core.ts 接入，CLI 批准/调度拒绝）、WarmPool 预热池（acquire+异步补位，接入 SandboxManager）、远端桌面/浏览器工具（desktop/browser 抽象 + E2bDesktopProvider + browser_navigate/click/type/screenshot/stream_url）；审批/预热/浏览器单测；79 通过/1 跳过
- [x] S11 HTTP + SSE 服务 + 收尾 — node:http 无状态服务（健康检查/本地登录/OIDC start+callback 走签名 cookie 保持无状态/agent SSE 流式+会话续接+落库/定时任务/审计/租户用户管理，鉴权融合 RBAC）、CLI 增加 serve / seed-admin（引导首个平台管理员）/ scheduler、CLI 与调度器均接入会话历史续接、命名空间白名单在 OpsPolicy 强制（allowNamespaces：禁 --all-namespaces、须显式 -n 且在白名单内）；HTTP 集成测试 + 命名空间白名单单测；91 通过/1 跳过

> 仍未完成（需真实环境或后续迭代）：交互式审批 diff/暂停-续跑；computer-use 视觉闭环（内部消息格式仍为纯文本，无多模态）；版本化迁移框架（当前仅 CREATE IF NOT EXISTS）；usage/token 计量落库；部署物（Dockerfile/k8s manifest/in-cluster E2B 模板与 SA 绑定）；E2B/MySQL/OIDC 真实环境联调。
