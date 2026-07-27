# AIoP

AIoP 是一个面向智能运维与平台工程场景的 Agent 应用平台。它将模型、Agent Runtime、工具安全链、Skill、MCP、Sandbox、定时任务和多租户 Web 控制台组装为一套可扩展的运行系统。

项目后端基于 Node.js、TypeScript 和 Pi Agent Core，前端基于 React 与 Vite。系统既可以作为 HTTP/SSE 服务运行，也支持命令行单次任务和独立调度器模式。

## 核心能力

- 可切换的 Legacy/Pi Kernel，以及 Run、Attempt、Turn Snapshot/Commit、恢复和取消机制。
- Anthropic 与 OpenAI 协议模型适配，支持自定义模型地址、上下文管理和 Token/成本统计。
- 统一 Tool Broker，集中处理权限规则、审批、PreToolUse Hook、审计和工具执行账本。
- 内置工具、Skill 和 MCP Server 扩展体系。
- Local、E2B 和 OpenSandbox 三种沙箱后端，以及浏览器、文件导出和 Kubernetes 运维能力。
- Local、OIDC 和 AIOS 嵌入认证，多租户 RBAC 与敏感设置加密。
- Memory/MySQL Store、Cron 调度、运行中心和 React 管理控制台。

## 快速开始

### 环境要求

- Node.js 22.19.0 或更高版本
- npm
- 可用的 Anthropic、OpenAI 或兼容模型服务
- MySQL（可选；未配置时使用进程内 Memory Store）

### 安装依赖

```bash
npm install
npm --prefix web install
```

### 准备配置

复制示例配置，并按实际模型服务修改 `models` 和 `defaultModel`：

```bash
cp config.example.jsonc config.jsonc
export ANTHROPIC_API_KEY='your-api-key'
# 或使用 OPENAI_API_KEY 及对应的 OpenAI 协议模型配置
```

`config.jsonc` 已被 Git 忽略，不要把真实密钥提交到仓库。也可以通过 `AIOP_CONFIG` 指定其他配置文件：

```bash
export AIOP_CONFIG=/absolute/path/to/config.jsonc
```

### 启动本地服务

终端一，启动后端 HTTP/SSE 服务：

```bash
npm run dev -- serve
```

后端默认监听 `http://127.0.0.1:8080`，可通过 `HOST` 和 `PORT` 调整。

终端二，启动 Web 开发服务器：

```bash
npm --prefix web run dev
```

访问 `http://127.0.0.1:5173`。Vite 会把 `/auth`、`/v1`、`/healthz` 和 `/readyz` 代理到本地后端。

### 创建本地管理员

使用 Local 认证时，可以通过以下命令引导首个平台管理员：

```bash
npm start -- seed-admin default admin 'change-this-password'
```

## 运行模式

| 模式 | 命令 | 用途 |
| --- | --- | --- |
| HTTP/SSE 服务 | `npm run serve` | 提供认证、Agent、管理 API 和流式事件 |
| 开发监听 | `npm run dev -- serve` | 监听后端源码变化并重启服务 |
| 独立调度器 | `npm run scheduler` | 领取并执行到期的 Cron 任务 |
| CLI 单次任务 | `npm start -- "检查当前环境"` | 在本地直接执行一次 Agent 任务 |
| 管理员引导 | `npm start -- seed-admin <tenant> <user> <password>` | 为 Local 认证创建首个平台管理员 |

服务健康检查：

```bash
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
```

## 常用配置

完整配置示例见 [`config.example.jsonc`](./config.example.jsonc)，配置 Schema 见 [`src/config/schema.ts`](./src/config/schema.ts)。常见环境变量包括：

