# 基于 Boclaw 改造实现 aiop 类智能体的技术选型调研

> 调研日期：2026-07-16  
> aiop 基线：`/home/opt/develop/aicoding/aiop`，分支 `feature/aios-integration`，HEAD `0b4e941`  
> Boclaw/BoBot 基线：`/home/opt/develop/aicoding/boclaw/bocloud-ai-boclaw`，包版本 `0.2.71`  
> 结论性质：架构选型建议，不是详细实施计划  
> 证据优先级：当前源码 > 当前测试 > 仓库设计文档 > 经验估算

---

## 1. 结论先行

### 1.1 核心结论

**如果目标是实现“类似当前 aiop 的企业级 Web 智能体平台”，不建议以 `bocloud-ai-boclaw` 为主仓整体改造。**

推荐路线是：

> **保留 aiop 作为控制面、身份安全边界、会话持久化层和沙箱编排层；从 Boclaw 中抽取成熟的 Agent 算法与编码能力，形成共享 SDK；需要完整 Coding Agent 时，将 Boclaw Runtime 运行在独立 Runner/沙箱中，而不是直接嵌入 aiop Web API 进程。**

这不是否定 Boclaw。Boclaw 的 Agent 能力明显比 aiop 更丰富、更接近成熟 Coding Agent；问题在于它的主要架构假设是“单用户、本地工作区、长生命周期 Node/CLI/桌面进程”，而 aiop 的核心假设是“多用户、服务端、租户隔离、持久化、可审计、沙箱执行、可水平扩展”。两者最有价值的部分位于不同层次。

### 1.2 什么情况下建议直接基于 Boclaw

| 目标产品 | 是否建议以 Boclaw 为底座 | 原因 |
|---|---:|---|
| 本地 Coding Agent CLI | **建议** | Boclaw 已有完整 CLI、文件/Shell/Git/LSP、会话、上下文压缩和子代理能力。 |
| Electron/桌面 Coding Agent | **建议** | SDK、桌面工具、原生依赖和 Boclaw host 注入接口已围绕该形态设计。 |
| 单租户、单实例、内部研发助手 | **有条件建议** | 可接受本机 cwd、Home、环境变量和本地 transcript 语义时，交付快。 |
| 多租户 Web 智能体平台 | **不建议直接改造** | 身份、隔离、持久化、策略、调度和水平扩展需要重构运行时边界。 |
| 企业运维智能体/Kubernetes Agent | **不建议直接改造** | aiop 已有多集群、安全策略、审批、审计和动态沙箱，迁回 Boclaw 会形成倒退。 |
| 同时提供 Web 平台和专业 Coding Agent | **建议混合架构** | aiop 做平台，Boclaw 能力下沉共享 SDK，完整 Coding Agent 进入隔离 Runner。 |

### 1.3 一句话决策

**不是“基于 Boclaw 改造 aiop”，而是“以 aiop 为平台底座，以 Boclaw 为 Agent 能力来源”。**

---

## 2. 调研范围与方法

本次调研检查了两个仓库的：

- package、构建和发布方式；
- Agent 主循环、消息协议、工具分发和流式事件；
- 模型路由、上下文压缩、MCP、Skill 和多模态；
- 身份、租户、RBAC、审批、Hook 和审计；
- 会话、消息、配置、凭据和定时任务持久化；
- 本地工作区、cwd、Home、环境变量和全局状态；
- E2B、OpenSandbox、桌面浏览器和 Kubernetes 执行；
- Web/CLI/UI、容器化与水平扩展边界；
- 测试规模、构建可验证性和维护面。

重点源码包括：

- aiop：`src/agent/core.ts`、`src/runtime.ts`、`src/server/http.ts`、`src/db/store.ts`、`src/agent/policy.ts`、`src/sandbox/`、`src/auth/`；
- Boclaw：`src/agent.ts`、`src/QueryEngine.ts`、`src/query.ts`、`src/tools.ts`、`src/sdk.ts`、`src/services/api/`、`src/utils/permissions/`、`src/utils/sessionStorage.ts`。

本次没有把两边所有工具逐个做行为测试，也没有构建 Boclaw 的 `dist/`。因此本文对 Boclaw 的能力判断来自源码和现有测试，对“当前快照可以直接发布”不作保证。

