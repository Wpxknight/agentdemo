# Boclaw / BoBot 可借鉴能力分析与演进方案

> 状态：方案设计稿
>
> 分析对象：`/home/opt/develop/aicoding/boclaw/bocloud-ai-boclaw`
>
> 目标仓库：`/home/opt/develop/aicoding/aiop`
>
> 范围：只做源码分析、架构对比和演进方案，不修改业务代码
>
> 源码基线：Boclaw 当前构建版本 `0.2.71`；部分架构文档版本落后，本文以当前源码为准

---

## 1. 执行摘要

Boclaw 实际发布产品为 **BoBot**，同一源码树同时提供 CLI 和进程内 SDK。它最值得 aiop 借鉴的不是本地 CLI、文件工具或会话存储，而是围绕“大模型能力差异”和“大工具集上下文成本”形成的几组运行时机制：

1. **模型能力注册表与能力驱动路由**；
2. **确定性 Tool Catalog 与 Prompt Cache 稳定策略**；
3. **精确上下文预算、压缩失败断路器和 reactive compact**；
4. **协议中立的延迟工具发现**；
5. **辅助模型角色、健康状态和受控 failover**；
6. **多模态翻译路由**；
7. **遥测字段白名单和外部出口审计**；
8. **构建期功能裁剪和发布闸门**。

其中前四项建议优先推进。它们与现有 `docs/DESIGN-agent-runtime.md` 互补：

- Agent Runtime 解决 run、turn、session、checkpoint、并发和恢复；
- 本文解决 model catalog、模型能力路由、tool catalog、上下文治理和 provider capability；
- 不应引入第二套 QueryEngine、transcript、session 状态机或本地队列。

### 1.1 最终优先级

| 优先级 | 建议 | 结论 | 预计改动 | 主要依赖 |
|---|---|---|---|---|
| P0 | Tenant-scoped Model Catalog + Capability Router | 强烈建议 | 中 | Store 模型配置、Provider Adapter |
| P0 | Stable Tool Catalog / 确定性排序 | 强烈建议，快速收益 | 小 | `ToolRegistry` |
| P1 | 精确上下文预算 + 压缩断路器 + reactive compact | 强烈建议 | 中 | Model Catalog、现有 compaction |
| P1 | Protocol-neutral Deferred Tool Discovery | 强烈建议，分阶段 | 中到大 | Model Catalog、Tool Catalog、Provider capability |
| P1 | 多模态翻译路由 | 建议 | 中 | Model Catalog、辅助模型调用 |
| P2 | 辅助模型角色、健康状态和 failover | 建议 | 中 | Model Catalog、Runtime Event |
| P2 | 遥测字段白名单和外部出口治理 | 建议 | 中 | audit/usage/event sink |
| P2 | 数据库级 Conversation Branch | 可选 | 中 | Agent Runtime、history revision |
| P3 | 构建期功能裁剪和发布闸门 | 后续考虑 | 中 | 交付形态、CI/CD |

### 1.2 强烈建议的四项

#### 1. Model Catalog / Capability Router

**功能概述**：把当前静态 `ModelConfig` 扩展为租户可见、provider-neutral 的模型目录，显式描述上下文窗口、最大输出、输入模态、工具协议、角色、价格和来源版本；所有路由按能力选择，不依赖硬编码模型 ID。

**收益点**：

- 为视觉翻译、摘要模型、embedding、rerank、延迟工具协议提供统一基础；
- 私有化部署可使用自定义模型名称，不需要修改代码；
- 不会路由到当前租户或用户无权使用的模型；
- 上下文预算和输出预留从固定常量升级为按模型计算；
- 模型选择、fallback、计费和审计可解释。

#### 2. Stable Tool Catalog

**功能概述**：模型可见工具不再依赖 `Map` 插入顺序，按“内置工具稳定前缀 + MCP/Skill 分区内稳定排序”输出，并明确名称冲突优先级。

**收益点**：

- 降低 system prompt 和 tool schema cache key 抖动；
- MCP 工具增删不会打乱内置工具前缀；
- 跨实例、重启和动态注册后工具顺序可预测；
- 改动小、回归边界清晰，可作为首个快速优化。

#### 3. Context Policy 增强

**功能概述**：根据模型 `contextWindowTokens` 和 `maxOutputTokens` 计算有效窗口，按模型类别使用差异化安全 buffer；增加连续压缩失败断路器、摘要后复检和 prompt-too-long 后的一次 reactive compact。

**收益点**：

- 避免固定 32K 输出预留对不同模型过度或不足；
- 减少第三方模型 token 估算偏差导致的 400/413；
- 避免不可恢复会话每轮重复调用摘要模型；
- 提高长会话成功率和失败可解释性。

#### 4. Protocol-neutral Deferred Tool Discovery

**功能概述**：大工具集不全部内联给模型，而是先暴露可搜索 catalog；发现后再按 provider 能力投影为 Anthropic `tool_reference` 或普通 inline schema。未知/不支持协议安全回退为全部内联。

**收益点**：

- MCP、Skill 和多集群工具增长后显著节省输入 token；
- 减少工具描述对主任务上下文的挤占；
- 支持按当前任务渐进加载工具；
- 可与 checkpoint/compaction 保持已发现工具状态。

---

## 2. 分析方法和证据边界

本分析以源码静态阅读为主，重点检查：

- SDK/CLI 入口；
- QueryEngine 和模型请求循环；
- 模型 capability、角色和 failover；
- 多模态路由；
- 自动压缩；
- Tool Search 和工具池装配；
- session fork；
- 遥测和隐私；
- build/release；
- 相关 smoke test 和生命周期测试。

未执行 Boclaw build 或 test，原因是本任务只要求只读调研和方案。测试文件用于确认设计意图和边界，不作为运行通过的证明。

源码快照不处于可用的 Git 仓库根目录，无法依赖提交历史验证机制引入时间。`ARCHITECTURE.md` 中的版本与 `build.ts` 当前 `0.2.71` 不一致，因此：

1. 源码优先于设计文档；
2. 测试优先用于确认边界，不替代源码；
3. `tests/readFileStateRecovery.test.mjs` 等“实现镜像测试”存在与真实实现漂移的风险，不作为 aiop 推荐测试模式。

---

## 3. Boclaw 架构概览

### 3.1 发布形态

同一源码树发布：

- `@bocloud/bobot-agent-sdk`；
- `@bocloud/bobot-cli`。

SDK 在宿主进程内运行完整 Agent 引擎，不通过子进程调用 CLI。CLI 由 Bun 打包成单文件，再由 CommonJS 启动器检查 Node 版本和动态加载。

```text
SDK:
  src/sdk.ts
  → src/_macro-shim.ts
  → src/setup-globals.ts
  → src/agent.ts
  → src/QueryEngine.ts
  → src/query.ts
  → src/services/api/client.ts

CLI:
  cli.cjs
  → cli.js
  → src/entrypoints/cli.tsx
  → src/main.tsx
```

### 3.2 核心职责

