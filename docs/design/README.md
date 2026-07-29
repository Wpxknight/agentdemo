# AIoP 设计文档

本目录的 01～10 章描述当前实现；11～12 章是演进背景与实施计划，阅读时必须以当前源码和本文索引为准。

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

开发者可直接阅读[代码走读](../guide/code-walkthrough.md)，运维人员使用[Pi Agent Platform 操作说明](../pi-agent-platform-operations.md)。

## 当前五包

| 包 | 设计入口 |
| --- | --- |
| `packages/control-contracts` | 身份、Run、Interaction、Tool、Event、错误 |
| `packages/pi-runtime` | Pi 薄适配、Durable Run、Governance、Store |
| `packages/mcp-runtime` | MCP 连接、可见性、凭据和 Tool adapter |
| `packages/sandbox-runtime` | Sandbox Provider、生命周期、Profile、Desktop |
| `packages/scheduler-runtime` | Cron、Fire、claim、dispatch、recovery |

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
| 数据库与迁移 | `src/db/` |
| Web | `web/src/` |
| Staging manifests | `deploy/dev-k8s/` |
| 构建、部署、回滚 | `Makefile` |

## 事实与证据规则

- 依赖版本以 `package.json`、lockfile 和包 manifest 为准。
- 数据结构以 `src/db/migrations/` 为准。
- API 以 `src/server/http.ts` 和 HTTP tests 为准。
- 部署命令以 `Makefile` 为准，不从历史文档复制命令。
- 未实际执行的备份、部署、验收或回滚必须标记为“待执行”，不能写成已完成证据。
- 临时 evidence 写入 `/home/opt/develop/aicoding/aiop/dist/`，不提交仓库。