---

## 3. 两个系统的本质定位

### 3.1 aiop：企业 Web Agent 平台与安全控制面

当前 aiop 已经不是一个简单 Agent Loop，而是一个平台型运行时，主要边界包括：

- provider-neutral 的 Anthropic/OpenAI 消息与工具协议；
- HTTP/SSE 会话交互、终止、提问、审批和下载；
- Tenant/User/RBAC、JWT、OIDC、AIOS token exchange；
- MySQL/Kysely Store 和内存开发 Store；
- 会话、消息、用户、凭据、租户设置和定时任务持久化；
- Policy、Approval、Hook、Audit 和危险操作分类；
- Skill、MCP、Scheduler；
- E2B、OpenSandbox、Local Sandbox、桌面沙箱和 warm pool；
- 用户 Home 目录挂载和租户/用户/会话级沙箱 key；
- 多集群 kubectl 和集群策略护栏；
- Web 管理与聊天界面。

因此，aiop 的主要价值是：**让 Agent 在企业服务端环境中安全、可控、可持久化地运行。**

### 3.2 Boclaw/BoBot：成熟的本地 Coding Agent Runtime

Boclaw 当前同一源码树发布两个 npm 包：

- `@bocloud/bobot-agent-sdk`：进程内 Agent SDK；
- `@bocloud/bobot-cli`：本地终端 CLI。

其主要价值集中在：

- 更成熟的 Coding Agent 主循环；
- 大量文件、Shell、Git、LSP、Worktree、浏览器和桌面工具；
- 自动压缩、reactive compact、token/cost 预算；
- 模型 capability、角色、健康度和 failover；
- 视觉翻译、多媒体生成与协议转换；
- Tool Search/延迟工具发现；
- 子代理、任务、Plan、后台和远程桥接；
- 本地会话恢复、JSONL transcript、CLI/Ink 交互。

因此，Boclaw 的主要价值是：**在一个可信本地进程和工作区内，提供高能力、强交互的 Coding Agent。**

### 3.3 核心错位

```text
aiop 关注：谁在运行、能访问什么、在哪里执行、如何审批、如何审计、如何恢复
                         ↑
                    平台控制面
                         ↓
Boclaw 关注：模型如何推理、如何使用编码工具、如何压缩上下文、如何完成复杂开发任务
                         ↑
                    Agent 能力面
```

直接把 Boclaw 改造成 aiop，需要重写的恰好是 aiop 已经完成较多的部分；直接忽略 Boclaw，又会重复建设它成熟的 Agent 能力。混合架构能避开两边最昂贵的重复劳动。

---

## 4. 客观规模与工程基线

以下数据来自 2026-07-16 当前工作区静态统计：

| 指标 | aiop | Boclaw/BoBot | 说明 |
|---|---:|---:|---|
| TypeScript 源文件 | 83 | 2,117 | Boclaw 包含完整 CLI、UI、工具、服务和大量历史功能。 |
| TypeScript 源码行数 | 约 13,903 | 约 128,305 | 只统计 `src` 下 `.ts/.tsx`。 |
| 直接运行依赖 | 13 | 88 | Boclaw 还带多组 optional/vendor/native 依赖。 |
| 一级工具目录 | 较少，平台工具为主 | 61 | Boclaw 的 Coding/桌面工具覆盖更深。 |
| 测试文件 | 38 个 Vitest 文件 | 16 个 `.mjs` 文件 | 测试组织方式不同，数量不能直接等同质量。 |
| 统一 `test` script | 有 | 无 | Boclaw 测试通常依赖预构建 `dist`。 |
| 统一 `typecheck` script | 有 | 无 | Boclaw `build:sdk` 中 `tsc ... || true` 会吞掉 tsc 失败。 |
| 当前验证结果 | typecheck 通过；429 passed，1 skipped | 未构建时 smoke test 无法启动 | Boclaw 缺少 `dist/tools.js`，不是功能断言失败。 |

这些数据说明两点：

1. Boclaw 提供了远多于 aiop 的成熟功能，值得复用；
2. 把一个 12.8 万行、2,000 多源文件、88 个直接依赖的本地 Agent 产品整体服务化，改造面和回归面都很大。

---

## 5. 能力对比