| 模块 | 主要职责 |
|---|---|
| `src/agent.ts` | SDK `Agent/createAgent/query/forkAgent` API、MCP 组装、权限和环境参数 |
| `src/QueryEngine.ts` | conversation/turn 生命周期，消息、usage、abort、read state |
| `src/query.ts` | 模型流、工具执行、重试、compact、fallback |
| `src/tools.ts` | 工具全集、feature gate、权限过滤、工具池装配 |
| `src/Tool.ts` | Tool 和 `ToolUseContext` 契约 |
| `src/services/api/client.ts` | 模型 API 客户端和网关路由 |
| `src/services/compact/` | 上下文压缩和恢复 |
| `src/utils/model/` | 模型能力、角色、健康状态和路由 |
| `src/utils/toolSearch.ts` | 延迟工具能力判断和启用策略 |
| `src/services/analytics/` | 遥测和事件导出 |

### 3.3 Conversation 模型

一个 `QueryEngine` 实例对应一个 conversation，多次 `submitMessage()` 形成连续 turn。实例内保留：

- messages；
- file state/cache；
- usage；
- permission denials；
- abort controller；
- memory/skill discovery state。

Boclaw 在首个模型请求前持久化用户输入，降低“请求已接受但首个响应前进程退出”的丢失概率。该目标是合理的，但 aiop 不应照搬其本地 transcript 体系，因为 `DESIGN-agent-runtime.md` 已用 durable inbox、`input.accepted` checkpoint、run 状态和 session revision 设计了服务端方案。

---

## 4. aiop 当前能力基线

### 4.1 已有能力

aiop 已具备：

- Node.js 20、TypeScript、ESM、Vitest；
- Anthropic/OpenAI Provider Adapter；
- provider-neutral `Msg`、`ToolCall`、`ToolResult`、`ToolContentBlock`、`StreamEvent`、`ChatModel`；
- 流式 Agent Loop；
- AbortSignal、重试和指数退避；
- 图片输入、图片历史治理、上下文预算、摘要压缩和硬裁剪；
- active run pending message 注入；
- ToolRegistry 动态注册与 dispatch；
- Policy、Approval、PreToolUse Hook；
- `ask_user` 和变更计划审批；
- MCP、Skill、Sandbox、kubectl、Scheduler；
- MySQL/Kysely Store；
- tenant/user 双层隔离；
- JWT、OIDC、AIOS token exchange、RBAC；
- usage、cost、audit、SSE；
- E2B、OpenSandbox、local sandbox；
- 用户主目录、凭据和 Skill visibility 隔离。

### 4.2 已有设计但尚未实现的增强

`docs/DESIGN-agent-runtime.md` 已覆盖：

- `AgentRuntime + TurnCoordinator`；
- transport-neutral Message Envelope；
- Runtime Event；
- session 串行和 durable inbox；
- lease、CAS、fencing token；
- 工具并发元数据；
- dispatch 前 `tool.started` checkpoint；
- 工具完成 checkpoint；
- cancel、quiesce 和 `recovery_required`；
- checkpoint 加密和恢复边界。

本文不重复设计第二套 Runtime。

### 4.3 与 Boclaw 对比后的真实缺口

| 领域 | aiop 现状 | Boclaw 增量 | 结论 |
|---|---|---|---|
| 模型配置 | 静态 `ModelConfig` | capability、角色、主/辅助、动态 max context | 真增量 |
| 多模态 | 可直接传图片 | 主模型不支持时用 VLM 翻译 | 真增量 |
| 上下文 | 固定输出预留和安全余量 | 动态 output reserve、差异 buffer、失败断路器 | 真增量 |
| Tool 可见性 | `filterToolDefs` | catalog/search/deferred tools | 部分增量 |
| 工具排序 | 依赖 `Map` 插入顺序 | 分区稳定排序和冲突优先级 | 真增量，快速收益 |
| 权限 | Policy/Approval/Hook/Skill visibility | 模型前 deny 预过滤 | aiop 已有基础，不建新体系 |
| session 生命周期 | HTTP/CLI/Scheduler 分散，已有 Runtime 设计 | QueryEngine/transcript/fork | Runtime 已覆盖大部，fork 可选 |
| 工具并发 | 当前全部 `Promise.all`，已有一期设计 | Tool 的并发语义约束 | Agent Runtime 已覆盖 |
| 模型健康 | Provider retry | economy pool cooldown/failover | 辅助模型有增量 |
| 遥测 | usage/audit/event | 字段白名单、出口清单 | 可借鉴治理思路 |
| 构建发布 | Node/TS/容器 | Bun DCE、test/prod/sdk channel | 后续可借鉴，不迁移 Bun |

---

## 5. 方案一：Model Catalog 与能力驱动路由

### 5.1 源码证据

Boclaw 的模型目录和能力来源分散在：

- `src/services/bocloud-auth/storage.ts`
  - `BocloudModelEntry` 包含 `capabilities`、`maxContext`、`isPrimary`、`role`、`weight`；host 注入的 tier mapping 另支持 `priority`；
  - 主模型和辅助模型可同时下发；
  - 模型列表查询失败时保留内存中已有列表；
- `src/utils/model/modelCapabilities.ts`
  - 缓存 `max_input_tokens`、`max_tokens`、`vision_capable`；
  - 缓存文件权限为 `0600`；
  - 拉取失败软降级；
- `src/utils/model/modelOptions.ts`
  - `isPrimary === false` 的辅助模型默认不展示；
- `src/utils/model/visionRouting.ts`
  - capability 优先于名称启发式；
  - 找不到授权模型时返回 `null`；
- `src/utils/model/roles.ts`
  - `main/mid/fast` 角色池、会话亲和、健康过滤和降级链。

Boclaw 使用类似 HuggingFace `pipeline_tag` 的 capability：

- `text-generation`；
- `image-text-to-text`；
- `video-text-to-text`；
- `text-to-image`；
- `text-to-video`；
- `text-to-speech`；
- `automatic-speech-recognition`；
- `audio-text-to-text`；
- `any-to-any`。

### 5.2 aiop 当前缺口

`src/model/factory.ts` 当前配置为：

```ts
export interface ModelConfig {
  protocol: 'anthropic' | 'openai';
  baseURL: string;
  apiKey: string;
  model: string;
  contextWindowTokens?: number;
  contextKeepImages?: number;
  effort?: ReasoningEffort;
  pricing?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}
```

它适合创建一个模型实例，但不能回答：

- 当前租户有哪些模型；
- 哪个模型支持图片理解；
- 哪个模型可作为摘要或快速模型；
- 哪个 provider/model 支持 deferred tool protocol；
- 最大输出是多少；
- 目录版本是否已变更；
- fallback 是否改变计费和审计语义。

### 5.3 目标设计

建议新增 provider-neutral 描述，不把 Platform 字段直接泄露到 Agent Core：