| 环境变量 | 说明 |
| --- | --- |
| `AIOP_CONFIG` | JSON/JSONC 配置文件路径，默认 `./config.jsonc` |
| `HOST` / `PORT` | HTTP 服务监听地址和端口，默认 `0.0.0.0:8080` |
| `AIOP_AGENT_KERNEL` | `legacy`、`pi` 或 `tenant-rule`；历史 LangGraph Run 仅可查询 |
| `AIOP_PI_MODE` | `full`、`read-only`、`dry-run`、`replay` 或 `disabled`；`disabled` 立即回退 Legacy |
| `AIOP_PI_TEST_TENANTS` / `AIOP_PI_INTERNAL_USERS` | `tenant-rule` 的 Pi tenant/user 灰度名单 |
| `AIOP_PI_READ_ONLY_SESSIONS` / `AIOP_PI_FULL_SESSIONS` | `tenant-rule` 的只读/完整流量 session 名单 |
| `AIOP_EMBED_SCHEDULER` | 是否在 HTTP 服务进程内启动调度器 |
| `AIOP_JWT_SECRET` | JWT 签名密钥，生产环境必须使用强随机值 |
| `AIOP_SETTINGS_SECRET` | 持久化敏感设置的加密密钥，不得与 JWT 密钥复用 |
| `MYSQL_HOST` 等 | MySQL 连接配置；未设置 `MYSQL_HOST` 时回退 Memory Store |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 示例模型配置使用的 API Key |

## 项目结构

```text
src/
  agent/       Agent Runtime、Kernel、运行协调和工具安全链
  auth/        Local、OIDC、AIOS 认证与 RBAC
  config/      配置加载和 Schema
  db/          Store、MySQL、Memory 和数据库迁移
  mcp/         MCP Server 生命周期与工具映射
  sandbox/     Local、E2B、OpenSandbox 和桌面能力
  scheduler/   Cron 调度与任务领取
  server/      HTTP、SSE、下载和请求上下文
  skill/       Skill 扫描、导入和管理
  tools/       内置工具适配器
web/           React Web 控制台
tests/         单元、集成和行为回归测试
deploy/        Kubernetes 与 OpenSandbox 部署资源
docs/          设计文档和代码走读
packages/      可组合 Agent Platform 公共包
examples/      不依赖 AIOP HTTP/Auth/MySQL 的嵌入示例
```

Pi Agent Platform 的迁移、灰度和回滚说明见 [`docs/pi-agent-platform-operations.md`](./docs/pi-agent-platform-operations.md)，独立嵌入示例见 [`examples/pi-agent-platform.ts`](./examples/pi-agent-platform.ts)。

`src/runtime.ts` 是后端组件装配中心，`src/index.ts` 定义各进程入口，`src/server/http.ts` 是 HTTP/SSE 协议入口，`src/db/store.ts` 是持久化能力契约。

## 开发与验证

```bash
# 后端类型检查
npm run typecheck

# 后端测试
npm test

# Web 生产构建
npm --prefix web run build
```

依赖版本以根目录 [`package.json`](./package.json) 和 [`web/package.json`](./web/package.json) 为准。

## 部署

构建后端和 Web 镜像：

```bash
docker build -t aiop:latest .
docker build -f web/Dockerfile -t aiop-web:latest .
```

Kubernetes 生产拓扑、Secret、部署顺序和管理员引导说明见 [`deploy/k8s/README.md`](./deploy/k8s/README.md)。本地开发集群示例见 [`deploy/dev-k8s/README.md`](./deploy/dev-k8s/README.md)，OpenSandbox 部署见 [`deploy/opensandbox/README.md`](./deploy/opensandbox/README.md)。

## 文档

- [代码走读：从启动到一次 Agent Run](./docs/guide/code-walkthrough.md)
- [设计文档总入口](./docs/design/README.md)
- [系统总览](./docs/design/01-system-overview.md)
- [Agent Runtime](./docs/design/02-agent-runtime.md)
- [工具、Skill 与 MCP](./docs/design/04-tools-skills-mcp.md)
- [部署与可观测性](./docs/design/10-deployment-observability.md)

设计文档用于解释系统边界和阅读路径；运行行为、公共接口、配置 Schema、数据库迁移和测试始终以当前源码为准。