| 维度 | aiop 当前状态 | Boclaw 当前状态 | 选型判断 |
|---|---|---|---|
| Agent Loop | 结构清晰、provider-neutral、能力较基础 | 成熟复杂，重试/降级/预算/工具链更完整 | 借鉴或抽取 Boclaw 算法，不直接替换平台 Runtime。 |
| 模型协议 | 原生 Anthropic + OpenAI adapter | Anthropic 主链 + OpenAI 网关转换，路由能力丰富 | aiop 的中立协议更适合平台；复用 Boclaw capability/router。 |
| 模型能力目录 | 配置型，较简单 | capability、role、tier、context、vision、failover | 优先抽取。 |
| 上下文治理 | 摘要、硬裁剪、图片保留、重试 | 自动/反应式压缩、预算、失败恢复更成熟 | 优先抽取算法和策略。 |
| Coding 工具 | 主要通过 sandbox 命令和少量平台工具 | 文件、编辑、Shell、Git、LSP、Worktree 等完整 | 完整工具应部署到 Runner 内。 |
| Skill | Registry + sandbox 同步 + 所有权隔离 | 项目/用户 Skill、命令和插件生态成熟 | 共享规范；所有权和执行边界由 aiop 保留。 |
| MCP | 服务端管理、动态重连、租户设置 | 本地/项目配置成熟，工具生态更丰富 | 协议与 catalog 可共享，连接生命周期由宿主控制。 |
| 多模态 | 图片消息、浏览器截图、桌面 | 视觉路由、图像/视频生成更成熟 | 抽取路由和 capability，不引入桌面耦合。 |
| 子代理/任务 | Agent Runtime 仍在演进 | 子代理、Task、Plan、后台能力丰富 | 首先以隔离 Runner 接入，稳定后再抽通用协议。 |
| 多租户 | 原生 tenant/user/role 上下文 | SDK API 没有原生 tenant 安全作用域 | aiop 必须作为身份边界。 |
| 持久化 | 数据库 Store、会话/消息/设置/任务 | `~/.bobot`、JSONL transcript、本地配置 | 保留 aiop；不要移植 Boclaw transcript 为平台主存储。 |
| 权限安全 | Policy + Approval + Hook + Audit + RBAC | 本地 allow/deny/ask、路径规则和 callback | Boclaw 权限可作 Runner 内第二道防线，不能替代平台策略。 |
| 沙箱 | E2B/OpenSandbox/local/desktop、warm pool | 本地 sandbox-runtime 和宿主工具 | aiop 编排沙箱；Boclaw 作为 workload。 |
| Kubernetes 运维 | 多集群、SA、policy、audit | 不是核心强项 | 保留 aiop。 |
| Web/服务化 | HTTP/SSE/Web UI 已存在 | 主 UI 为 Ink/CLI，Web 方案仍需平台改造 | 保留 aiop。 |
| 水平扩展 | 已具备平台形态，仍需完善 lease/checkpoint | 大量进程内状态和本机语义 | 直接嵌入风险高。 |

---

## 6. 为什么不建议整体基于 Boclaw 改造

### 6.1 进程级 cwd 和工作区状态不适合多租户并发

`QueryEngine.submitMessage()` 会调用 `setCwd(cwd)`。Boclaw 源码中还有多处 `process.chdir()`，覆盖 setup、worktree、bridge、session restore 和 UI 流程。

`process.cwd()` 是 Node 进程全局状态。若同一 Web API 进程同时运行用户 A 和用户 B 的会话，即使每个 `Agent` 有独立 options，任何全局 cwd 切换都可能造成：

- 文件工具访问错误租户的工作区；
- Git/LSP/Shell 在错误目录执行；
- 会话恢复和 Worktree 状态串扰；
- 难以通过普通应用层锁彻底证明隔离。

因此完整 Boclaw Runtime 若用于多用户并发，至少应做到“一会话/一任务独立进程或容器”，不能直接共享 aiop API 进程。

### 6.2 Home、环境变量和全局注入仍是本地应用语义

静态扫描显示，Boclaw 中约 207 个源码文件引用 Home 或 `.bobot` 语义，约 403 个文件引用 `process.env`，另有 setup globals、MACRO、Gates 和网关全局注入。

这些机制在单用户 CLI 中合理，但在多租户服务中容易产生：