```ts
export type ModelCapability =
  | 'text-generation'
  | 'image-understanding'
  | 'video-understanding'
  | 'audio-understanding'
  | 'image-generation'
  | 'video-generation'
  | 'text-to-speech'
  | 'speech-to-text'
  | 'tool-use'
  | 'prompt-cache'
  | 'deferred-tools';

export type ModelRole =
  | 'primary'
  | 'vision'
  | 'summary'
  | 'fast'
  | 'embedding'
  | 'rerank';

export interface ModelDescriptor {
  id: string;
  providerId: string;
  protocol: 'anthropic' | 'openai';
  displayName?: string;
  roles: ModelRole[];
  capabilities: ModelCapability[];
  contextWindowTokens: number;
  maxOutputTokens?: number;
  supportsPromptCache?: boolean;
  supportsDeferredTools?: boolean;
  pricing?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  source: 'config' | 'store' | 'platform' | 'heuristic';
  revision?: string;
  enabled: boolean;
}
```

目录访问必须带可信 `RequestContext`：

```ts
export interface ModelCatalog {
  listVisible(
    ctx: RequestContext,
    query?: ModelCatalogQuery,
  ): Promise<ModelDescriptor[]>;

  getVisible(
    ctx: RequestContext,
    modelId: string,
  ): Promise<ModelDescriptor | null>;

  select(
    ctx: RequestContext,
    request: ModelSelectionRequest,
  ): Promise<ModelSelectionResult | null>;
}
```

### 5.4 选择规则

建议固定以下优先级：

```text
请求显式指定且有权限的模型
→ 租户策略指定的角色模型
→ Model Catalog 中 capability 完整匹配的候选
→ 健康状态过滤
→ 稳定优先级/权重选择
→ 无匹配返回 null
```

禁止：

- 硬编码某个模型 ID 作为所有租户兜底；
- 从其他租户目录选择模型；
- 因模型名称相似就绕过 capability；
- 主模型失败后静默切换到价格或数据边界不同的模型；
- 把 provider secret 存进 `ModelDescriptor` 或事件。

### 5.5 Capability 可信度

能力来源优先级建议为：

```text
tenant/store 显式配置
→ 已签名或可信 Platform 元数据
→ provider metadata
→ 保守名称启发式
→ 未知
```

启发式只能用于“安全关闭型”优化：

- 猜测“不支持 deferred tools”可以回退 inline；
- 不能仅凭名称猜测“允许发送敏感图片”；
- 不能仅凭名称猜测“支持副作用工具调用”；
- 不能以启发式覆盖显式 `false`。

### 5.6 多租户边界

必须保持：

> 身份只来自服务端验证过的 JWT（`RequestContext.userId`），永远不来自聊天文本、请求 body 或 LLM 输出。

此外：

- catalog key 至少包含 `tenantId`、provider/model 和 revision；
- 用户可见模型必须经过 tenant policy 和 user entitlement；
- 目录缓存不能用 process-global 的单份数组表示全部租户；
- refresh 失败可继续使用未过期快照，但必须带 revision/age；
- 路由结果必须写 usage/audit/runtime event；
- resume 时重新校验模型权限，不能沿用已失效授权；
- disabled 用户不能通过恢复 run 间接调用模型。

### 5.7 事件建议

在 Agent Runtime Event 上增加：

- `model.catalog_resolved`；
- `model.route_selected`；
- `model.route_unavailable`；
- `model.fallback_started`；
- `model.fallback_completed`；
- `model.fallback_failed`。

事件可记录：

- provider/model 的内部安全标识；
- role、capability、catalog revision；
- 选择原因；
- 是否 fallback；
- 耗时和 usage。

事件不得记录 API key、Authorization header、完整 baseURL query、图片原文或用户 prompt。

### 5.8 测试与验收

1. 两个租户同名模型但能力不同，不串目录；
2. 辅助模型不出现在默认主模型选择器；
3. 没有 capability 匹配时返回 `null`；
4. 显式 capability 优先于名称启发式；
5. 显式 `false` 不被启发式覆盖；
6. refresh 失败保留最后有效快照并发事件；
7. catalog revision 变化后旧 route cache 失效；
8. route 事件和最终 usage 对应同一 provider/model；
9. 用户权限撤销后 resume 失败；
10. 任何返回对象和日志不包含 secret。

---

## 6. 方案二：Stable Tool Catalog

### 6.1 源码证据

Boclaw `src/tools.ts` 的 `assembleToolPool()`：

```ts
const byName = (a: Tool, b: Tool) =>
  a.name.localeCompare(b.name);

return uniqBy(
  [...builtInTools]
    .sort(byName)
    .concat(allowedMcpTools.sort(byName)),
  'name',
);
```

其意图是：

- 内置工具形成连续稳定前缀；
- 内置和 MCP 各分区内部稳定排序；
- MCP 工具变化不打乱内置工具前缀；
- 名称冲突时内置工具优先；
- 提高 prompt/tool schema cache 稳定性。

Boclaw 同时在模型看到工具前执行 blanket deny 过滤，并支持 MCP server prefix deny。

### 6.2 aiop 当前缺口

`src/agent/tools.ts` 当前：

```ts
defs(): ToolDef[] {
  return [...this.handlers.values()].map((h) => h.def);
}
```

顺序依赖注册时的 `Map` 插入顺序。动态 MCP、Skill 或租户工具注册顺序改变时，模型看到的 tool schema 顺序可能变化。

aiop 已有：

```ts
filterToolDefs?: (defs: ToolDef[]) => ToolDef[];
```

因此不需要新建另一套权限系统，只需把 Tool Catalog 稳定化，并保证过滤在 catalog projection 前后都生效。

### 6.3 目标设计

建议把工具来源显式化：

```ts
export type ToolSource =
  | 'builtin'
  | 'skill'
  | 'mcp'
  | 'sandbox'
  | 'cluster'
  | 'dynamic';

export interface ToolCatalogEntry {
  def: ToolDef;
  source: ToolSource;
  sourceId?: string;
  searchHint?: string;
  aliases?: string[];
  deferredEligible?: boolean;
}
```

投影规则：

```text
1. 根据 tenant/user/role/Skill visibility 过滤
2. 根据运行 profile 和 provider capability 过滤
3. 按来源分区
4. 分区内使用规范化名称稳定排序
5. 按来源优先级处理名称冲突
6. 输出模型可见 schema
7. dispatch 时再次鉴权
```

建议默认来源顺序：

```text
builtin
→ skill
→ sandbox/cluster
→ mcp
→ dynamic
```

名称冲突必须 fail-closed：

- 静态启动期冲突可直接报错；
- 动态工具冲突不能静默覆盖内置工具；
- 若决定内置优先，必须发 audit/event；
- 不允许模型通过 alias 绕过原工具权限。

### 6.4 与 Agent Runtime 的关系

Tool Catalog 只解决“模型可见工具集合和稳定顺序”。工具执行仍走：

```text
Policy
→ Approval
→ PreToolUse Hook
→ tool.started checkpoint
→ ToolRegistry.dispatch
→ tool.completed checkpoint
```

它不能替代 `DESIGN-agent-runtime.md` 中的并发、恢复和 checkpoint 设计。

