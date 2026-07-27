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
| Durable observability and fault evidence | `f6ec268e` |
| Delivery/runtime audit、CI、Docker、Run Center summary | `1bb8ffc2` |
| Trusted Interaction resolution contract | `e3dbfe2c` |
| Unified Memory/MySQL Interaction repositories | `4a12c21d` |
| Durable Tool Runtime interactions and shared concurrency | `b0543a96` |
| Pi Kernel interaction resume | `93fc9ad5` |
| AIOP Durable Pi product Tool Runtime | `b6fe2db3` |
| HTTP interaction auto-resume | `a2cd36ca` |

最终交付审计、共享模型并发控制、Run Center Attempt/Turn 展示和本文档的收口由本分支后续提交记录。

## 并发与配额

- Tool Runtime 按可信 tenant、tool 和 resource key 使用 FIFO semaphore，并在成功、失败和取消路径释放。
- `FifoModelConcurrencyController` 按可信 tenant 与绑定后的 provider/model/route 限制模型流并发；AIOP 长生命周期 Runtime 持有一个共享实例，覆盖其创建的全部 Durable Pi Runtime。
- 模型许可只覆盖 `ModelProvider.stream()` 的消费期，工具阶段不持有模型许可。
- `AIOP_PI_MAX_CONCURRENT_MODEL_CALLS` 默认 `4`；相同 tenant/model FIFO 排队，不同 tenant/model 相互独立；provider 失败和排队取消均有回归测试。
- AIOP 同一长生命周期 Runtime 还共享 `ToolConcurrencyController`；tenant/tool/resource 默认上限分别为 `8/4/1`，环境变量必须是正整数。
- `RunLimits.maxAttempts` 复用现有 TurnSnapshot `limits_json` 持久化，恢复前按已持久化 Attempt 数量拒绝超限，不修改历史迁移。
- approval/question/plan 都通过持久化 Interaction 跨进程等待与恢复；可信 resolution 在模型再次调用前消费，并替换原 `waiting:<interactionId>` 工具结果。
- HTTP Interaction resolve 在完成身份、会话、Run、toolCall 与冲突校验后异步触发恢复；重复同值 resolve 幂等，冲突值拒绝，pending Interaction 不能由显式 resume 绕过。

## BR-01～BR-07 最终审计