- 用户配置、token、Skill、MCP 和 transcript 共享；
- per-session 模型/网关设置互相覆盖；
- 测试难以隔离；
- 多副本部署后本地状态不可恢复。

Boclaw 已经为部分网关能力增加 per-agent override，说明团队也在修复全局状态串扰；但这还不是完整的多租户无全局状态架构。

### 6.3 本地权限模型不能充当企业服务端安全边界

Boclaw 的 `canUseTool`、permission mode、allow/deny 规则和路径检查适合“用户本人控制本机 Agent”。企业平台还需要：

- 身份不可由 prompt 或工具参数伪造；
- Tenant/User/Role 贯穿模型、工具、Store 和 Audit；
- 组织策略高于用户偏好；
- 审批与具体 run/tool call 强绑定并可过期；
- 凭据按用户和用途最小注入；
- Runner capability 由服务端签发；
- 生产操作可追责和重放审计。

这些是 aiop 已有的核心资产。若以 Boclaw 为底座，需要重新把它们嵌回 2,000 多个源码文件形成的产品运行时，风险大于在 aiop 中接入 Agent 能力。

### 6.4 会话存储模型不适合平台主存储

Boclaw 的 JSONL transcript、`~/.bobot/projects` 和进程内 `QueryEngine` 非常适合本地产品；平台需要数据库级：

- 租户索引和鉴权过滤；
- 会话/消息事务与 revision；
- 多副本访问；
- 查询取消、租约和恢复；
- retention、归档、合规删除；
- 计费、审计和运营查询。

这些能力如果重新添加到 Boclaw，相当于重建 aiop 的 Store、HTTP 和 Runtime。

### 6.5 SDK 发布面过大

当前 `@bocloud/bobot-agent-sdk` 与 CLI 共用源码和发布面，依赖 Ink、React、OpenTelemetry、桌面/原生工具、vendor MCP、ripgrep 和多平台二进制。

若 aiop Web API 直接依赖完整包，会带来：

- 镜像体积和供应链扫描面扩大；
- 原生依赖和不同 CPU/OS 的兼容问题；
- API 进程加载不需要的 UI/桌面能力；
- 升级时 CLI、SDK、桌面和服务端回归绑在一起。

更合理的方向是拆出纯能力包，要求导入时零文件系统、零网络、零环境变量副作用。

### 6.6 构建和测试治理不足以支撑“直接作为平台底座”

Boclaw 当前没有统一 `test` 和 `typecheck` script，SDK build 对 tsc 使用 `|| true`。现有 `.mjs` 测试依赖预构建 `dist`，本次在未构建快照上直接执行时因模块不存在而无法启动。

这不说明算法不可用，但说明在平台依赖前必须补齐：

- 可重复的 clean build；
- typecheck 不吞错；
- 单元/契约/集成测试分层；
- SDK public exports 兼容测试；
- 无副作用 import 测试；
- Linux 容器矩阵；
- 版本和 capability 协商。

---

## 7. Boclaw 最值得复用的能力

### 7.1 P0：模型能力目录与路由

建议优先抽取：

- 模型 capability、最大上下文和最大输出；
- primary/fast/summary/vision 等角色；
- 健康度、冷却、优先级和 failover；
- 私有模型名称下的显式 capability；
- 租户可见模型与平台模型列表映射。

aiop 继续负责租户可见性、密钥和 provider 实例；共享 SDK 只做描述、选择和路由算法。

### 7.2 P0：稳定 Tool Catalog 与延迟工具发现

当 MCP、Skill、集群和编码工具增长时，全部工具 schema 注入模型会快速消耗上下文。应复用 Boclaw 的：

- Tool Search/catalog 思路；
- 稳定排序和分区；
- capability-aware deferred tools；
- 未知 provider 的安全 inline fallback。

aiop 保留最终 `ToolRegistry.dispatch()`、Policy 和 Audit。

### 7.3 P1：上下文治理

建议复用或重写为公共策略包：

- 按模型窗口和输出预留计算预算；
- 自动压缩和 reactive compact；
- 压缩失败断路器；
- 大工具结果裁剪；
- 图片历史预算；
- prompt-too-long 的确定性恢复策略。