### 6.5 测试与验收

1. 相同工具集合按不同注册顺序装配，defs 完全相同；
2. 增加一个 MCP 工具不改变 built-in 前缀；
3. 名称冲突时行为确定且有审计；
4. MCP server prefix deny 后该 server 工具不出现在 catalog；
5. 搜索、展示和 dispatch 三条路径都执行权限校验；
6. Skill visibility 变化后 catalog cache 失效；
7. 不同 tenant 的 catalog 不共享隐藏工具；
8. schema 序列化结果稳定，可作为 snapshot 测试。

---

## 7. 方案三：精确上下文预算与压缩韧性

### 7.1 源码证据

Boclaw `src/services/compact/autoCompact.ts` 的实际算法：

```ts
const reservedTokensForSummary = Math.min(
  getMaxOutputTokensForModel(model),
  20_000,
);

const effectiveContextWindow =
  contextWindow - reservedTokensForSummary;
```

Claude/GPT：

```text
threshold = effectiveContextWindow - 13,000
```

其他 BoCloud 模型：

```text
buffer = min(40,000, floor(effectiveContextWindow * 0.2))
threshold = effectiveContextWindow - buffer
```

它还包含：

- per-agent context window override；
- session memory compact 优先；
- full summary fallback；
- 摘要成功后重新计算 token；
- 摘要后仍超阈值的失败计数；
- 摘要异常时 local fallback；
- prompt-too-long 后 reactive compact；
- compact/session-memory 子 Agent 递归保护；
- 连续失败断路器：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`。

### 7.2 aiop 当前能力和缺口

`src/agent/context.ts` 当前：

```ts
export const OUTPUT_TOKEN_RESERVE = 32000;
export const CONTEXT_SAFETY_MARGIN = 16000;

export function contextBudgetTokens(
  windowTokens = 200000,
): number {
  return Math.max(
    20000,
    windowTokens - OUTPUT_TOKEN_RESERVE - CONTEXT_SAFETY_MARGIN,
  );
}
```

已有优势：

- 图片 token 估算；
- keep-last-K 图片；
- 单消息 cap；
- 硬裁剪；
- 工具配对保护；
- 用户输入保留；
- summary soft failure。

缺口：

- 没有 per-model `maxOutputTokens`；
- 输出预留固定；
- 没有按模型类别差异化误差 buffer；
- 摘要失败后下一轮仍可重复尝试；
- 缺少 prompt-too-long 后的单次 reactive recovery；
- compaction 失败原因和连续次数观测不完整。

### 7.3 目标设计

建议把计算收敛为纯策略：

```ts
export interface ContextPolicyInput {
  contextWindowTokens: number;
  maxOutputTokens?: number;
  tokenEstimatorClass:
    | 'exact'
    | 'provider_approximate'
    | 'generic_approximate';
  configuredOutputReserve?: number;
  configuredSafetyBuffer?: number;
}

export interface ContextBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyBufferTokens: number;
  inputBudgetTokens: number;
  compactionTriggerTokens: number;
  blockingLimitTokens: number;
}
```

推荐默认算法：

```text
outputReserve = min(
  model.maxOutputTokens ?? existingDefault,
  configuredCap
)

effective = contextWindow - outputReserve

exact/provider-known estimator:
  safetyBuffer = fixed small buffer

generic/third-party estimator:
  safetyBuffer = min(40K, floor(effective * 20%))

compactionTrigger = effective - safetyBuffer
blockingLimit = effective - finalRequestBuffer
```

这些值必须可配置，但不能由未验证请求 body 任意扩大到超过租户策略。

### 7.4 连续失败断路器

建议 tracking 状态：

```ts
export interface CompactionTracking {
  consecutiveFailures: number;
  lastFailureReason?:
    | 'summary_error'
    | 'summary_empty'
    | 'still_over_budget'
    | 'prompt_too_long'
    | 'aborted';
  lastAttemptAt?: string;
  circuitOpen: boolean;
}
```

默认规则：

- 成功压缩：失败数清零；
- 用户 abort：不计入不可恢复失败，但必须停止当前尝试；
- 摘要错误、空摘要或摘要后仍超预算：失败数 +1；
- 连续 3 次失败：打开 circuit，不再每轮自动摘要；
- 新用户输入显著改变历史、模型切换或人工 compact 成功后，可重置；
- circuit 状态进入 checkpoint，避免进程重启后再次无限重试。

### 7.5 Reactive compact

当 provider 返回可识别的 context overflow：

```text
首次请求 prompt-too-long
→ 确认本轮尚未执行副作用工具
→ 执行一次 reactive compact
→ 重新计算预算
→ 只重试一次模型请求
→ 再失败则结束并给出明确错误
```

限制：

- 不能在工具副作用结果未知时重放整个 turn；
- 不把所有 400/413 都当作 context overflow；
- provider adapter 应归一化错误类型；
- 需要记录原模型、预算、估算 token、压缩前后 token 和 retry 次数；
- AbortSignal 必须贯穿摘要模型调用。

### 7.6 与 Checkpoint 的关系

建议 checkpoint 记录：

- catalog revision；
- context policy snapshot；
- compaction tracking；
- summary message；
- compact 前后 token；
- 已发现工具集合；
- provider overflow 错误分类。

恢复时：

- 不重新执行已完成工具；
- 重新校验当前模型权限；
- 如果模型 context 能力变化，重新计算预算；
- 不信任 checkpoint 中旧的 provider secret；
- circuit-open 状态继续生效，除非满足显式重置条件。

### 7.7 测试与验收

1. 32K/64K/128K/200K/1M 窗口预算均为正且不越界；
2. `maxOutputTokens` 小于默认值时减少不必要预留；
3. 第三方估算模型使用 `min(40K, 20%)` buffer；
4. 三次连续失败后不再调用摘要模型；
5. 压缩成功后失败计数清零；
6. prompt-too-long 只 reactive retry 一次；
7. 普通 400 不触发 reactive compact；
8. 有未知 in-flight 工具时不重放整轮；
9. compact 子 Agent 不递归 compact；
10. abort 后无额外模型请求；
11. checkpoint round-trip 保留 tracking；
12. event/audit 不包含被压缩的敏感原文。

---

## 8. 方案四：Protocol-neutral Deferred Tool Discovery

### 8.1 源码证据

Boclaw Tool 支持：

```ts
export type Tool = {
  aliases?: string[];
  searchHint?: string;
  // ...
};
```

`src/tools/ToolSearchTool/ToolSearchTool.ts` 支持：

- `select:<tool_name>` 精确选择；
- 逗号分隔多选；
- MCP server prefix 搜索；
- CamelCase/下划线拆词；
- `+term` 必须匹配；
- `searchHint` 高权重；
- description 低权重；
- 结果按分数排序；
- deferred 集合变化时清空 description cache；
- MCP server 仍连接时返回 pending server 信息。

`src/utils/toolSearch.ts` 支持：

- `tst`、`tst-auto`、`standard` 三种模式；
- deferred schema 超过 context window 10% 时自动启用；
- 精确 token 计数失败时回退 `chars / 2.5`；
- ToolSearchTool 可用性检查；
- proxy compatibility gate；
- experimental beta kill switch；
- model capability gate；
- 已发现工具跨 compaction 继承。

Boclaw 使用 Anthropic beta：

- `defer_loading`；
- `tool_reference`。

其正确安全原则是“假阳性比假阴性危险”：

- 假阴性只是损失上下文优化；
- 假阳性会让 deferred tool 无法调用；
- 未确认支持时应回退 inline tools。

### 8.2 不应直接复制的部分

Boclaw 最终仍使用模型名包含 `claude` 的启发式判断协议能力。aiop 有 Anthropic/OpenAI adapter，应该把协议能力放入 `ModelDescriptor` 或 Provider Adapter，而不是在 Agent Core 中按模型名判断。

不能直接复制：

- Anthropic beta 字段进入 provider-neutral `ToolDef`；
- process-global env 开关作为多租户策略；
- 搜索结果跳过 tenant/user 权限；
- 搜索发现后直接信任旧 catalog；
- 把自由文本 search query 无校验地上报遥测。

### 8.3 目标架构

```text
ToolRegistry
→ ToolCatalog（完整、可信、权限前）
→ ToolCatalogProjector（tenant/user/policy/visibility）
→ ToolDiscoveryPolicy（是否延迟、预算阈值）
→ ProviderToolAdapter
     ├─ Anthropic: inline + defer_loading/tool_reference
     └─ OpenAI/unsupported: inline schema fallback
