# AIoP 设计文档

本目录全部文档以 2026-07-31 当前代码为基线。01～10 章描述现状，11 章记录尚未实现的演进项，12 章记录 Pi 集成完成后的最终模块化结果；历史迁移过程不再作为当前设计。

## 阅读顺序

1. [系统总览](./01-system-overview.md)
2. [Agent Runtime](./02-agent-runtime.md)
3. [模型与上下文](./03-model-and-context.md)
4. [工具、Skill 与 MCP](./04-tools-skills-mcp.md)
5. [Sandbox 与运维](./05-sandbox-and-ops.md)
6. [认证、安全与多租户](./06-auth-security-tenancy.md)
7. [数据与持久化](./07-data-and-persistence.md)
8. [Scheduler](./08-scheduler.md)
9. [HTTP API 与 Web](./09-api-and-web.md)
10. [部署与可观测性](./10-deployment-observability.md)
11. [演进路线与已知限制](./11-evolution-roadmap.md)
12. [Pi 集成与 Agent Platform 模块化设计](./12-pi-integration-plan.md)

开发者可直接阅读[代码走读](../guide/code-walkthrough.md)，运维人员使用[Pi Agent Platform 操作说明](../pi-agent-platform-operations.md)。

## 按任务选择文档

| 你要处理的问题 | 先读 | 再核对源码 |
| --- | --- | --- |
| 修改一次 Agent Run 的生命周期 | 02、03、07 | `packages/pi-runtime/src/run/`、`packages/pi-runtime/src/pi/` |
| 新增或治理 Tool | 04、06 | `packages/pi-runtime/src/tools/`、`src/tools/`、`src/agent/tools.ts` |
| 接入 MCP、Skill 或 Sandbox | 04、05 | 对应工作区包与 `src/runtime.ts` |
| 修改登录、权限或租户隔离 | 06、07 | `src/auth/`、`src/server/context.ts`、`src/db/` |
| 修改定时任务或恢复 | 08、02 | `packages/scheduler-runtime/`、`src/scheduler/` |
| 修改 API、SSE 或 Web | 09 | `src/server/http.ts`、`web/src/`、HTTP/Web tests |
| 构建、部署或排障 | 10 | `Makefile`、`deploy/`、`src/index.ts` |
| 评估下一阶段重构 | 11、12 | 当前源码规模、测试和部署约束 |

每篇文档中的路径是“从哪里开始读”，不是完整调用图。接口和行为发生冲突时，优先级始终是 migration/配置 → public contract → 实现 → tests → 设计文档。

## 当前五个工作区包

| 包 | 设计入口 |
| --- | --- |
| `@aiop/control-contracts` | 身份、Run、Interaction、Tool、Event、错误的纯契约 |
| `@aiop/pi-runtime` | Pi AgentHarness/Session 适配、Durable Run、治理与 Store |
| `@aiop/mcp-runtime` | MCP 连接、租户作用域、重连与 Tool adapter |
| `@aiop/sandbox-runtime` | Sandbox Provider、生命周期、Profile、Desktop 与 Tool adapter |
| `@aiop/scheduler-runtime` | Cron、Fire、claim、Run 绑定与恢复 |

五个包版本均为 `0.1.0-preview.1`，Node.js 基线均为 `>=22.19.0`。包的精确 export 以各自 `src/index.ts` 与 `package.json` 为准。

## 所有权术语

- **Pi 复用**：行为由 Pi 公开 API 提供，AIoP 不复制实现。
- **AIoP 薄适配**：稳定 codec、storage 或 product bridge，不成为第二套执行引擎。
- **AIoP 自研**：Pi 不提供的 durable、多租户、治理和产品能力。
- **外部系统**：模型 Provider、MCP Server、AIOS/OpenSandbox、Kubernetes、MySQL、OIDC。

## 当前源码地图

| 领域 | 路径 |
| --- | --- |
| Composition root | `src/runtime.ts` |
| HTTP/SSE | `src/server/http.ts` |
| 产品 Agent/Run Center/Projection | `src/agent/` |
| 产品 Tool | `src/tools/` |
| 产品 Skill 治理 | `src/skill/` |
| Scheduler 应用装配 | `src/scheduler/` |
| 数据库与基线迁移 | `src/db/`、`src/db/migrations/0001_baseline.sql` |
| Web | `web/src/` |
| Staging manifests | `deploy/dev-k8s/` |
| 构建、部署、回滚 | `Makefile` |

## 事实与证据规则

- 依赖版本以 `package.json`、lockfile 和包 manifest 为准。
- 数据结构以 `src/db/migrations/` 为准。
- API 以 `src/server/http.ts` 和 HTTP tests 为准。
- 部署命令以 `Makefile` 为准，不从历史文档复制命令。
- 未实际执行的备份、部署、验收或回滚必须标记为“待执行”，不能写成已完成证据。
- 临时 evidence 写入仓库 `dist/`，不提交仓库。