该部分应输入纯消息和预算，输出压缩计划/消息，不直接读写 transcript。

### 7.4 P1：多模态翻译路由

当主模型不支持图像时，使用授权 VLM 把图片转为结构化文本，再交给主模型。适合私有化环境中“主力文本模型 + 少量视觉模型”的组合。

需要由 aiop Model Catalog 保证：

- VLM 对当前租户可见；
- 图片数据允许发送到该 provider；
- 路由、成本、延迟和失败均可审计；
- 不因名称启发式越过显式数据策略。

### 7.5 P1/P2：完整 Coding Agent Runner

短期不必把 61 个工具逐个改写成 aiop Tool。可以把完整 Boclaw Agent 放入隔离 Runner，通过版本化协议与 aiop 通信：

- aiop 创建/选择 Workspace 和 Sandbox；
- aiop 签发一次性 capability grant；
- Runner 内启动 Boclaw Agent；
- Runner 回传文本、thinking、tool start/output/result、权限请求和 usage；
- aiop 作最终 Policy/Approval/Checkpoint/Audit；
- Runner 不持有平台主数据库和长期用户 token。

这种方式最快获得 Coding Agent 能力，同时隔离 cwd、Home、环境变量和原生工具风险。

### 7.6 P2：子代理和任务协议

Boclaw 已有子代理、Task、Plan、后台和 Worktree 能力。建议先通过 Runner 复用实际行为，再抽取公共的 Task/Event/Capability 协议；不要第一阶段就在 aiop 内复制其全部状态机。

---

## 8. 不建议直接复用的部分

| Boclaw 部分 | 建议 | 原因 |
|---|---|---|
| Ink/CLI/UI 组件 | 不进入 aiop Server | 与 stdin/stdout、ANSI、快捷键和进程生命周期耦合。 |
| `~/.bobot` 配置与 transcript | 不作为平台主存储 | 不满足多租户、数据库查询、多副本和合规治理。 |
| 进程级 cwd/worktree 状态 | 仅限独立 Runner | 在共享进程中存在串租户风险。 |
| 直接读写 `process.env` 的配置链 | 改为显式 HostConfig/SecretRef | 环境变量是进程级状态，无法表达安全的 per-run 隔离。 |
| 本地 OAuth/keychain | 不进入服务端主链 | aiop 已有 OIDC/AIOS/JWT/加密凭据存储。 |
| `bypassPermissions` 等本地权限模式 | 不作为平台授权 | 平台组织策略不能被 Agent options 绕过。 |
| 桌面、剪贴板、音频和原生工具 | 按 Runner profile 启用 | 增大攻击面和镜像兼容成本。 |
| Boclaw 本地 scheduler/daemon | 不替换 aiop Scheduler | aiop 已有租户化持久任务和无人值守策略。 |
| Build-time feature flags 作为租户授权 | 只能用于产物裁剪 | 租户授权必须是运行时、可审计的服务端策略。 |

---

## 9. 候选方案评估

### 9.1 方案定义

- **方案 A：Boclaw 整体 fork 改造成 aiop**：以 Boclaw 为主仓，添加 Web、多租户、数据库、沙箱和运维能力。
- **方案 B：继续纯 aiop 自研**：不复用 Boclaw 代码，只参考设计，所有 Agent 能力在 aiop 重写。
- **方案 C：aiop 平台 + 共享 SDK + Boclaw Runner**：推荐方案。
- **方案 D：新建第三个统一平台重写**：两边都作为遗留系统，重新开始。

### 9.2 加权评分

评分为 1–5 分，5 最优。权重体现“实现 aiop 类企业智能体”的目标，不适用于单机 CLI 产品。

| 评价项 | 权重 | A 整体改 Boclaw | B 纯 aiop 自研 | C 混合架构 | D 全新重写 |
|---|---:|---:|---:|---:|---:|
| 企业平台目标匹配 | 20% | 2 | 5 | 5 | 4 |
| Agent 能力成熟度 | 20% | 5 | 2 | 5 | 1 |
| 多租户与安全边界 | 20% | 2 | 5 | 5 | 3 |
| 首期交付速度 | 15% | 3 | 3 | 4 | 1 |
| 长期维护与升级 | 15% | 2 | 3 | 4 | 2 |
| 容器化与水平扩展 | 10% | 2 | 4 | 5 | 3 |
| **加权总分（百分制）** | 100% | **54** | **73** | **94** | **48** |