```

建议契约：

```ts
export interface ToolDiscoveryDescriptor {
  name: string;
  aliases?: string[];
  searchHint?: string;
  source: ToolSource;
  sourceId?: string;
  deferredEligible: boolean;
}

export interface ToolDiscoveryState {
  catalogRevision: string;
  discoveredToolNames: string[];
  pendingSourceIds?: string[];
}
```

### 8.4 启用条件

所有条件同时满足才启用：

1. 当前 `ModelDescriptor.supportsDeferredTools === true`；
2. Provider Adapter 明确支持对应 wire protocol；
3. 当前网关声明能透传必要字段；
4. Tool Search 自身通过 Policy 和 visibility；
5. deferred 工具 schema 超过阈值，或租户策略显式开启；
6. 运行 profile 允许动态发现；
7. catalog revision 有效。

否则：

```text
安全回退为全部允许工具 inline
```

不能因为优化不可用而让工具不可调用。

### 8.5 搜索和权限

权限必须至少执行四次：

```text
catalog projection 前
→ 搜索候选生成前
→ tool discovery 结果确认时
→ ToolRegistry.dispatch 前
```

原因：

- 搜索期间 Skill visibility 可能变化；
- MCP server 可能断开或被禁用；
- 用户角色可能被撤销；
- resume 时旧发现状态可能不再有效。

工具搜索结果只返回当前用户有权看到的工具。不得通过工具名、alias、server prefix 或 searchHint 泄露隐藏工具存在性。

### 8.6 状态持久化

已发现工具状态需要进入：

- Agent Runtime checkpoint；
- compaction metadata；
- resume validation；
- runtime event。

恢复规则：

```text
checkpoint discovered names
→ 重新读取当前 catalog revision
→ 重新执行 tenant/user/role/Skill visibility
→ 保留仍可见工具
→ 删除已撤权或不存在工具
→ catalog revision 变化时重新投影
```

### 8.7 事件建议

- `tool.catalog_projected`；
- `tool.discovery_enabled`；
- `tool.discovery_disabled`；
- `tool.search_started`；
- `tool.search_completed`；
- `tool.discovered`；
- `tool.discovery_invalidated`。

不要在通用遥测中记录原始 search query。若确有运营需求，只记录：

- 查询 token/字符长度；
- required/optional term 数量；
- 命中数量；
- source 类型；
- 延迟和错误分类。

### 8.8 测试与验收

1. 不支持 deferred protocol 的模型始终 inline；
2. Provider 不支持时即使模型配置错误也 fail-safe inline；
3. 10% 阈值边界可重复；
4. token count 失败时字符估算生效；
5. `select:A,B` 只返回有权限的工具；
6. MCP prefix 搜索不泄露 deny server；
7. hidden Skill 不出现在搜索结果；
8. catalog revision 变化后搜索缓存失效；
9. compaction 前后已发现工具保持；
10. resume 后撤权工具被删除；
11. Tool Search 被禁用时所有允许工具仍可调用；
12. Anthropic/OpenAI adapter 分别有 wire snapshot test。

---

## 9. 方案五：多模态翻译路由

### 9.1 源码证据

Boclaw `src/utils/model/visionRouting.ts` 的路由顺序：

```text
1. env 显式覆盖
2. Platform capability
3. modelCapabilities cache
4. 模型名称启发式
5. 当前用户授权模型自动发现
6. 找不到返回 null
```

主模型不支持图片时：

```text
image blocks
→ VLM translator
→ 结构化视觉文本 SIR
→ 替换用户消息或 tool_result 中的图片块
→ 主模型继续推理
```

已验证边界：

- `image-text-to-text` 表示视觉理解；
- 仅 `text-to-image` 的模型不能作视觉 translator；
- 主模型已支持图片时不路由；
- 检查用户 content 和嵌套 tool result 图片；
- 模型匹配使用 exact、大小写不敏感 exact、单向边界前缀；
- 不做危险的内部子串和反向匹配；
- 没有可用 translator 时返回 `null`；
- 测试覆盖 AbortSignal、多图并行、同图去重、失败降级和 metadata 不泄漏。

### 9.2 aiop 目标设计

aiop 已支持图片消息，但没有“主模型无视觉能力时调用辅助 VLM”的 preprocessing 层。建议放在模型请求前：

```text
Agent Runtime / run profile
→ Context Manager
→ MultimodalPreprocessor
→ ChatModel.stream()
```

契约示例：

```ts
export interface MultimodalPreprocessResult {
  messages: Msg[];
  translations: Array<{
    contentHash: string;
    translatorModelId: string;
    confidence?: number;
  }>;
  degraded: boolean;
}
```

原则：

- translator 只能从当前 tenant/user 可见模型中选择；
- 使用 `ModelCapability = image-understanding`；
- translation 结果作为结构化文本，不把内部 `_meta` 发送给主模型；
- 相同图片按内容 hash 去重；
- 多图可有界并行；
- AbortSignal 全链路传播；
- 失败时由租户策略决定“低置信度文本降级”或明确报错；
- 图片敏感级别和数据驻留必须同时适用于 translator provider。

### 9.3 安全重点

图片可能包含凭据、终端输出、客户数据和个人信息。不得仅因为 translator 有能力就跨 provider 发送：

- translator provider 必须满足租户数据边界；
- audit 记录路由但不记录图片内容；
- 缓存 key 使用内容 hash，不在共享缓存存原图；
- 跨租户禁止复用图片翻译缓存；
- 若缓存翻译文本，按 checkpoint 敏感数据要求加密；
- 用户/租户禁用多模态外发时直接失败，不偷偷降级到外部模型。

### 9.4 测试与验收

1. 主模型支持图片时 translator 调用数为 0；
2. 纯生图模型不被选为 translator；
3. 只能选择当前用户有权模型；
4. tool result 嵌套图片可翻译；
5. 相同图片只调用一次；
6. 多图并行有最大并发；
7. abort 终止所有翻译请求；
8. translator 失败行为符合租户策略；
9. 内部 metadata 不进入主模型；
10. 跨 provider 数据驻留不满足时拒绝路由。

---

## 10. 方案六：辅助模型角色、健康状态和 failover

### 10.1 源码证据

Boclaw `src/utils/model/roles.ts` 提供：

- `main/mid/fast` 角色；
- priority + weight 的池选举；
- session affinity；
- 失败 cooldown；
- 请求前健康替换；
- fast → mid → main 降级链；
- 主模型守卫，不把用户主模型静默替换；
- 配置变化时清理 health/affinity；
- 角色 usage 统计和 switch 事件。

测试 `tests/tierFailoverLifecycle.test.mjs` 覆盖：

- `resolveRole('mid')`；
- `markModelUnhealthy()`；
- `getHealthySubstituteForModel()`；
- `setSessionMainModel()`；
- `clearTierHealth()`；
- `clearTierAffinity()`。

### 10.2 适合 aiop 的范围

优先用于辅助角色：

- summary；
- vision；
- embedding；
- rerank；
- fast classification。

主模型自动 failover 必须更保守，因为会改变：

- 回答语义；
- 上下文能力；
- 工具协议；
- 价格；
- 数据驻留；
- 审计归属。

### 10.3 目标设计

健康 key 至少包含：

```text
(tenantId, providerId, modelId, catalogRevision, role)
```

状态示例：

```ts
export interface ModelHealthState {
  status: 'healthy' | 'cooldown' | 'disabled';
  failureClass?:
    | 'rate_limit'
    | 'timeout'
    | 'auth'
    | 'server_error'
    | 'protocol_incompatible';
  cooldownUntil?: string;
  consecutiveFailures: number;
  revision: number;
}
```

注意：

- auth 失败通常是 tenant/provider 配置问题，不应仅切换同一凭据下的模型；
- 429 可短 cooldown；
- 5xx/timeout 可受控切换；
- protocol incompatible 应禁用相关优化，而不是无限重试；
- 配置 revision 变化后清理旧健康状态；
- 多副本需要 Store/共享缓存，不能只用进程全局 `Map`；
- 选择结果写 Runtime Event 和 usage。

### 10.4 测试与验收

1. 两租户同模型健康状态隔离；
2. cooldown 到期恢复；
3. 配置 revision 更新后旧 cooldown 清理；
4. 主模型默认不静默切换；
5. 辅助模型池全部不可用时降级行为明确；
6. 切换后 capability 仍满足请求；
7. 不因 401 盲目轮询全部模型；
8. 旧实例不能覆盖新 revision 健康状态。

---

## 11. 方案七：数据库级 Conversation Branch

### 11.1 Boclaw 机制

Boclaw `Agent.fork()`：

深拷贝：

- `mutableMessages`；
- `appState`；
- `readFileCache`。

共享：

- tools；
- MCP connections；
- initialized promise；
- resolved model。

这适合单进程 SDK 的探索分支，但不适合 aiop 服务端直接复制。

### 11.2 aiop 方案

若产品需要“从历史某点创建分支”，建议数据库建模：

```ts
export interface ConversationBranch {
  sessionId: string;
  parentSessionId: string;
  baseHistoryRevision: number;
  createdByUserId: string;
  createdAt: string;
}
```

原则：

- 不共享进程内 MCP connection；
- 不共享 Sandbox handle；
- 不共享 credential object；
- 不继承未完成 in-flight tool；
- 重新校验 Policy、Skill visibility、模型权限和凭据；
- 历史可以引用不可变 revision，避免大规模复制；
- fork 后形成新 SessionKey 和新 run；
- 父会话后续变化不自动合并到子分支。

优先级低于 Model/Tool/Context 基础能力。

---

## 12. 方案八：遥测字段白名单和外部出口治理

### 12.1 可借鉴点

Boclaw 的 `docs/telemetry-audit.md` 对外部出口做了较完整清单，治理思路包括：

- MCP 工具名脱敏；
- 非白名单 host 归一为 `other`；
- 工具输入长度、JSON 大小和嵌套深度限制；
- PII 字段单独分类；
- 事件失败缓存和重试；
- analytics 默认关闭，显式环境变量才开启。

### 12.2 不能照搬的问题

审计同时暴露出：

- Datadog token 硬编码；
- 外部 Anthropic event endpoint；
- 外部 GCS 插件和更新 endpoint；
- GrowthBook remote eval 发送邮箱、组织和 GitHub metadata；
- analytics disable 不覆盖所有外部请求；
- TypeScript 类型名 `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 不能在运行时证明安全；
- Tool Search 的自由文本 query 可能被类型断言误标为无敏感内容。

