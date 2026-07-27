# Pi Agent Platform 仓库完成证据

日期：2026-07-27

分支：`feature/pi-agent-platform-integration`

## 结论

Pi Agent Platform 的仓库开发范围已覆盖 Durable Run/Attempt/Turn、Pi Kernel、上下文压缩、事务化 Interaction/Ledger、并发与配额、Sandbox Provider、replay/dry-run、公共包发布门禁和结构化可观测性。

本报告只记录源代码和命令可证明的事实，不代表生产迁移完成。阶段 8 与阶段 10，以及阶段 7 的真实生产灰度指标，仍属于外部待办。

## 实施提交

| 范围 | 提交 |
| --- | --- |
| Durable limits、deadline、bounded events、shutdown | `bb9fe2ce` |
| Pi context management | `f8c1d62e` |
| Interaction/Ledger Turn transaction | `0c9d7b4c` |
| Tool concurrency and quotas | `3470be54` |
| Standalone OpenSandbox/E2B providers | `c797b150` |
| Replay/dry-run semantics | `c26cf613` |
| Publishable packages and API gates | `b3faeaa2` |

Task 8 的 observability、故障矩阵和本文档由本分支后续提交记录。

## Durable observability

- `AgentRunEvent` 强制包含 tenant/run/attempt/turn/kernel/kernelVersion/correlation 身份。
- MySQL 迁移 `0021_agent_run_event_identity.sql` 持久化对应字段；历史 nullable 行由 Adapter 提供明确 legacy fallback。
- 模型 text/thinking delta 仅进入 live observer，不进入 durable event。
- 工具控制事件不保存 arguments 或 result content；compaction 事件只保存 token/message/version 计数。
- Runtime observer 提供 Run、Attempt、Turn timer/counter，以及 lease loss、compaction、tool、waiting、recovery 和 SSE replay 计数。
- Observer 异常被隔离，不改变 durable execution 结果。

## 故障矩阵

2026-07-27 执行：

```bash
npx vitest run --reporter=verbose tests/durable-runtime.test.ts tests/memory-runtime-store.test.ts tests/mysql-runtime-store.test.ts tests/tool-runtime-platform.test.ts tests/http-agent-runs.test.ts tests/pi-observability.test.ts
```

结果：6 个 test files、44 个 tests 全部通过。

| 故障/恢复场景 | 证据用例 |
| --- | --- |
| cancellation | `durably cancels and aborts an active kernel`、Run Center durable cancellation |
| deadline | `persists the deadline and enforces it after a cross-process resume` |
| shutdown | `aborts and awaits all active runs during shutdown` |
| stale fencing / lease loss | Memory stale token/commit tests、MySQL fencing check、structured lease-loss counter |
| transaction rollback | `rolls back every repository when a transaction fails` |
| resume | last committed Turn resume、AIOP Run Center recovery |
| approval/question/plan | 三类 interaction 均由新 Runtime Attempt 恢复并解析 |
| duplicate write | completed idempotent call reuse |
| unknown side effect | non-idempotent unknown write 转 `recovery_required` |
| commit boundary | 外部成功保持 provisional，最终 Ledger fact 随 Turn commit 提交 |
| SSE replay | 严格从 `Last-Event-ID` 后补发并记录 replay counter |

## 发布与 API 门禁

公共包输出 `dist/index.js` 与 `dist/index.d.ts`，API snapshots 位于 `/home/opt/develop/aicoding/aiop/docs/public-api`。`verify:packages` 会构建全部包、检查 API diff、执行 `npm pack --dry-run` 和真实 pack，并在临时非 AIOP 项目安装/导入全部 tarball；tarball 中不得包含 `src/`，跨包依赖必须声明。

## 最终验证

2026-07-27 在本分支新鲜执行：

| 命令 | 结果 |
| --- | --- |
| `make verify-node` | Node 24.13.0，满足 `>=22.19.0` |
| `make test-agent-platform` | 10 files、56 tests 通过；随后包构建/API/tarball 门禁通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 69 files；622 passed、1 skipped |
| `npm --prefix web run build` | TypeScript 与 Vite production build 通过；存在既有大 chunk warning |
| `npm audit --audit-level=high` | 退出 0；0 high/critical，5 moderate，均为已记录的 Pi → Google GenAI → MCP SDK → Hono 链且当前无修复 |
| `npm run verify:packages` | 全部公共包 build、API snapshot、pack、临时项目安装与动态 import 通过 |
| `git diff --check` | 通过 |
| `make image` | 退出 0；镜像 `aiop:pi-agent-platform` 构建成功，容器公共包 import 输出 `workspace-ok`，容器 Node 24.18.0 通过基线 |

Docker 构建期间同样报告 5 个 moderate 漏洞以及待 allowScripts 复核的 `@google/genai`、`esbuild`、`protobufjs` 安装脚本；本次构建没有把这些警告误记为 high/critical 或伪造为已修复。

## 明确未完成的生产事项

| 阶段 | 未完成证据 | 完成前禁止事项 |
| --- | --- | --- |
| 7 | 真实生产灰度阈值、持续窗口、安全事件与成本/延迟指标 | 不得声称生产灰度验收通过 |
| 8 | 一个真实 checkpoint 保留周期内无新 LangGraph Run | 不得声称存量已自然收敛 |
| 10 | 真实备份恢复、历史 audit 查询、生产回滚窗口和清表审批 | 不得 DROP checkpoint 表或提交清表迁移 |

当前仓库只包含 checkpoint 只读保护，不包含删除 `langgraph_checkpoints` 或 `langgraph_checkpoint_writes` 的迁移。