评分不是精确测量，但清楚反映了结构性事实：方案 C 同时保留 aiop 的平台优势和 Boclaw 的 Agent 优势，且避免把两套产品代码硬合并。

---

## 10. 推荐目标架构

```text
Browser / API Client
        |
        v
+------------------------- aiop Control Plane --------------------------+
| Auth / Tenant / RBAC / Session / Store / Scheduler / SSE             |
| Model Catalog / Policy / Approval / Hook / Audit / Cost              |
| Skill ownership / MCP config / Sandbox & Workspace orchestration      |
+-----------------------------+-----------------------------------------+
                              |
                 versioned Agent/Runner protocol
                              |
              +---------------+----------------+
              |                                |
              v                                v
     Native aiop Agent Kernel          Boclaw Coding Runner
     - chat/ops/light tools            - isolated process/container
     - kubectl/platform tools          - own cwd/Home/env/workspace
     - fast startup                    - full coding tools/subagents
              |                                |
              +---------------+----------------+
                              |
                              v
                 Sandbox / Workspace / MCP / LLM
```

### 10.1 必须由 aiop 保留的权力

- 认证后的 `tenantId/userId/role`；
- 模型和工具可见性；
- SecretRef 解析和最小凭据注入；
- Policy、Approval、Hook 和 Audit；
- 会话、消息、run、事件和 usage 主存储；
- Sandbox/Workspace 生命周期；
- cancel、timeout、quota 和并发限制；
- Kubernetes/生产操作最终授权。

### 10.2 Runner 可以拥有的能力

- 本次 run 的临时 cwd/Home/env；
- 本地编码工具进程；
- Git/LSP/rg/编译器；
- 受 grant 限制的 MCP；
- 本次 run 的短期 Agent 内存和 cache；
- 仅限 Workspace 的文件访问。

### 10.3 Runner 不应拥有

- 平台数据库直连；
- 长期平台管理员 token；
- 其他租户配置；
- 任意创建沙箱/Pod 的权限；
- 绕过平台审批的授权；
- 未经允许的宿主 Home、Docker socket、host network 或 hostPath。

---

## 11. 共享 SDK 的建议拆分

不建议让 aiop 永久依赖当前完整 `@bocloud/bobot-agent-sdk`。建议逐步形成：

| 包 | 职责 | 副作用要求 |
|---|---|---|
| `@bocloud/agent-contracts` | Message、Tool、Event、Usage、SecurityScope、版本协商 | 零 FS、零网络、零 env。 |
| `@bocloud/model-routing` | Model Catalog 类型、capability、role、failover、vision routing | 不保存密钥，不直接认证。 |
| `@bocloud/tool-catalog` | 稳定排序、检索、deferred tool projection | 不执行工具。 |
| `@bocloud/context-policy` | token 预算、压缩计划、reactive compact 判定 | 纯函数优先，不写 transcript。 |
| `@bocloud/agent-kernel` | Host-driven Agent Loop，可插拔 model/tool/persistence/policy ports | 无默认工具、无默认网络、无全局 cwd。 |
| `@bocloud/runner-protocol` | Runner request/event/cancel/approval/capability grant | 可序列化、版本化。 |
| `@bocloud/bobot-coding-runner` | 完整 Boclaw 编码工具和本地工作区能力 | 只能在隔离进程/容器运行。 |

第一阶段不必一次拆完。最小可行顺序是 contracts → routing/context/catalog → runner protocol → kernel。

---

## 12. 分阶段落地建议与工作量

以下为熟悉两个代码库的 3–5 人团队的工程估算，包含开发和自动化测试，不包含企业安全测评、生产基础设施排期和 UI 大改。估算应在 POC 后校准。

### 阶段 0：契约与隔离 POC（2–3 周）

目标：证明完整 Boclaw Agent 能被 aiop 安全地当作 Runner 调用。

工作项：

- 定义 run/event/cancel/approval 的最小协议；
- 每个 Runner 使用独立 cwd、Home、env 和 Workspace；
- aiop 将模型、工具和临时凭据以 grant 形式注入；
- 映射 assistant/tool/usage/error 事件到 SSE；
- 支持取消、超时和 Runner 销毁；
- 做并发隔离、越权路径和凭据泄漏测试。