aiop 不能复制任何公开 token、外部 endpoint 或默认外发行为。

### 12.3 目标设计

建议为事件定义运行时 schema 和字段 allowlist：

```ts
export interface TelemetryPolicy {
  enabled: boolean;
  allowedSinks: string[];
  allowedEventTypes: string[];
  fieldRules: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'enum';
    maxLength?: number;
    allowedValues?: string[];
    classification: 'operational' | 'identifier' | 'sensitive';
  }>;
}
```

出口统一经过：

```text
Runtime Event / usage / audit
→ schema validation
→ field allowlist
→ redaction/normalization
→ tenant telemetry policy
→ sink allowlist
→ export
```

建议默认：

- 原始 prompt、tool args、tool output、文件路径、代码、图片不进入通用遥测；
- tenantId/userId 使用内部不可逆或受控标识；
- 内部 host 只记录类别，不记录原始域名；
- search query 只记录长度和统计；
- 失败缓存加密、带 TTL、支持租户删除；
- 所有外部 endpoint 通过部署配置显式声明；
- 私有化版本默认无外部出口；
- audit sink 与 telemetry sink 分离。

### 12.4 测试与验收

1. schema 外字段被拒绝而非透传；
2. 超长和深层对象被截断/拒绝；
3. prompt/path/code 不进入 telemetry；
4. telemetry disabled 时所有非必要外部 sink 为 0 请求；
5. 私有化默认无外网 endpoint；
6. 失败缓存加密且到期删除；
7. tenant 删除后缓存事件不可再发送；
8. sink 配置不允许内嵌公开 token。

---

## 13. 方案九：构建期裁剪和发布闸门

### 13.1 Boclaw 机制

`build.ts` 使用构建期 `feature('FLAG')` 常量替换，触发 tree shaking 和 dead-code elimination；正式 minified 包不输出 sourcemap。

`release.ts` 区分：

- test；
- prod；
- sdk。

并提供：