| 要求 | 仓库证据 |
| --- | --- |
| BR-01 工具不能直连基础设施/凭据 | Durable Pi 只注入 `/home/opt/develop/aicoding/aiop/src/agent/pi/tool-runtime.ts`，由产品 Registry、Policy、Hook 与 Provider 执行 |
| BR-02 长度截断不执行工具 | `/home/opt/develop/aicoding/aiop/tests/pi-contract.test.ts` 的 length-truncated 工具阻断用例 |
| BR-03 只读受限并行、写/资源默认串行 | `/home/opt/develop/aicoding/aiop/packages/tool-runtime/src/index.ts` FIFO semaphore 与 failure/cancel release 用例 |
| BR-04 tenant/tool/resource 并发限制 | 共享 `ToolConcurrencyController` 跨 fresh Engine 测试及 AIOP 三项正整数环境变量 |
| BR-05 stable idempotency/correlation | approval fresh Runtime 恢复复用原 idempotency key；durable event 保留 correlation identity |
| BR-06 未知非幂等结果禁止重放 | `recovery_required` Ledger 与 Pi/Runtime 故障测试 |
| BR-07 可信 IdentityContext | Runtime 从 Store/调用方传递 tenant/actor/roles/session，Interaction resolve 校验 tenant/user/session/run/toolCall |

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
npx vitest run --reporter=verbose tests/durable-runtime.test.ts tests/memory-runtime-store.test.ts tests/mysql-runtime-store.test.ts tests/tool-runtime-platform.test.ts tests/http-agent-runs.test.ts tests/pi-observability.test.ts tests/pi-contract.test.ts tests/agent-runtime.test.ts
```

结果：8 个 test files、72 个 tests 全部通过。

| 故障/恢复场景 | 证据用例 |
| --- | --- |
| cancellation | `durably cancels and aborts an active kernel`、Run Center durable cancellation |
| deadline | `persists the deadline and enforces it after a cross-process resume` |
| shutdown | `aborts and awaits all active runs during shutdown` |
| stale fencing / lease loss | Memory stale token/commit tests、MySQL fencing check、structured lease-loss counter |
| transaction rollback | `rolls back every repository when a transaction fails` |
| resume | last committed Turn resume、AIOP Run Center recovery |
| approval/question/plan | 三类 interaction 均由新 Runtime Attempt 恢复并解析 |
| HTTP auto-resume | resolve 返回后异步创建新 Attempt；重复同值幂等、冲突值拒绝、session busy 与失败事件脱敏 |
| duplicate write | completed idempotent call reuse |
| unknown side effect | non-idempotent unknown write 转 `recovery_required` |
| commit boundary | 外部成功保持 provisional，最终 Ledger fact 随 Turn commit 提交 |
| model concurrency | 跨新 Pi Kernel 与新 Durable Runtime 的 tenant/model FIFO；provider 失败和排队取消释放许可 |
| SSE replay | 严格从 `Last-Event-ID` 后补发并记录 replay counter |

## 发布与 API 门禁

公共包输出 `dist/index.js` 与 `dist/index.d.ts`，API snapshots 位于 `/home/opt/develop/aicoding/aiop/docs/public-api`。`verify:packages` 会构建全部包、检查 API diff、执行 `npm pack --dry-run` 和真实 pack，并在临时非 AIOP 项目安装/导入全部 tarball；tarball 中不得包含 `src/`，跨包依赖必须声明。

## Run Center Web

- 列表直接展示后端返回的 Attempt/Turn 数量摘要，详情指标展示完整数量。
- 详情页提供 `Attempts` 与 `Committed Turns` 标签，展示 Attempt 状态、Kernel 版本、Turn 编号、Commit、stop reason 和持久化时间。
- 标签栏在窄详情面板内横向滚动；源码合约、Web production build，以及 headless Chrome 桌面/窄屏渲染与实际标签点击均已验证。

## CI、部署与可复现镜像

- `/home/opt/develop/aicoding/aiop/.gitlab-ci.yml` 使用 Node 24 执行 Node、Agent Platform、typecheck、全量测试、Web build、依赖审计和公共包门禁。
- Docker-in-Docker job 执行 `make image`，包含公共包 import 和容器 Node 基线 smoke checks。
- Docker builder stage 显式运行 `npm run build:packages`；runtime stage 从 builder 复制已构建 packages。
- `/home/opt/develop/aicoding/aiop/.dockerignore` 排除宿主 `packages/*/dist`。清理构建上下文后镜像仍可构建，证明不依赖本地生成物。
- development K8s 清单的新 Run 使用 `AIOP_AGENT_KERNEL=pi` 与 `AIOP_PI_MODE=full`，不再保留可执行 LangGraph 配置。

## 最终验证

2026-07-27 在本分支新鲜执行：

| 命令 | 结果 |
| --- | --- |
| `make verify-node` | Node 24.13.0，满足 `>=22.19.0` |
| `make test-agent-platform` | 12 files、83 tests 通过；随后包构建/API/tarball 门禁通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 71 files；666 passed、1 skipped |
| `npm --prefix web run build` | TypeScript 与 Vite production build 通过；存在既有大 chunk warning |
| `npm audit --audit-level=high` | 退出 0；0 high/critical，5 moderate，均为已记录的 Pi → Google GenAI → MCP SDK → Hono 链且当前无修复 |
| `npm run verify:packages` | 全部公共包 build、API snapshot、pack、临时项目安装与动态 import 通过 |
| `git diff --check` | 通过 |
| `make image` | 退出 0；builder 内生成公共包 dist，镜像 `aiop:pi-agent-platform` 构建成功，容器公共包 import 输出 `workspace-ok`，容器 Node 24.18.0 通过基线 |

Docker 构建期间同样报告 5 个 moderate 漏洞以及待 allowScripts 复核的 `@google/genai`、`esbuild`、`protobufjs` 安装脚本；本次构建没有把这些警告误记为 high/critical 或伪造为已修复。

## 明确未完成的生产事项

| 阶段 | 未完成证据 | 完成前禁止事项 |
| --- | --- | --- |
| 7 | 真实生产灰度阈值、持续窗口、安全事件与成本/延迟指标 | 不得声称生产灰度验收通过 |
| 8 | 一个真实 checkpoint 保留周期内无新 LangGraph Run | 不得声称存量已自然收敛 |
| 10 | 真实备份恢复、历史 audit 查询、生产回滚窗口和清表审批 | 不得 DROP checkpoint 表或提交清表迁移 |

当前仓库只包含 checkpoint 只读保护，不包含删除 `langgraph_checkpoints` 或 `langgraph_checkpoint_writes` 的迁移。