通过门槛：连续运行 10–20 个不同用户/工作区会话，无 cwd、环境变量、文件、MCP 和 transcript 串扰。

### 阶段 1：共享基础能力（4–6 周）

目标：让 aiop 原生 Agent 先吃到 Boclaw 的高价值能力。

工作项：

- contracts；
- tenant-scoped Model Catalog；
- stable Tool Catalog；
- 上下文预算/压缩策略；
- vision routing；
- provider capability 和 fallback；
- 两边契约测试。

通过门槛：共享包导入时无文件、网络、环境变量和 global 副作用；Boclaw CLI 和 aiop 测试均通过。

### 阶段 2：生产级 Coding Runner（4–8 周）

目标：在 aiop 中正式提供专业 Coding Agent profile。

工作项：

- Runner 镜像、资源限额、网络策略；
- Workspace 生命周期和制品导出；
- 权限请求与 aiop Approval 双向协议；
- tool start/output/result checkpoint；
- crash/retry/recovery 边界；
- Git/LSP/MCP/子代理支持；
- 观测、成本、审计和灰度。

通过门槛：Runner 崩溃不会导致工具副作用被静默重复；平台可审计每个敏感工具、审批人和最终结果。

### 阶段 3：统一 Kernel 与长期治理（持续 6–12 周，可并行渐进）

目标：减少两边 Agent Loop 的重复实现，而不是一次性大迁移。

工作项：

- Host-driven Agent Kernel；
- Boclaw QueryEngine 逐步适配 ports；
- aiop Runtime 接入同一 kernel；
- capability/version compatibility matrix；
- candidate → contract tests → staging → gray release；
- 维护最小 patch 队列并持续上游合并。

---

## 13. POC 必测清单

### 13.1 并发与隔离

- 不同 tenant/user/session 的 cwd、Home、env、MCP、Skill、model 不串；
- 同名 session 在不同 tenant 下不会复用同一 sandbox；
- symlink、`..`、绝对路径不能逃逸 Workspace；
- Runner 看不到 API 进程 Home、数据库凭据和其他用户 Secret。

### 13.2 策略与审批

- 模型无法通过参数覆盖 `tenantId/userId/role`；
- Boclaw 的 `bypassPermissions` 不能绕过 aiop Policy；
- 审批只对指定 run/tool call 有效，超时或重放无效；
- deny 优先于用户 allow；
- 高风险工具在无人值守任务中默认拒绝。

### 13.3 生命周期

- 客户端断开、显式 cancel、timeout 都能终止模型和子进程；
- Runner crash 后可判定哪些操作可重试；
- API 重启后仍能恢复会话和终态事件；
- 同一 session 的并发消息有明确排队或拒绝语义。

### 13.4 性能与容量

- 冷启动、warm pool、首 token、完整任务时延；
- 单 Runner 内存、PID、磁盘和日志上限；
- 20/50/100 并发下 API 与 Runner 的资源曲线；
- 大仓库 LSP、Git 和上下文压缩开销；
- Tool Catalog 前后输入 token 和 cache 命中率。

### 13.5 可维护性

- clean checkout 可以一条命令 build/typecheck/test；
- SDK public exports 有契约测试；
- aiop 不 import Boclaw 私有 `src/*`；
- Runner 协议支持版本协商和不兼容错误；
- 任一 Boclaw 版本可以单独灰度和回退。

---

## 14. 主要风险与应对