- 未指定 channel 时要求显式 registry；
- prod 检查同版本 test 包；
- `--skip-test-check` 紧急逃生口；
- CLI/SDK dependency pruning；
- tarball 瘦身；
- registry 多重锁定；
- vendor binary 权限修复。

### 13.2 aiop 适用方式

aiop 不需要为了这些能力迁移 Bun。可在现有 Makefile、TypeScript build、容器和 CI/CD 中实现：

- 社区/企业/私有化功能 manifest；
- build-time 常量和条件导入；
- release artifact SBOM；
- sourcemap 分级；
- internal → staging → production promotion gate；
- registry/image registry 显式锁定；
- 私有化镜像外部 endpoint 扫描；
- 不同交付形态的 dependency allowlist。

该项属于发布工程，优先级 P3，不应阻塞 Agent Runtime、Model Catalog 和 Tool Catalog。

---

## 14. 明确不采纳项

### 14.1 Process-global API key、baseURL、model 和 cwd

Boclaw `src/agent.ts` 会写：

```ts
process.env.BOBOT_API_KEY = ...;
process.env.BOBOT_BASE_URL = ...;
process.env.BOBOT_MODEL_DISPLAY_NAME = ...;
```

`QueryEngine.submitMessage()` 还会依赖全局 cwd。虽然源码在逐步补充 per-agent gateway/context override 和 ALS session context，但全局状态仍是明显的并发限制。

aiop 必须继续使用：

- tenant-scoped Store 配置；
- `RequestContext`；
- request/run profile；
- ToolContext；
- Sandbox isolation；
- per-run model instance/route。

### 14.2 默认 bypass permissions

Boclaw SDK 默认 `permissionMode` 为 `bypassPermissions`，并且多个 mode 分支最终默认 allow。该行为不适合 aiop。

aiop 必须保持：

```text
Policy
→ Approval
→ PreToolUse Hook
→ dispatch-time authorization
```

模型可见过滤只减少误调用和 token，不是最终安全边界。

### 14.3 本地 transcript 和单用户配置目录

`~/.bobot/projects`、`~/.bobot.json`、本地模型 capability cache 适合桌面/CLI，不适合作为多租户服务端真实来源。

aiop 使用 Store、加密 checkpoint、history revision 和租户隔离。

### 14.4 共享 MCP connection 的内存 fork

共享 MCP connection、credential 或 Sandbox handle 会造成：

- 身份串用；
- 会话状态污染；
- 取消和生命周期混乱；
- 审计归属错误。

aiop 若做 branch，只能共享不可变历史引用，运行资源必须重新绑定。

### 14.5 未实现的 SDK abort

Boclaw `Agent.abort()` 当前为空实现，不能作为 aiop 取消机制参考。aiop 应按 Agent Runtime 的持久 injection gate、AbortController、quiesce deadline 和 `recovery_required` 执行。

### 14.6 实现镜像测试

测试中复制源码逻辑会导致双份实现漂移。aiop 应直接 import 真实纯函数和 adapter，使用 unit、contract、integration 和 failure injection 测试。

### 14.7 外部遥测 token 和 endpoint

不得迁移：

- 硬编码 Datadog token；
- 外部 Anthropic event logging；
- 外部 GCS 更新或插件下载；
- 默认 remote evaluation；
- 仅靠 TypeScript 断言证明无敏感数据。

---

## 15. 与 Agent Runtime 设计的集成

### 15.1 组件关系

```text
HTTP / CLI / Scheduler
          │
          ▼
AgentRuntime
  ├─ TurnCoordinator
  ├─ CheckpointManager
  ├─ ModelCatalog
  ├─ ModelRouter
  ├─ ContextPolicy
  ├─ MultimodalPreprocessor
  ├─ ToolCatalogProjector
  └─ ToolDiscoveryPolicy
          │
          ▼
existing runAgent()
          │
          ├─ Provider Adapter
          └─ ToolExecutionPlanner
```

### 15.2 职责边界

`AgentRuntime`：

- 可信身份；
- run/session；
- profile snapshot；
- model route；
- checkpoint；
- runtime event；
- durable state。

`runAgent()`：

- 模型—工具循环；
- 当前上下文；
- tool call/result 回填；
- Provider-neutral stream。

`ModelCatalog/Router`：

- 当前用户可见模型；
- capability 匹配；
- role 和 fallback；
- 不持有 secret。

`ToolCatalog/Discovery`：

- 模型可见工具；
- 稳定顺序；
- 搜索和 deferred projection；
- 不替代 dispatch 鉴权。

`ContextPolicy`：

- budget 计算；
- compact 决策；
- circuit breaker；
- reactive overflow recovery。

### 15.3 Profile snapshot 增量

Agent Runtime 的 run profile 建议增加：

```ts
export interface ModelRoutingProfileSnapshot {
  requestedModelId?: string;
  selectedModelId: string;
  selectedProviderId: string;
  selectedCatalogRevision?: string;
  selectedCapabilities: ModelCapability[];
  fallbackPolicy: 'none' | 'auxiliary_only' | 'explicit_primary';
}

export interface ToolDiscoveryProfileSnapshot {
  mode: 'inline' | 'auto' | 'deferred';
  catalogRevision: string;
  thresholdTokens?: number;
  providerProtocol: 'inline' | 'anthropic_tool_reference';
}
```

快照用于审计和恢复，不用于绕过恢复时的实时权限校验。

### 15.4 Checkpoint 增量

建议增加：

- selected model descriptor 安全快照；
- catalog revision；
- context policy 结果；
- compaction circuit state；
- multimodal translation hash/result metadata；
- discovered tool names；
- tool catalog revision；
- provider protocol capability。

不得保存：

- API key；
- Authorization header；
- 未加密图片原文；
- 可跨用户复用的 credential object；
- 进程内 MCP/Sandbox handle。

---

## 16. 安全与多租户总边界

### 16.1 身份

> 身份只来自服务端验证过的 JWT（`RequestContext.userId`），永远不来自聊天文本、请求 body 或 LLM 输出。

- 不信任聊天中的身份声明；
- 不信任 LLM 输出的 userId；
- 工具 schema 不暴露可切换身份的 tenantId/userId；
- Channel/Webhook sender 必须先验签和账号绑定；
- resume 必须重新校验用户状态、角色和权限；
- disabled 用户不能 resume。

### 16.2 模型和 provider

- 模型目录按 tenant/user entitlement 过滤；
- fallback 不能跨数据驻留和合规边界；
- provider secret 仅在受控创建/请求层使用；
- 事件只记录安全 ID，不记录 secret；
- 模型能力未知时使用保守行为；
- 主模型变更必须显式可见。

### 16.3 工具

- Skill visibility 在展示和执行链双重检查；
- MCP server 权限在搜索和 dispatch 双重检查；
- deferred discovery 不能泄露隐藏工具；
- 注入用户凭据的 Sandbox 不能跨用户复用；
- 工具 schema 不允许模型指定其他 tenant/user；
- 工具并发和恢复按 Agent Runtime 设计执行。

