# AIoP 设计文档

> 状态：当前设计
> 验证基线：`b5425a0d2ae3ddc23ada4d3184d4a95e3a717bae`
> 最后核对：2026-08-03
> 适用范围：`pi-agent-platform-integration` 当前实现

本目录以当前实现为主，不以迁移过程或目标蓝图代替源码事实；明确标记为“目标设计”的文档除外。系统级术语、唯一模块职责表和唯一全量目录树见 [01 系统总览](./01-system-overview.md)。

## 事实优先级

发生冲突时按以下顺序核对：

1. 数据迁移与运行配置：`src/db/migrations/`、`deploy/`、实际配置 schema。
2. 公共契约：`packages/control-contracts/` 与各工作区包的 `package.json`、`src/index.ts`。
3. 当前实现：`src/`、`packages/`、`web/src/`。
4. 自动化测试：`tests/`。
5. 当前实现设计文档：`docs/design/01`～`13`（不含已删除的旧第 12 篇）；目标蓝图见明确标记状态的后续文档。
6. 历史文档与生成物只作背景或快照，不作为当前行为的首要证据。

依赖版本以根目录及 `web/` 的 lockfile 为准；API 行为以 `src/server/http.ts` 和 HTTP tests 为准；部署事实以 `deploy/k8s/`、`deploy/dev-k8s/` 与 `Makefile` 为准。

## 01～14 文档职责

| 编号 | 文档 | 唯一职责 |
| --- | --- | --- |
| 01 | [系统总览](./01-system-overview.md) | 系统边界、三层架构图、唯一模块职责表、唯一全量目录树、技术选型与主请求时序 |
| 02 | [Agent Runtime](./02-agent-runtime.md) | `DurableRunRuntime`、`DurableRunManager`、Attempt、Lease/Fencing、等待与恢复语义 |
| 03 | [模型与上下文](./03-model-and-context.md) | Model Provider、Pi Session Tree、上下文与 committed path |
| 04 | [工具、Skill 与 MCP](./04-tools-skills-mcp.md) | Governed Tool Execution、Skill、MCP 与 `ToolExecutionOutcome` |
| 05 | [Sandbox 与运维](./05-sandbox-and-ops.md) | Sandbox Provider、Sandbox Generation、Desktop 与运行维护边界 |
| 06 | [认证、安全与多租户](./06-auth-security-tenancy.md) | 身份、RBAC、租户隔离、Secret、策略与审计 |
| 07 | [数据与持久化](./07-data-and-persistence.md) | `MysqlStore`/`MemoryStore`、事务、数据模型与 product session projection |
| 08 | [Scheduler](./08-scheduler.md) | Scheduler Fire、确定性 Run 绑定与 bound Run recovery |
| 09 | [HTTP API 与 Web](./09-api-and-web.md) | HTTP/SSE、Web、Run Center、interaction-specific resume 与接口边界 |
| 10 | [部署与可观测性](./10-deployment-observability.md) | Kubernetes 拓扑、配置、健康检查、日志指标与部署限制 |
| 11 | [演进路线与已知限制](./11-evolution-roadmap.md) | 未实现能力、已知风险、验证缺口与渐进演进项 |
| 12 | [HTTP API Reference](./12-http-api-reference.md) | HTTP 路由、认证、请求/响应、SSE 和错误契约的字段级参考 |
| 13 | [Configuration Reference](./13-configuration-reference.md) | 环境变量、配置文件与部署参数的字段级参考 |
| 14 | [AIOS 嵌入与统一权限体系](./14-aios-unified-auth.md) | AIOS 单点登录、影子用户、角色映射和 UPMS 定期对账的目标设计 |

旧 `12-pi-integration-plan.md` 已删除；其历史版本由 Git 保留，不作为当前架构入口。

## 文档状态

- **current**：`docs/design/01`～`13`（不含已删除的旧第 12 篇），描述本页验证基线上的当前实现或明确标记的演进项。
- **target design**：`docs/design/14-aios-unified-auth.md`，描述已确认但尚未全部实现的 AIOS 统一权限目标蓝图。
- **historical**：`docs/superpowers/specs/`、`docs/superpowers/plans/` 等迁移设计和实施记录，只用于理解决策背景；其中旧组件名不代表当前组件。
- **generated**：`docs/public-api/` 等由工具生成或校验的公共 API snapshot，用于发布面比对，不替代实现、契约源码或设计说明。

## 源码入口地图

| 关注点 | 首要入口 | 补充证据 |
| --- | --- | --- |
| 进程与命令入口 | `src/index.ts` | `package.json` |
| 应用装配 | `src/runtime.ts` | `packages/*/src/index.ts` |
| Durable Pi Run | `packages/pi-runtime/src/run/`、`packages/pi-runtime/src/pi/` | `packages/control-contracts/src/run.ts` |
| HTTP/SSE 与产品投影 | `src/server/http.ts`、`src/agent/projections.ts` | `tests/http*.test.ts` |
| Governed Tool Execution | `src/tools/governance.ts`、`packages/pi-runtime/src/tools/` | `packages/control-contracts/src/tool.ts` |
| Skill、MCP、Sandbox | `src/skill/`、`packages/mcp-runtime/`、`packages/sandbox-runtime/` | `skills/`、对应 tests |
| Scheduler | `src/scheduler/runner.ts`、`packages/scheduler-runtime/` | `tests/scheduler*.test.ts` |
| Store 与迁移 | `src/db/`、`src/db/migrations/0001_baseline.sql` | `tests/db.test.ts`、Store tests |
| Web | `web/src/` | `web/package.json`、前端 tests |
| 通用与开发部署 | `deploy/k8s/`、`deploy/dev-k8s/` | `Makefile`、manifest tests |

## 使用边界

设计文档解释架构意图、当前职责和证据边界，但不替代：

- 操作手册：部署、配置、回滚和排障使用 `docs/pi-agent-platform-operations.md` 与 `Makefile`。
- 公共 API snapshot：发布面的精确声明使用 `docs/public-api/`，并以包源码、export 和校验脚本为准。
- 自动化验证：任何可用性、恢复、高可用或兼容性结论都需要对应测试、部署或演练证据；文档中的拓扑不等于已验证 SLA。