| 风险 | 影响 | 概率 | 应对 |
|---|---|---:|---|
| Boclaw 上游变化快，抽取分支持续漂移 | 双方升级困难 | 高 | 共享包独立版本；契约测试；短 patch 队列；明确 code owner。 |
| 全局状态未完全清除 | 串会话/串租户 | 高 | 完整 Runtime 先隔离进程；共享包做无副作用 import 测试。 |
| 双重权限语义冲突 | 误拒绝或越权 | 中高 | aiop 是最终授权者；Runner 权限只做更严格限制，不能放宽。 |
| 事件语义不一致 | Web 展示、恢复、审计错误 | 中 | 版本化 Runner Event；golden trace；顺序与幂等测试。 |
| Runner 成本和冷启动过高 | 用户体验和资源成本下降 | 中 | profile 化镜像、warm pool、轻任务走 aiop native kernel。 |
| 原生/桌面依赖扩大攻击面 | 安全和发布复杂 | 中高 | 按 profile 裁剪；Linux server 默认不带桌面能力。 |
| 工具副作用重试 | 重复提交、删除或部署 | 中高 | tool.started/tool.finished checkpoint；idempotency key；未知状态进入人工恢复。 |
| 共享 SDK 过度抽象 | 交付变慢 | 中 | 先抽纯算法和协议；Runner 先行；避免一次性重写 QueryEngine。 |
| 品牌、包名和私有接口不稳定 | 消费方升级破坏 | 中 | 只依赖明确 exports；统一 `@bocloud/*` 命名和 semver。 |

---

## 15. 决策门槛

建议在以下条件全部满足后，正式采用“aiop + Boclaw Runner/共享 SDK”路线：

1. Boclaw 团队接受把纯能力从 CLI/产品代码中拆出并维护稳定公共 API；
2. POC 证明并发会话间 cwd/Home/env/文件/MCP 无串扰；
3. aiop Policy 能对 Runner 工具做最终授权，Boclaw options 无法绕过；
4. Runner 支持 cancel、timeout、资源限制、日志限制和确定性销毁；
5. clean build、typecheck、contract test 进入 CI，tsc 错误不再被 `|| true` 吞掉；
6. 明确共享 SDK、aiop adapter、Boclaw adapter 和 Runner 的团队 ownership；
7. 明确版本兼容窗口和回滚方式。

若第 1 条短期无法达成，仍建议采用“黑盒 Boclaw Runner”，不要把完整 SDK 嵌入 aiop API 进程。黑盒 Runner 能先获得业务价值，同时为后续抽取保留空间。

---

## 16. 最终建议

### 建议采用

**方案 C：aiop 平台 + 共享 Agent SDK + Boclaw Coding Runner。**

推荐实施顺序：

1. 先做隔离 Runner POC，验证安全边界和真实用户价值；
2. 并行抽取 Model Catalog、Tool Catalog、Context Policy 和 Vision Routing；
3. 轻量聊天/运维继续走 aiop Native Agent；
4. 专业编码任务路由到 Boclaw Coding Runner；
5. 在契约稳定后，再考虑逐步统一 Agent Kernel。

### 明确不建议

- 不建议停止 aiop、转而在 Boclaw 内重建多租户 Web 平台；
- 不建议让完整 Boclaw SDK 与多个租户会话共享同一个 Node API 进程；
- 不建议复制 Boclaw 的本地 transcript、OAuth、Home 和权限体系作为平台主实现；
- 不建议一次性重写两个 Agent Loop 追求“架构统一”；
- 不建议让 aiop 直接 import Boclaw 私有 `src/*` 文件。

### 最终判断

从短期交付看，直接基于 Boclaw 改造似乎能快速获得很多 Agent 功能；但从真实工作量看，多租户、安全、持久化、沙箱和服务化会迫使团队重写 Boclaw 的外围运行时，而这些正是 aiop 已经具备的部分。长期还会承担庞大 fork 的升级成本。

因此，对“aiop 类智能体”的最优路径不是选一个仓库替代另一个，而是把产品边界划清：

> **aiop 负责可信的平台运行，Boclaw 负责高能力的智能执行；共享 SDK 负责两者之间可复用、可测试、可升级的协议和算法。**

---

## 17. 关联材料

- `docs/DESIGN.md`：aiop 总体设计；
- `docs/DESIGN-agent-runtime.md`：aiop run/turn/session/checkpoint 演进设计；
- `docs/DESIGN-boclaw-reference.md`：Boclaw 可借鉴能力专项分析；
- `docs/DESIGN-shared-agent-sdk.md`：共享 Agent SDK 详细设计；
- `bocloud-ai-boclaw/ARCHITECTURE.md`：Boclaw 架构说明；
- `bocloud-ai-boclaw/docs/BoClaw_现有系统详细设计.md`：Boclaw 当前系统设计；
- `bocloud-ai-boclaw/docs/BoClaw_Web与容器化改造方案.md`：Boclaw 服务化改造建议。