### 16.4 持久化

- Checkpoint/input/inbox 的敏感原文加密；
- image translation 文本按敏感数据处理；
- cache key 包含 tenant/user 或使用严格租户分区；
- catalog cache 不存 provider secret；
- 失败事件缓存加密、带 TTL 和删除能力。

### 16.5 可观测性

- Event、audit、日志不得泄露凭据；
- 原始 prompt/tool args/tool output 默认不进遥测；
- 所有 route/fallback/compact/discovery 行为可审计；
- 外部 sink 必须显式配置和 allowlist；
- 私有化部署默认无外部遥测出口。

---

## 17. 分阶段实施建议

### Phase 0：快速稳定化

目标：低风险获取立即收益，为后续机制建立基础。

1. ToolRegistry defs 确定性排序；
2. 明确工具来源和名称冲突策略；
3. 增加 tool catalog snapshot test；
4. 为 `ModelConfig` 补充可选 `maxOutputTokens`；
5. 记录当前模型路由和 context budget 的结构化内部事件。

完成标准：

- 相同工具集合在任意注册顺序下输出一致；
- 现有 provider/tool 行为不变；
- 没有新的外部依赖。

### Phase 1：Model Catalog 基础

1. 定义 `ModelDescriptor` 和 capability；
2. 从当前 config/store 构造 catalog；
3. 租户/用户可见性过滤；
4. catalog revision 和 cache；
5. 模型选择和审计事件；
6. 保持现有默认模型行为作为兼容入口。

完成标准：

- 所有模型请求能解释 selected model 和 capability 来源；
- 两租户目录严格隔离；
- 不依赖具体模型名称完成主路由。

### Phase 2：Context Policy 增强

1. 动态输出预留；
2. 模型类别差异化安全 buffer；
3. compaction failure tracking；
4. 连续 3 次失败断路器；
5. provider overflow 归一化；
6. 单次 reactive compact；
7. checkpoint/runtime event 集成。

完成标准：

- 长会话失败次数可控；
- 不可恢复会话不再每轮浪费摘要调用；
- overflow recovery 不重放未知副作用工具。

### Phase 3：Deferred Tool Discovery

1. ToolCatalogEntry/searchHint/aliases；
2. provider-neutral discovery state；
3. catalog 搜索；
4. 权限四阶段校验；
5. Anthropic adapter deferred projection；
6. unsupported provider inline fallback；
7. compaction/checkpoint 恢复；
8. schema token 预算和 auto threshold。

完成标准：

- 不支持协议时功能正确性不下降；
- 大工具集输入 token 显著下降；
- 隐藏工具无法通过搜索推断。

### Phase 4：多模态和辅助模型高可用

1. vision translator；
2. 图片去重和有界并行；
3. tenant data boundary；
4. summary/vision 辅助模型 role pool；
5. tenant-scoped health/cooldown；
6. fallback 事件和 usage 归属。

完成标准：

- 主模型无视觉能力时可安全完成图片任务；
- 辅助模型失败不会污染主模型语义；
- 所有跨模型路由可解释、可审计。

### Phase 5：治理和交付

1. telemetry schema/allowlist；
2. 外部出口 inventory；
3. 私有化 no-egress 验证；
4. build-time feature manifest；
5. release promotion gate；
6. 可选 conversation branch。

---

## 18. 成本、收益和风险汇总

| 建议 | 收益 | 开发成本 | 运行成本 | 主要风险 | 缓解措施 |
|---|---|---:|---:|---|---|
| Model Catalog | 高 | 中 | 低 | 目录缓存/权限错误 | tenant key、revision、fail-closed |
| Stable Tool Catalog | 中 | 小 | 极低 | 顺序变化影响 snapshot | 兼容测试、分区稳定排序 |
| Context Policy | 高 | 中 | 降低 | 错误阈值导致过早/过晚 compact | 多窗口测试、指标观测 |
| Deferred Tool Discovery | 高 | 中到大 | 降低 token | provider 假阳性导致工具不可用 | capability 正向 gate、inline fallback |
| Vision Translator | 中到高 | 中 | 增加辅助调用 | 图片跨 provider 泄露 | 数据驻留 gate、租户可见模型 |
| Model Health/Failover | 中 | 中 | 低 | 静默语义/计费漂移 | 辅助模型优先、主模型显式切换 |
| Telemetry Governance | 中到高 | 中 | 低 | 漏字段、缓存泄露 | runtime schema、加密 TTL |
| Conversation Branch | 中 | 中 | 存储增加 | 资源/凭据错误共享 | 仅共享不可变历史 |
| Build/Release Gate | 中 | 中 | 构建增加 | 交付矩阵复杂 | manifest、promotion test |

---

## 19. 建议指标

### 19.1 Model Catalog

- route selection success rate；
- no-capability-match rate；
- catalog refresh age/failure；
- fallback rate；
- route 后 provider/model usage 一致率。

### 19.2 Context

- compaction trigger rate；
- compaction success rate；
- summary 后仍超预算率；
- circuit-open session 数；
- prompt-too-long rate；
- reactive compact recovery rate；
- 每会话重复失败节省的模型调用。

### 19.3 Tool Catalog/Discovery

- inline/deferred tool schema tokens；
- tool search enable rate；
- search hit rate；
- discovered tool count；
- catalog invalidation count；
- unsupported provider fallback count；
- permission-filtered candidate count。

### 19.4 Multimodal

- vision route rate；
- translator success/failure；
- image dedupe rate；
- translation latency；
- data-boundary rejection count。

所有指标只记录聚合和安全字段，不记录原始 prompt、图片、路径、工具输入或工具输出。

---

## 20. 最终建议

### 20.1 应立即做

1. **Stable Tool Catalog**：最小改动、最低风险、立即提高可预测性和 prompt cache 稳定性；
2. **Model Catalog 设计和基础实现**：后续所有模型路由能力的共同前置；
3. **Compaction failure circuit breaker**：可独立落地，直接减少失败会话的重复模型调用；
4. **`maxOutputTokens` + 动态预算**：修正固定输出预留。

### 20.2 应在 Agent Runtime 一期之后或并行设计

1. Deferred Tool Discovery；
2. vision translator；
3. tenant-scoped auxiliary model health；
4. route/discovery/compact checkpoint metadata。

### 20.3 暂不做

1. 复制 Boclaw QueryEngine；
2. 复制本地 transcript/session store；
3. 复制 process-global env/cwd；
4. 复制内存 fork 和共享 MCP connection；
5. 迁移 Bun 构建链；
6. 引入外部 Datadog/Anthropic/GCS endpoint；
7. 把默认权限改成 bypass；
8. 依赖模型名称决定安全能力。

总体结论：Boclaw 对 aiop 最有价值的增量集中在 **模型能力目录、工具目录、上下文韧性和延迟工具协议**。这些能力应以 aiop 现有 provider-neutral、多租户、Policy/Approval、Store 和 Agent Runtime 为基础重新实现，借鉴机制而不复制其单用户 CLI 和 process-global 状态模型。
