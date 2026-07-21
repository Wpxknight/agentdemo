# Agent Runtime 一期实现设计

> 状态：实现设计稿  
> 范围：仅覆盖一期四项——**AgentRuntime + TurnCoordinator、统一 Message Envelope / Runtime Event、工具并发安全声明、工具边界 Checkpoint**。  
> 原则：在现有 `runAgent()` 外围增强运行时能力，不重写模型—工具循环，不改变 Policy、Approval、Hook、Skill、Sandbox 和多租户安全边界。

---

## 1. 背景与结论

aiop 已具备完整的模型—工具循环、Provider Adapter、上下文压缩、工具注册、策略审批、Hook、SSE、Scheduler 和多租户存储。当前主要问题不是“缺少 Agent Loop”，而是运行协调能力分散在各入口：

- HTTP 在 `src/server/http.ts` 内直接管理 `AbortController`、活跃运行、pending message、审批/提问、SSE、消息持久化和 usage 审计；
- CLI 在 `src/index.ts` 内自行加载历史、调用 `runAgent()`、追加消息；
- Scheduler 在 `src/scheduler/runner.ts` 内重复相同链路；
- `runAgent()` 对同一轮模型返回的所有工具调用直接 `Promise.all()`，没有工具级并发安全声明；
- 运行状态只存在于进程内，工具完成后、最终消息落库前发生中断时，没有可恢复的稳定状态；
- `Msg` 与 `StreamEvent` 是模型上下文和模型/工具流事件，不适合作为 transport-neutral 的消息与运行生命周期契约。

一期采用以下架构：

```text
HTTP / CLI / Scheduler
          │
          │ verified RequestContext + MessageInput
          ▼
┌───────────────────────────────────────────────────────────────┐
│ AgentRuntime                                                  │
│  - 构造可信 Message Envelope                                  │
│  - 加载/提交会话历史                                           │
│  - 选择 Policy / Approval / Interaction profile               │
│  - 发布 Runtime Event                                         │
│  - 保存 Run / Checkpoint / Usage                              │
│                                                               │
│   ┌─────────────────────┐   ┌──────────────────────────────┐   │
│   │ TurnCoordinator     │   │ CheckpointManager            │   │
│   │ - 同 session 串行   │   │ - 稳定边界快照               │   │
│   │ - pending injection │   │ - 加密/版本/恢复校验         │   │
│   │ - cancel / lease    │   │ - 会话 revision 冲突保护     │   │
│   └──────────┬──────────┘   └──────────────┬───────────────┘   │
└──────────────┼─────────────────────────────┼───────────────────┘
               │                             │
               ▼                             │
        existing runAgent()                  │
               │                             │
               ▼                             │
      ToolExecutionPlanner ──────────────────┘
      - parallel
      - serial barrier
      - same-resource serial
```

核心结论：

1. `src/runtime.ts` 的 `Runtime` 继续作为 composition root；新增 `agentRuntime` 组件，不用新接口替代整个 root Runtime。
2. `runAgent()` 继续负责模型调用、消息上下文、工具回填和循环终止；session coordination、持久化、身份和 transport 不进入该函数。
3. 同一会话的串行键必须是 `(tenantId, userId, sessionId)`，不能只用 tenant + session。
4. Runtime Event 与现有 `StreamEvent` 分离；前者描述 run/turn 生命周期，后者保留为 runner 内部事件。
5. 未声明并发策略的工具默认串行；只有完成审计并显式声明安全的工具才能并行。
6. Checkpoint 只保存稳定边界，不恢复半截 token 流；已完成工具不重放，结果不确定的副作用工具默认进入人工恢复。
7. 一期不承诺任意工具“exactly once”。能够保证的是：**有已持久化结果的工具不重复执行；结果未知的非幂等工具不自动重试。**

---

## 2. 范围

### 2.1 本期范围

1. **AgentRuntime + TurnCoordinator**
   - 统一 HTTP、CLI、Scheduler 的 turn 执行入口；
   - 同 session 串行、跨 session 并行；
   - pending message 注入、取消、运行状态、会话提交；
   - 为多副本增加 session lease 的目标设计和分阶段落地。

2. **Message Envelope + Runtime Event**
   - transport-neutral 输入契约；
   - run/turn/message/checkpoint 生命周期事件；
   - 现有 SSE 的兼容适配。

3. **工具并发安全声明**
   - `ToolHandler` 执行元数据；
   - parallel / serial / resource 三种模式；
   - 默认串行、结果顺序稳定、Policy/Approval/Hook 不绕过。

4. **工具边界 Checkpoint**
   - run、durable inbox 与 latest checkpoint 数据模型；
   - 工具逐个完成后的结果持久化；
   - pending message 持久化；
   - 中断后的显式恢复和安全重试判断。

### 2.2 明确不在本期

- Channel Adapter、Webhook Trigger、Durable Trigger；
- Model fallback / 多模型路由；
- 长期记忆、用户画像、自动记忆抽取；
- Background Subagent；
- Runtime Event 全量持久化和事件回放总线；
- 从任意 token delta 恢复模型流；
- 跨外部系统的分布式事务；
- 把所有工具改造成业务级幂等；
- 替换现有 Scheduler 的数据库 claim 机制。

---

## 3. 现状与问题

### 3.1 HTTP 运行协调与 transport 耦合

`src/server/http.ts` 当前直接持有：

```ts
type ActiveAgentRun = {
  abort: AbortController;
  append: (message: Msg) => void;
  drain: () => Msg[];
};

type ActiveAgentRuns = Map<string, Set<ActiveAgentRun>>;
```

并在 `runAgentSse()` 内完成：

```text
认证
→ 同 session 冲突检查
→ 建 SSE
→ 注册 active run
→ 加载历史
→ 构造 approval/question callbacks
→ runAgent()
→ appendMessages()/replaceMessages()
→ usage audit
→ done/error/terminated SSE
→ 冲刷 leftover pending messages
```

问题：

- CLI、Scheduler 无法复用协调逻辑；
- HTTP 连接关闭等同运行取消，运行生命周期被 transport 生命周期控制；
- active run 和 pending message 只在当前进程，多副本下 append/cancel 必须命中同一副本；
- 当前 `activeRunKey()` 仅包含 tenantId + sessionId，未包含 userId；
- `runAgent()` 成功返回前，当前 turn 的消息没有稳定落点；进程中断后只能整轮丢失。

### 3.2 `Msg` 不是消息总线契约

`Msg` 表示模型上下文：

```ts
interface Msg {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  contentBlocks?: ToolContentBlock[];
}
```

它不包含 messageId、来源、可信身份、幂等键、接收时间和投递语义。HTTP body 当前直接被转换为 `Msg`，后续接 CLI、Scheduler 或 Channel 时容易把 transport 字段、身份字段和模型字段混在一起。

### 3.3 `StreamEvent` 不描述 run 生命周期

现有 `StreamEvent` 适合描述一次模型/工具流：

- `thinking_delta`、`text_delta`；
- `tool_call`、`tool_output`、`tool_result`；
- `model_retry`、`usage`、`context_compacted`；
- `todo_updated`、`file_exported`、`stop`。

它缺少：

- run accepted/queued/started；
- turn 状态变化；
- message queued/injected；
- checkpoint saved；
- run completed/failed/cancelled/interrupted；
- 统一 eventId、sequence、runId、turnId 和可信身份元数据。

直接把这些事件继续塞入 `StreamEvent` 会让 Provider Adapter 与 session/runtime 生命周期耦合。

### 3.4 所有工具调用无条件并行

`src/agent/core.ts` 当前使用：

```ts
const results = await Promise.all(
  calls.map((call) => runOneCall(call, opts)),
);
```

这对只读查询有效，但以下工具不应无条件并发：

- 浏览器 navigate/click/type 依赖同一页面状态；
- 同一沙箱的文件写入、命令和导出可能互相干扰；
- Scheduler 创建/修改/删除存在顺序依赖；
- MCP 工具语义未知，默认并行不安全；
- 同一资源上的变更操作需要串行。

### 3.5 没有工具边界恢复

当前消息只在完整 `runAgent()` 成功后批量提交。典型风险：

```text
模型返回 tool A + tool B
→ tool A 已完成外部变更
→ 进程中断
→ turn 未落库
→ 用户重试
→ tool A 再执行一次
```

如果只在“全部工具完成”后保存 checkpoint，tool A 完成、tool B 尚未完成时仍会丢失 A 的完成事实。因此 checkpoint 必须能记录同一 tool batch 中的部分完成结果，但不能把不完整的 tool-result 消息发送给模型。

---

## 4. 设计原则与默认决策

| 决策项 | 一期定稿 | 原因 |
|---|---|---|
| Agent Core | 保留 `runAgent()`，只增加 runner boundary 与 resume 输入 | 降低重写风险，复用现有上下文、重试、压缩与工具链 |
| 统一入口 | 新增 `AgentRuntime`，HTTP/CLI/Scheduler 分期迁移 | transport 变薄，行为一致 |
| session 串行键 | `(tenantId, userId, sessionId)` | 与当前用户级会话隔离一致 |
| 同 session 新 run | Coordinator 串行；HTTP 第一阶段保持 409，Scheduler/CLI 使用 enqueue | 兼容现有前端，同时建立统一能力 |
| 活跃 run 追加消息 | 只在模型轮次边界注入；工具执行中不注入 | 复用现有语义，避免修改正在执行的 tool batch |
| Scheduler 消息 | 永不注入交互 run，只排成下一 turn | 防止自动任务污染用户当前指令 |
| Runtime Event | 独立于 `StreamEvent` | 解耦 runner 与 transport/runtime |
| Runtime Event 持久化 | 一期不建 event 表；run/checkpoint 是事实源 | 避免 token/tool-output 事件造成高写放大 |
| 工具默认并发 | 未声明即 `serial` | 安全默认，未知 MCP/Skill 不冒险并行 |
| resource key 失败 | 回退 `serial`，不回退 parallel | fail closed |
| 结果顺序 | 始终按模型 tool call 原顺序回填 | 保持 Provider 兼容和测试稳定 |
| Checkpoint 频率 | input、完整模型轮次、每个 tool result、tool batch、final answer | 防止已完成副作用被重放 |
| Checkpoint 内容 | 最新快照覆盖写；payload 加密 | 控制写放大，避免敏感 args/result 明文落库 |
| 自动恢复 | 默认不自动恢复交互 run；显式 resume | 审批、问题和副作用不确定性要求安全优先 |
| in-flight 非幂等工具 | `recovery_required`，不自动重试 | 无法判断中断前是否已生效 |
| 会话提交 | run terminal 前事务提交，并校验 `history_revision` | 防止压缩覆盖和并发历史冲突 |
| SSE 兼容 | Runtime Event 内部生效，HTTP adapter 先映射为现有 SSE 名称 | 前端零破坏迁移 |

---

## 5. 术语与 ID

### 5.1 Turn、Run、Attempt

- **turnId**：一次逻辑输入，从用户消息或自动任务被接受起，到最终完成/失败。pending injection 不新建 turn；排队的新任务新建 turn。
- **runId**：该 turn 的持久化运行记录。显式 resume 继续使用原 runId。
- **attempt**：同一 runId 的执行尝试次数。首次为 1，每次 resume 加 1。
- **messageId**：输入 envelope 的唯一 ID；注入消息各自有独立 messageId。
- **event sequence**：单个执行 attempt 内单调递增；eventId 固定为 `${runId}:${attempt}:${sequence}`。一期不保存 Runtime Event 流，因此 resume 后 sequence 从 1 重新开始，以 attempt 区分；不得声称支持跨重启事件游标续接。
- **checkpointNo**：单 run 跨 attempt 单调递增；只保留最新 checkpoint payload。

### 5.2 状态

```ts
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_question'
  | 'committing'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'recovery_required';
```

允许的主要迁移：

```text
queued → running
start(collision=reject) → running（原子创建，不落 accepted 中间态）
running → waiting_approval → running
running → waiting_question → running
running/waiting_* → committing → completed
queued → cancelled
running/waiting_* → cancelling → cancelled/recovery_required
running/waiting_*/committing → failed
running/waiting_*/committing → interrupted
interrupted/failed/recovery_required → running  (显式 resume，attempt + 1)
interrupted → recovery_required             (存在未知副作用)
```

不可恢复终态：`completed | cancelled`。  
执行停止态：`failed | interrupted | recovery_required`；`wait()` 在这些状态也结束等待并返回对应结果，但是否允许后续 `resume` 由 checkpoint 校验决定。`queued/running/waiting_*/committing/cancelling` 仍是非结束态。所有状态迁移都使用 `stateVersion + expectedStatus + expectedAttempt` CAS；lease-protected 迁移还必须验证 fencing token，禁止 late callback、旧 owner 或并发 cancel/resume 覆盖新状态。

---

## 6. 模块边界与建议文件布局

```text
src/agent/runtime/
├── types.ts               # AgentRuntime、run/result/status 等公共类型
├── envelope.ts            # MessageInput 校验、可信 Envelope 构造、Msg 映射
├── events.ts              # RuntimeEvent、sequence、StreamEvent 映射、脱敏
├── coordinator.ts         # 同 session 队列、pending injection、cancel、进程内锁
├── session-lease.ts       # 多副本 session lease（分阶段启用）
├── checkpoint.ts          # 状态快照、加密、版本、恢复判定
├── interaction.ts         # Approval/Question/Plan adapter
└── agent-runtime.ts       # 统一 orchestration facade

src/agent/tool-execution.ts # ToolExecutionPlanner
src/agent/core.ts           # 保留 runAgent；增加 boundary/resume 扩展点
src/agent/tools.ts          # ToolHandler.execution 元数据与 registry 查询
src/runtime.ts              # 组装 agentRuntime

src/db/
├── store.ts                # run/checkpoint/lease Store API
├── memory.ts               # 内存语义实现
├── mysql.ts                # MySQL 事务与 CAS/lease 实现
├── schema.ts               # Kysely 类型
└── migrations/0010_agent_runtime.sql
```

职责约束：

| 模块 | 负责 | 不负责 |
|---|---|---|
| `AgentRuntime` | run lifecycle、配置装配、历史加载/提交、事件、checkpoint、usage | 解析 HTTP、签 JWT、模型协议适配 |
| `TurnCoordinator` | session 串行、队列、pending、abort、injection gate | DB 消息格式、Policy 判断、工具业务逻辑 |
| `runAgent` | 模型—工具循环、上下文、重试、压缩、runner boundary | session 锁、认证、SSE、Store |
| `ToolExecutionPlanner` | 工具执行顺序、并发组、结果顺序 | 判定用户身份、绕过 Policy/Approval/Hook |
| `CheckpointManager` | 保存/加载/加密/版本/恢复判断 | 直接执行工具、决定 transport 响应 |
| HTTP adapter | authenticate、body→input、Runtime Event→SSE、交互端点 | active run Map、直接调用 `runAgent` |

---

## 7. Message Envelope

### 7.1 外部输入与内部可信 Envelope 分离

公开 Runtime API 不接受调用方指定 tenantId/userId。可信身份必须作为独立的 `RequestContext` 参数传入，由 Runtime 构造内部 envelope：

```ts
export type AgentMessageSource =
  | 'http'
  | 'cli'
  | 'scheduler'
  | 'aios'
  | 'internal';

export type AgentDeliveryIntent =
  | 'turn'         // 新 turn
  | 'inject'       // 注入当前活跃 turn
  | 'persist_only';// 空闲会话只落历史，不调用模型

export interface AgentMessageInput {
  sessionId: string;
  text?: string;
  contentBlocks?: ToolContentBlock[];
  source: AgentMessageSource;
  delivery: AgentDeliveryIntent;
  /** transport 生成的幂等键；不得包含 token/密码。 */
  idempotencyKey?: string;
  /** 仅用于追踪和展示，不参与授权。 */
  metadata?: Record<string, JsonValue>;
}

export interface AgentMessageEnvelopeV1 {
  schemaVersion: 1;
  messageId: string;
  sessionId: string;
  actor: {
    tenantId: string;
    userId: string;
    role: Role;
  };
  source: AgentMessageSource;
  delivery: AgentDeliveryIntent;
  content: {
    text?: string;
    contentBlocks?: ToolContentBlock[];
  };
  idempotencyHash?: string;
  metadata?: Record<string, JsonValue>;
  createdAt: string;
}

export function createMessageEnvelope(
  ctx: RequestContext,
  input: AgentMessageInput,
): AgentMessageEnvelopeV1;
```

安全要求：

1. HTTP body schema 中不得增加 `tenantId/userId/role`；即使 body 出现也忽略或拒绝。
2. Channel/Webhook 后续接入时，sender 必须先经服务端验签和账号绑定映射为 `RequestContext`，不能直接把 sender name 当 userId。
3. `metadata` 永远不参与 RBAC、Skill visibility、凭据查找或 Store 过滤。
4. `idempotencyKey` 入库前保存 SHA-256，不保存可能带业务信息的原文。
5. metadata 最大深度 4、最多 64 个键、UTF-8 JSON 序列化后最大 16 KiB；超限拒绝输入。
6. `text` 与 `contentBlocks` 至少一个非空；沿用现有单条正文、图片和附件上限，规范化后再次校验总字节数。
7. `start()` 只接受 `delivery='turn'`；公开 `append()` 只接受 `delivery='inject'`，由 Runtime 根据持久 gate 决定 queued 或 persist_only。`persist_only` 只允许 Runtime 内部构造，外部 body 不能借此绕过模型/协调语义。
8. `source` 由 HTTP/CLI/Scheduler adapter 固定，不接受同一 transport 的 body 覆盖；`aios` 为预留枚举，不代表一期新增 Channel Adapter。
9. Runtime Event、日志及明文运行列均不得包含 Bearer token、用户密码、AIOS token 或完整敏感环境变量；Envelope 仅在加密的 input/inbox/checkpoint payload 中保存恢复所需原文。

### 7.2 Envelope 到 `Msg` 的映射

只有 `AgentRuntime`/`envelope.ts` 可以把输入映射为模型消息：

```ts
export function envelopeToUserMsg(
  envelope: AgentMessageEnvelopeV1,
): Msg {
  return {
    role: 'user',
    text: envelope.content.text,
    contentBlocks: envelope.content.contentBlocks,
  };
}
```

`actor/source/idempotency/metadata` 不进入模型上下文，除非某个明确、经过审查的 source adapter 把必要的非敏感来源说明转换为普通文本。

### 7.3 幂等语义

- HTTP 可用客户端 requestId；
- Scheduler 使用 `task:<taskId>:due:<scheduledTime>`；
- CLI 默认不提供；
- 唯一范围为 `(tenantId, userId, sessionId, source, idempotencyHash)`，避免客户端在不同 session 复用 requestId 时错误命中其他会话；
- 重复提交还必须比对持久化的 request fingerprint（消息正文/contentBlocks/profile 的规范化摘要）；完全一致才返回已有 runId/status，不一致返回幂等键冲突，不创建第二个 turn；
- 幂等只防重复接收，不代表外部工具天然幂等。

---

## 8. Runtime Event 契约

### 8.1 基础类型

```ts
export interface RuntimeEventBase {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  emittedAt: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  attempt: number;
}

export type RuntimeEvent =
  | (RuntimeEventBase & {
      type: 'run.accepted';
      source: AgentMessageSource;
      status: 'queued' | 'running';
      messageId: string;
    })
  | (RuntimeEventBase & {
      type: 'run.status_changed';
      from: AgentRunStatus;
      to: AgentRunStatus;
      reason?: string;
    })
  | (RuntimeEventBase & {
      type: 'turn.started';
      baseHistoryRevision: number;
    })
  | (RuntimeEventBase & {
      type: 'message.queued';
      messageId: string;
      queueDepth: number;
    })
  | (RuntimeEventBase & {
      type: 'message.injected';
      messageId: string;
      step: number;
    })
  | (RuntimeEventBase & {
      type: 'model.text_delta';
      text: string;
    })
  | (RuntimeEventBase & {
      type: 'model.thinking_delta';
      text: string;
    })
  | (RuntimeEventBase & {
      type: 'model.retry';
      attemptNo: number;
      maxAttempts: number;
      discardTextChars: number;
      discardThinkingChars: number;
      discardToolIds: string[];
      error: string;
    })
  | (RuntimeEventBase & {
      type: 'tool.call_created';
      call: ToolCall;
    })
  | (RuntimeEventBase & {
      type: 'tool.output_delta';
      toolCallId: string;
      stream: 'stdout' | 'stderr';
      text: string;
    })
  | (RuntimeEventBase & {
      type: 'tool.completed';
      toolCallId: string;
      toolName: string;
      isError: boolean;
    })
  | (RuntimeEventBase & {
      type: 'interaction.required';
      interactionId: string;
      interactionKind: 'approval' | 'question' | 'change_plan';
      payload: JsonValue;
    })
  | (RuntimeEventBase & {
      type: 'context.compacted';
      beforeTokens: number;
      afterTokens: number;
      summarizedMessages: number;
    })
  | (RuntimeEventBase & {
      type: 'checkpoint.saved';
      checkpointNo: number;
      boundary: CheckpointBoundary;
      step: number;
    })
  | (RuntimeEventBase & {
      type: 'run.completed';
      steps: number;
      text: string;
      usage: Usage;
      context: SessionContextUsage;
      cost: CostEstimate;
    })
  | (RuntimeEventBase & {
      type: 'run.failed';
      code: string;
      error: string;
      recoverable: boolean;
    })
  | (RuntimeEventBase & {
      type: 'run.cancelled';
      reason: string;
    })
  | (RuntimeEventBase & {
      type: 'run.interrupted';
      reason: string;
      recovery: 'safe' | 'manual' | 'unavailable';
    });
```

为保持现有前端零破坏，v1 还必须显式包含并透传以下事件：

```ts
| (RuntimeEventBase & {
    type: 'todo.updated';
    todos: TodoItem[];
  })
| (RuntimeEventBase & {
    type: 'file.exported';
    name: string;
    url: string;
    size: number;
    mime: string;
    expiresAt: string;
  });
```

`thinking_block` 和 `usage` 继续由 `runAgent()` 内部消费，不直接成为客户端 Runtime Event；累计 usage 只在 `run.completed` 和 `agent_runs.usage` 中出现。`stop` 由 Runtime 根据最终状态映射为 completed/failed/cancelled，不直接透传。

### 8.2 事件规则

1. sequence 在同一 attempt 内严格递增；resume 后 attempt 加 1、sequence 从 1 开始。由于一期不持久化事件流，不支持按 eventId 跨重启补发。
2. `RuntimeEventBroadcaster` 为每个订阅者维护独立有界缓冲；事件消费速度不影响 `completion` 和 checkpoint。`DisconnectPolicy=continue` 关闭当前订阅后不保留无人消费的 delta，也不承诺重连补发；run 状态和最终结果由 `getRun/wait` 重建。
3. `run.completed` 必须在会话消息和 run terminal 状态事务提交成功后发布。
4. `checkpoint.saved` 只能在 checkpoint 已落库后发布。
5. lifecycle 事件不可因慢消费者丢弃；`text_delta/tool_output_delta` 一期保持现有实时语义。单消费者缓冲区达到 1,000 个事件或 8 MiB 时，Runtime 主动关闭该消费者；是否取消业务 run 由 `DisconnectPolicy` 决定，不能阻塞 runner/checkpoint。
6. `tool.call_created` 内部事件保留完整 `ToolCall`，因为现有前端用 args 生成步骤标签和沙箱命令预览；只允许发往当前已认证用户的私有流，不写日志/audit。脱敏后的公共事件协议未来另行版本化，不能在兼容迁移中静默删除 args。
7. 工具输出需经过长度限制和敏感信息脱敏；数据库不持久化 delta 事件。
8. 错误只发布安全错误码与脱敏消息，原始 stack 仅写服务端日志。

### 8.3 与现有 SSE 的兼容映射

第一阶段内部使用 Runtime Event，HTTP adapter 继续输出现有 SSE：

| Runtime Event | 兼容 SSE |
|---|---|
| `run.accepted` | `session`，payload 保持 `sessionId` 并增加 `runId/turnId` |
| `model.text_delta` | `text_delta` |
| `model.thinking_delta` | `thinking_delta` |
| `tool.call_created` | `tool_call`，payload 保持 `{ call }` |
| `tool.output_delta` | `tool_output` |
| `tool.completed` | `tool_result` |
| `interaction.required/approval` | `approval_required` |
| `interaction.required/question` | `question_required` |
| `interaction.required/change_plan` | `change_plan_required` |
| `todo.updated` | `todo_updated` |
| `file.exported` | `file_exported` |
| `context.compacted` | `context_compacted` |
| `run.completed` | `done` |
| `run.cancelled` | `terminated` |
| `run.failed` | `error` |

前端迁移完成后，可增加 `runtime-v1` SSE profile；一期不要求前端同时消费两套事件，避免重复渲染。

---

## 9. AgentRuntime 接口

### 9.1 公共接口

```ts
export type RunCollisionPolicy = 'reject' | 'enqueue';
export type DisconnectPolicy = 'cancel' | 'continue';

export interface InteractiveRunProfile {
  kind: 'interactive';
  /** 一期 interaction 是 owner 进程对象，不可跨实例排队。 */
  collision: 'reject';
  disconnect: DisconnectPolicy;
  interaction: InteractionAdapter;
  maxSteps?: number;
  maxRunMs?: number;
}

export interface UnattendedRunProfile {
  kind: 'unattended';
  collision: 'enqueue';
  preApproved: boolean;
  maxSteps?: number;
  maxRunMs: number;
}

export type AgentRunProfile =
  | InteractiveRunProfile
  | UnattendedRunProfile;

/** 可加密持久化并由任意 worker 重建；不得保存 InteractionAdapter 等进程对象。 */
export type AgentRunProfileSnapshot =
  | {
      schemaVersion: 1;
      kind: 'interactive';
      collision: 'reject';
      disconnect: DisconnectPolicy;
      maxSteps?: number;
      maxRunMs?: number;
    }
  | {
      schemaVersion: 1;
      kind: 'unattended';
      collision: 'enqueue';
      preApproved: boolean;
      maxSteps?: number;
      maxRunMs: number;
    };

export interface StartAgentRunInput {
  message: AgentMessageInput;
  profile: AgentRunProfile;
}

export interface CompletedAgentRunResult {
  runId: string;
  turnId: string;
  sessionId: string;
  status: 'completed';
  text: string;
  steps: number;
  usage: Usage;
  context: SessionContextUsage;
  cost: CostEstimate;
}

export interface NonCompletedAgentRunResult {
  runId: string;
  turnId: string;
  sessionId: string;
  status:
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'recovery_required';
  code: string;
  message: string;
  recoverable: boolean;
}

export type AgentRunResult =
  | CompletedAgentRunResult
  | NonCompletedAgentRunResult;

export interface AgentRunReceipt {
  runId: string;
  turnId: string;
  sessionId: string;
  status: AgentRunStatus;
  duplicate: boolean;
}

export interface AgentRunHandle
  extends Omit<AgentRunReceipt, 'status'> {
  status: 'running';
  events: AsyncIterable<RuntimeEvent>;
  completion: Promise<AgentRunResult>;
  cancel(reason?: string): Promise<AgentRunSummary>;
  disconnect(): Promise<void>;
}

export interface AppendMessageResult {
  messageId: string;
  sessionId: string;
  disposition: 'queued' | 'persisted';
}

export interface AgentRuntime {
  start(
    ctx: RequestContext,
    input: StartAgentRunInput,
  ): Promise<AgentRunReceipt | AgentRunHandle>;

  wait(
    ctx: RequestContext,
    runId: string,
    signal?: AbortSignal,
  ): Promise<AgentRunResult>;

  append(
    ctx: RequestContext,
    input: AgentMessageInput,
  ): Promise<AppendMessageResult>;

  cancel(
    ctx: RequestContext,
    sessionId: string,
    reason?: string,
  ): Promise<AgentRunSummary[]>;

  getRun(
    ctx: RequestContext,
    runId: string,
  ): Promise<AgentRunSummary | undefined>;

  resume(
    ctx: RequestContext,
    runId: string,
    interaction?: InteractionAdapter,
  ): Promise<AgentRunReceipt | AgentRunHandle>;

  dispose(): Promise<void>;
}
```

`start/wait/append/cancel/getRun/resume` 均显式接收 `RequestContext`；Store 层继续按 tenantId + userId 强制过滤。任何 runId/sessionId 都不能成为越权能力 URL。`wait()` 必须以 Store 中的结束状态 `completed/failed/cancelled/interrupted/recovery_required` 为事实源，并 resolve 对应的 `AgentRunResult` union；只有调用方 `signal` 中止或 Store 不可用时才 reject。进程内通知只用于降低轮询延迟，不能成为 queued run 完成语义的唯一依据。HTTP `res.close` 调用 `handle.disconnect()`：profile 为 `cancel` 时请求取消，profile 为 `continue` 时只解除当前 event subscription，不影响业务 run。

### 9.2 InteractionAdapter

```ts
export interface InteractionAdapter {
  requestApproval(input: RuntimeApprovalRequest): Promise<boolean>;
  askQuestions(input: RuntimeQuestionRequest): Promise<QuestionAnswers | null>;
  requestPlanApproval(input: RuntimePlanRequest): Promise<boolean>;
}
```

实现：

- HTTP P3：桥接现有 `InMemoryApprovalStore`、`InMemoryQuestionStore` 并发布 `interaction.required`；一期 interactive profile 只允许 `collision='reject'`，不把带 `InteractionAdapter` 的 run durable enqueue 到其他实例。P5 多副本仍不把进程内 Promise 当 durable 状态，断开/owner 丢失后统一 interrupted，resume 时由新 owner 绑定新的 adapter 并重新发起交互；
- Scheduler：全部拒绝，保持 `AutoDenyGate` 语义；
- CLI：第一阶段保持当前 `AutoApproveGate` 行为，后续可单独收紧；
- checkpoint/resume 后，旧进程内 interaction promise 不可恢复，resume 必须重新发布新的 interactionId 并重新确认；
- 旧审批结果不能自动跨进程沿用；已完成工具有 checkpoint 结果时无需重新审批和执行；
- `PlanApprovalState`、approval/question pending key 必须改为 `(tenantId,userId,sessionId,runId,attempt)`，terminal/cancel/lease loss 时清理。不得继续使用只含 sessionId 的全局 Set/Map；回答接口也必须验证同一 user/session/run，防止同租户其他用户代答。

本节接口中引用的 `AgentRunSummary`、`RuntimeApprovalRequest`、`RuntimeQuestionRequest`、`RuntimePlanRequest` 均在 `types.ts` 定义为只含安全 DTO 的版本化类型；不得直接复用含完整凭据或内部 Store 行的对象。`AgentRunSummary` 至少包含 runId/turnId/sessionId/status/attempt/stateVersion/source/mode/steps/errorCode/recoverable/timestamps，不包含加密 payload、完整 tool args/result。

### 9.3 Root Runtime 接线

`src/runtime.ts` 增加：

```ts
export interface Runtime {
  // existing fields ...
  agentRuntime: AgentRuntime;
}
```

`buildRuntime()` 在 model、tools、policy、hooks、Store、Skill、Sandbox 组装完成后创建 `AgentRuntime`。关闭顺序必须调整为：先停止 AgentRuntime 接收/领取新 run，给 active run 最多 30 秒 quiesce，剩余 run 按取消规则标 interrupted/recovery_required 并释放 lease；再等待 HTTP server/SSE 关闭，最后关闭 Store/Sandbox/MCP。不能先无限等待 `server.close()`，否则长 SSE/interaction 会阻止 `agentRuntime.dispose()` 执行。

---

## 10. TurnCoordinator

### 10.1 SessionKey

```ts
export interface SessionKey {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export function encodeSessionKey(key: SessionKey): string {
  return JSON.stringify([
    key.tenantId,
    key.userId,
    key.sessionId,
  ]);
}
```

禁止用显示名、Channel sender、body 中的 userId 或 LLM 输出构造 key。

### 10.2 并发规则

1. 同一个 SessionKey 同时最多一个 `running/waiting_*` run。
2. 不同 session 可并行。
3. 同 tenant 下不同 user 的同名 session 可并行。
4. 同 user 的不同 session 可并行。
5. `collision=reject`：必须在创建 durable run 之前，先用 Coordinator/数据库 lease 检查活跃 run；冲突时返回 domain error，由 HTTP 映射为当前 409，不留下无主的 accepted run/checkpoint。检查与 acquire 必须是一个原子操作，不能采用“先查再插”的竞态实现。
6. `collision=enqueue`：只允许可序列化的 unattended profile；创建 durable queued run，按 `(created_at, run_id)` FIFO。enqueue 不返回依赖当前进程内 Promise 的 handle；返回 durable `AgentRunReceipt`，调用方通过 `wait(runId)`/`getRun(runId)` 获取结果。只有立即取得 slot 的 interactive reject run 才返回带实时 events 的 `AgentRunHandle`。
7. Scheduler/自动任务只 enqueue，不 inject。
8. 普通 `/append`：
   - 活跃 run 且 injection gate 开启 → pending queue；
   - 无活跃 run → 直接 `persist_only`；
   - terminal commit 开始前，Runtime 先在 session lock/lease 下把 status CAS 为 `committing` 并关闭 injection gate；
   - 观察到 `committing` 时，append 等待该 commit 完成（默认最多 5 秒），随后按 `persist_only` 调用 `appendMessage()`；若等待超时返回 503，客户端可用相同 messageId 重试。不得在 commit 使用旧 revision 时并发写会话，也不得自动新建 Agent turn。
9. queued run 开始执行前重新读取当前 session history 和 revision，因此排队期间的 `persist_only` 消息会自然成为其上下文；accepted checkpoint 只保存输入 envelope，不固定 base history。

### 10.3 Pending message 规则

- 单副本 P3 中，pending envelope 在 append API 返回成功前写入 latest checkpoint；P5 多副本启用后，成功条件改为写入 durable `agent_run_inbox`，由 lease owner 消费并 checkpoint；两种模式都只有 Runtime owner/CheckpointManager 能分配 checkpointNo，append handler 不得提交完整 runner snapshot；
- 只在 `runAgent()` 模型轮次边界 drain；
- 工具 batch 执行中不注入；
- waiting approval/question 期间可接收普通追加消息，但它不是审批/问题答案；
- drain 后发布 `message.injected` 并保存 checkpoint；
- 默认上限：每个活跃 run 32 条、序列化后 8 MiB；服务端配置只能调低；超限返回 429，并复用现有 HTTP body/附件单条限制；
- 单副本 checkpoint 写失败、或多副本 inbox 写失败时 append 返回失败，不能声称 queued=true；
- messageId 用于去重，同一 messageId 只注入一次；inbox 使用 `(run_id, message_id)` 唯一键实现幂等。

### 10.4 取消

取消流程：

```text
cancel(ctx, sessionId)
→ 验证 SessionKey 归属
→ status: running/waiting_* → cancelling
→ AbortController.abort(reason)
→ 停止启动新的 tool group
→ 关闭 injection gate
→ 对 status=queued 的同 session run 按 cancel scope 原子 queued → cancelled，并删除其未执行 checkpoint/inbox
→ 等待已启动工具协作退出或返回，默认 quiesce deadline 30 秒
→ 已返回的工具结果先 checkpoint
→ 检查是否仍有无结果的 in-flight 工具
   ├─ 无 → status → cancelled
   └─ 有/等待超时 → status → recovery_required（不能声称副作用已停止）
→ 未注入 pending 按 persist_only 落会话
→ 仅确认无 started/in-flight 时，cancelled 删除 checkpoint；recovery_required 保留 checkpoint
```

说明：

- AbortSignal 是协作取消，不能保证外部命令立刻停止；
- 工具在取消信号发出后仍可能完成。完成结果必须先保存，避免后续误判为未执行；
- 显式取消不把当前未完成 turn 的 assistant/tool 半截消息提交到正常会话历史，保持当前 HTTP 测试语义；
- 若有非幂等工具在 quiesce deadline 后仍无结果，API/SSE 返回“已请求终止、状态待核实”，而不是 `terminated/cancelled` 成功，并保留 checkpoint；
- late callback 只能在原 lease token 与 `stateVersion/attempt` 仍匹配时合并结果；否则数据库拒绝写入，服务端只记录脱敏告警，不能把旧 attempt 改回 running/completed；
- `cancel(ctx, sessionId)` 一期定义为取消该 SessionKey 的 active run 和全部 queued run。queued run 直接 `queued → cancelled`，从 FIFO 中剔除，不执行模型/工具；
- 取消前已存在的历史不删除。

### 10.5 多副本 session lease

进程内 Map 只能保证单副本。目标实现增加 `agent_session_leases`：

- lease TTL 默认 60 秒；
- 每 20 秒续约；这两个值写为配置默认值，需满足 heartbeat ≤ TTL/3；
- acquire/renew/release 使用 ownerId + generation CAS；
- lease 丢失立即 abort 当前 run，标记 `interrupted`，不能继续调用新工具；
- 只有持有 lease 的实例可更新该 run 的 checkpoint 和提交会话；
- queued run 由 queue worker 通过 `SELECT ... FOR UPDATE SKIP LOCKED` 领取；领取事务必须同时 CAS `queued → running`、写 owner/started_at，并 acquire 对应 session lease，任一步失败则整笔回滚；
- worker 每 1 秒 poll，单批最多 20 条；按 `(created_at, run_id)` 选择，但某 session lease 不可用时跳过该 run，让其他 session 继续执行，避免队头阻塞；
- HTTP 第一阶段仍可使用 reject，降低跨副本排队复杂度；Scheduler enqueue 由 worker 领取。

所有 lease-protected 写操作都必须携带 `SessionLeaseToken { tenantId,userId,sessionId,runId,ownerId,generation }`：`updateAgentRunStatus()`、`saveAgentCheckpoint()`、`completeAgentRun()`、保留证据时的 checkpoint 删除/清理，在同一事务内验证 lease 行仍归当前 run/owner、generation 一致且未过期。每次 mutation 同时以 `expectedStateVersion + expectedStatus + expectedAttempt` CAS `agent_runs`；任一条件不匹配都返回 typed stale-write 结果，禁止重试为无条件写。仅在进程内判断“我还持有 lease”不够；旧 owner 即使延迟恢复，也必须被数据库拒绝写入。续约和过期判断统一使用数据库时间（`CURRENT_TIMESTAMP(3)`），避免 Pod 时钟漂移。

跨副本 `/append` 不直接改 owner 的 checkpoint：新增 durable `agent_run_inbox`（见 §15），append 事务写入 inbox 后即可成功返回；owner 只在模型边界 claim 未消费 inbox，合并进 checkpoint，并把对应行标为 consumed。这样 append 可命中任意副本，不需要 sticky routing，也不会与 owner-only checkpoint fencing 冲突。

分阶段启用见 §17。未启用数据库 lease/inbox 时，生产部署必须使用单副本；sticky routing 只能降低 HTTP 命中错误副本的概率，不能协调 Scheduler 或 Pod 故障，因此不视为多副本安全方案。

---

## 11. AgentRuntime 运行流程

### 11.1 交互式 run

```text
HTTP authenticate → verified RequestContext
    │
    ▼
AgentRuntime.start(ctx, message, interactive profile)
    │
    ├─ 校验 input / 构造可信 envelope
    ├─ 幂等检查
    ├─ TurnCoordinator 原子 acquire/reject
    ├─ create running agent_run + accepted checkpoint（事务）
    ├─ publish run.accepted
    └─ 进入执行
             │
             ▼
      lease/session slot acquired
             │
             ├─ load session messages + history_revision
             ├─ save input_accepted checkpoint
             ├─ status running / turn.started
             ├─ build policy, permission filter, hooks, interaction
             └─ runAgent(...)
                    │
                    ├─ StreamEvent → RuntimeEvent
                    ├─ runner boundary → CheckpointManager.save()
                    ├─ drain pending envelopes at model boundary
                    └─ ToolExecutionPlanner executes calls
             │
             ▼
      completeAgentRun transaction
             ├─ verify history_revision
             ├─ append or replace messages
             ├─ update session history_revision
             ├─ update agent_runs completed + usage
             └─ delete latest checkpoint
             │
             ├─ usage audit（失败不回滚已完成 run）
             ├─ publish run.completed
             └─ release slot/lease → next queued turn
```

`run.completed` 只在事务完成后发布，因此前端收到 done 后再请求消息一定能看到最终历史。

### 11.2 Scheduler

Scheduler 继续负责：

- 原子 claim due tasks；
- 计算 `maxRunMs`；
- 写 `task_runs`。

单次执行改为：

```ts
const receipt = await rt.agentRuntime.start(taskCtx, {
  message: {
    sessionId: task.sessionId,
    text: task.task,
    source: 'scheduler',
    delivery: 'turn',
    idempotencyKey: `task:${task.id}:due:${dueAt}`,
  },
  profile: {
    kind: 'unattended',
    collision: 'enqueue',
    preApproved: task.preApproved,
    maxRunMs,
  },
});
const result = 'completion' in receipt
  ? await receipt.completion
  : await rt.agentRuntime.wait(taskCtx, receipt.runId);
```

约束：

- `maxRunMs` 和版本化 `AgentRunProfileSnapshot` 加密持久化在 `agent_runs.input_payload`；worker 必须只靠 Store 中的初始 envelope + profile snapshot 重建运行，不能依赖提交进程内对象；
- 排队等待时间不计入，从 status 原子迁移到 running 时启动 deadline，owner 重启/resume 后按 `started_at + max_run_ms` 计算剩余时间，不能重置 4 小时预算；
- 无人值守继续使用 `AutoDeny`、unattended system prompt、用户 Skill visibility 和用户凭据作用域；
- 自动任务不得注入正在进行的交互 turn；
- `TaskRunner` 返回 `agentRunId` 与最终结果，ticker 沿用当前“runner 完成后一次 `recordTaskRun()`”流程写入 `task_runs.agent_run_id`；一期不新增 running task_run API。queued run 可由 `agent_runs` 独立追踪，worker 完成后 `wait()` 返回结果，ticker 再写业务 task_run。

### 11.3 CLI

CLI 改为调用 `agentRuntime.start()`；事件 adapter 只打印 `model.text_delta` 和必要的工具/错误状态。CLI 不再自行 list/append messages。

---

## 12. 工具并发安全声明

### 12.1 类型

并发元数据放在 `ToolHandler`，不放进模型可见的 `ToolDef`：

```ts
export type ToolConcurrencyDecision =
  | { mode: 'parallel' }
  | { mode: 'serial' }
  | { mode: 'resource'; key: string };

export type ToolConcurrencyResolver = (
  args: JsonValue,
  ctx: ToolContext,
) => ToolConcurrencyDecision;

export interface ToolRecoveryPolicy {
  /** 中断时结果未知，是否允许自动重试。缺省 false。 */
  retrySafe?: boolean;
}

export interface ToolExecutionMetadata {
  concurrency?: ToolConcurrencyDecision | ToolConcurrencyResolver;
  recovery?: ToolRecoveryPolicy;
}

export interface ToolHandler {
  def: ToolDef;
  execution?: ToolExecutionMetadata;
  run(args: JsonValue, ctx: ToolContext): Promise<ToolResult>;
}
```

默认值：

```ts
const DEFAULT_TOOL_EXECUTION: ToolExecutionMetadata = {
  concurrency: { mode: 'serial' },
  recovery: { retrySafe: false },
};
```

resolver 抛错、返回空 key 或 key 超长时回退 `serial` 并记录 warning；绝不回退 parallel。

### 12.2 三种模式

#### parallel

- 可与当前并发段中的其他 parallel 调用同时执行；
- 仅用于无共享可变状态，或底层已保证并发安全的工具；
- 典型：独立 WebFetch、只读文件、独立资源查询。

#### serial

- 在当前模型 tool-call 列表中作为 barrier；
- barrier 前的并发段全部完成后才执行；
- 该调用独占执行，完成后才进入下一段；
- 典型：ask_user、change_plan、语义未知的 MCP、未审计工具。

#### resource

- 相同 key 串行，不同 key 可并行；
- 保持同 key 的模型原始顺序；
- key 是执行层内部值，不发送给模型；
- 一期至少保证当前 tool batch 内的 resource serialization；跨 run 的全局资源锁不在一期强制范围，外部系统仍应有自己的并发控制。

示例 key：

```text
browser:<tenantId>:<userId>:<sessionId>
sandbox:<tenantId>:<userId>:<sandboxKey>
kubectl-write:<tenantId>:<cluster>:<namespace>
schedule:<tenantId>:<userId>
file:<tenantId>:<userId>:<sessionId>:<normalizedPath>
```

不得把密码、token 或完整命令作为 key。资源 key 先规范化，再做 SHA-256；原始 key UTF-8 长度上限 1 KiB，超限回退 serial。

### 12.3 执行规划算法

输入：模型返回的有序 `ToolCall[]`。  
输出：按原 call 顺序排列的 `ToolResult[]`。

算法：

1. 为每个 call 从 ToolRegistry 读取 execution metadata；
2. 按原顺序扫描：
   - 连续 parallel/resource 调用进入同一并发段；
   - serial 调用结束当前段，等待段完成，再单独执行；
3. 并发段内：
   - parallel 各自执行；
   - resource 按 key 分组，每组内部串行，不同组并行；
4. planner 的并发 decision 在执行前确定，但每个 call 的完整链路都封装在共享 `ToolExecutor.executeOne()` 中：

```text
Policy check
→ Approval（如需）
→ PreToolUse Hook
→ checkpoint tool.started
→ ToolRegistry.dispatch
→ checkpoint tool.completed
→ emit tool.completed
```

5. `ToolExecutionPlanner` 只安排何时调用 `ToolExecutor.executeOne()`，不复制 Policy/Approval/Hook/dispatch 逻辑；直接 HTTP 单工具调用也复用同一个 executor；
6. 任何结果按 call 的原始 index 放回结果数组；完成事件可按真实完成顺序发布；
7. 收到 AbortSignal 后不再启动新 group；已经启动的调用等待协作取消/返回；
8. serial barrier 包含 approval/question 等等待时间，避免其后工具越过需要确认的操作；
9. 执行采用 `Promise.allSettled` 收敛已启动的并发段。某个 checkpoint/dispatch 失败时停止后续 group，但仍等待其他已启动调用返回并尽力保存；任何已完成却未能持久化的调用按 unknown/manual 处理。

伪代码：

```ts
export interface ToolExecutionPlanner {
  execute(
    calls: ToolCall[],
    context: ToolExecutionContext,
  ): Promise<ToolResult[]>;
}
```

`ToolExecutionContext` 复用现有 policy/approval/hooks/onEvent，并增加 `onToolStarted()`、`onToolCompleted()` 两个 async checkpoint 回调。

### 12.4 首批工具标注建议

| 工具类别 | 建议策略 | recovery 默认 |
|---|---|---|
| `web_fetch` | parallel | 首期 false；仅在 handler 明确使用幂等 GET、可接受重复审计/限流影响并传播 AbortSignal 后标 true |
| `load_skill`、`skill__read_file` | parallel | true |
| `skill__sync_to_sandbox` | resource(session sandbox) | false |
| browser navigate/click/type/screenshot | resource(browser session) | false |
| sandbox run code/command/file write/export | resource(sandbox key) | false |
| `kubectl` 只读命令 | resource(cluster) | 首期 false；只对白名单纯查询且支持可靠取消的子命令单独放宽 |
| `kubectl` 变更命令 | resource(cluster/namespace) | false |
| `todo_write` | resource(session) | true |
| `ask_user`、`submit_change_plan` | serial | false |
| schedule create/update/delete | resource(user schedule set) | false |
| MCP | 默认 serial；仅配置/代码明确声明后放宽 | false |
| 未知 Skill tool | serial | false |

`kubectl` 等工具允许 resolver 根据 args 动态分类；并发分类不能替代 Policy 的 allow/deny/ask。`ToolContext` 增加 `signal: AbortSignal`，内置工具应逐项传播到底层 fetch/SDK/sandbox；未传播取消的工具不得因“看似只读”就声明 retrySafe。

### 12.5 ToolRegistry 变更

新增已解析的只读查询，不向外暴露可变 handler：

```ts
executionFor(
  call: ToolCall,
  ctx: ToolContext,
): {
  concurrency: ToolConcurrencyDecision;
  recovery: Required<ToolRecoveryPolicy>;
};
```

该方法统一应用默认 serial/retrySafe=false，并处理 resolver 异常和 resource key 校验，planner 不再重复解析。

直接 HTTP 工具调用也应复用共享 `ToolExecutor`，避免 `/v1/tools/call` 与 Agent 路径产生不同的 Policy/Hook 行为。但一期 resource serialization 的强保证仅限同一个 Agent tool batch；单次 direct call 没有跨请求全局 resource lane，可能与 Agent 正在操作同一 browser/sandbox 并发。P1 不得宣称全局资源安全；要提供该保证必须由 TurnCoordinator/共享 ResourceLockManager 按 SessionKey/resource key 协调，列为后续独立增强。

---

## 13. Runner Boundary 与 Checkpoint

### 13.1 Checkpoint 边界

```ts
export type CheckpointBoundary =
  | 'run.accepted'
  | 'input.accepted'
  | 'context.compacted'
  | 'assistant.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool_batch.completed'
  | 'message.injected'
  | 'final.completed';
```

边界含义：

| 边界 | 保存时机 | 价值 |
|---|---|---|
| `run.accepted` | run/idempotency/envelope 已持久化 | 排队或进程中断不丢输入 |
| `input.accepted` | 已取得 session slot，加载 base history | 固定 history revision |
| `context.compacted` | 摘要成功改写 working history 后 | 避免重复摘要费用和历史分叉 |
| `assistant.completed` | 一次模型流完整结束，assistant Msg 已形成 | 不保存半截 token；恢复可继续工具阶段 |
| `tool.started` | Policy/Approval/Hook 已放行、真正 dispatch 之前 | 中断后能识别“结果未知”的调用 |
| `tool.completed` | 单个 dispatch 已返回结果后，立即保存 | 已完成工具不重放 |
| `tool_batch.completed` | 本轮所有 ToolResult 已按原顺序组装 | 恢复可直接进入下一模型轮次 |
| `message.injected` | pending 已从队列移入 working messages | 消息只注入一次 |
| `final.completed` | 最终 assistant 无 tool calls | 可执行 terminal session commit |

不保存：

- `thinking_delta/text_delta/tool_output_delta`；
- 尚未完整返回的模型流；
- 尚未返回结果的 tool call“成功”状态。

### 13.2 `runAgent()` 扩展点

新增以下接口：

```ts
export interface PendingToolBatchState {
  assistantMessageIndex: number;
  calls: ToolCall[];
  resultsByCallId: Record<string, ToolResult>;
  /** dispatch 前已持久化为 started、但尚无持久化结果的调用。 */
  inFlightCallIds: string[];
  /** tool.started 时冻结；恢复不得使用更宽松的新部署声明。 */
  recoveryByCallId: Record<string, {
    toolName: string;
    retrySafe: boolean;
  }>;
}

export interface AgentRunnerState {
  schemaVersion: 1;
  phase:
    | 'before_model'
    | 'executing_tools'
    | 'after_tools'
    | 'completed';
  messages: Msg[];
  steps: number;
  usage: Usage;
  compacted: boolean;
  compactionWatermarkTokens: number;
  lastText: string;
  pendingToolBatch?: PendingToolBatchState;
}

export type RunnerBoundaryDelta =
  | {
      boundary: Exclude<
        CheckpointBoundary,
        'tool.started' | 'tool.completed'
      >;
      /** 非并行工具边界可提交当前一致快照。 */
      state: AgentRunnerState;
    }
  | {
      boundary: 'tool.started';
      callId: string;
      toolName: string;
      recovery: Required<ToolRecoveryPolicy>;
    }
  | {
      boundary: 'tool.completed';
      callId: string;
      result: ToolResult;
    };

export interface RunAgentOptions {
  // existing fields ...
  resumeState?: AgentRunnerState;
  onBoundary?: (
    delta: RunnerBoundaryDelta,
  ) => Promise<void>;
}
```

要求：

1. `onBoundary` 是 async，`runAgent()` 必须等待保存完成后才能进入下一个可能产生副作用的步骤；
2. 每个真正的 `ToolRegistry.dispatch` 前，必须先把 callId 加入 `inFlightCallIds` 并等待 `tool.started` checkpoint 成功。Policy block、Approval deny、Hook deny 没有触发外部 dispatch，可直接形成错误 ToolResult，不标记 in-flight；
3. tool dispatch 返回后，先把结果合并到 `resultsByCallId`、从 `inFlightCallIds` 删除并等待 `tool.completed` checkpoint，再响应 post-dispatch abort；这个顺序把不确定窗口缩小为“外部调用已开始但结果尚未持久化”；
4. `onBoundary` 不允许并行 callback 提交完整、可能陈旧的 `AgentRunnerState`。工具边界只上报 delta；CheckpointManager 持有单一 authoritative aggregate，在 per-run mutex 内 merge delta、递增 checkpointNo、clone 后保存。mutex + checkpointNo CAS 共同防止陈旧结果覆盖，单纯串行保存旧快照不满足要求；
5. `resumeState.pendingToolBatch` 中已有结果的 call 直接跳过；从未 started 的缺失 call 正常执行；仍在 `inFlightCallIds` 的 call 使用 checkpoint 中冻结的 recovery policy 判断，不能读取部署后可能更宽松的新 metadata；
6. 所有结果齐备后才向 `messages` 追加一条完整的 `{role:'tool', toolResults:[...]}`；模型永远看不到半个 tool batch；
7. checkpoint codec 必须完整 round-trip `Msg` 的所有字段，包括 `thinkingBlocks`、`contentBlocks`、toolCalls/toolResults；Anthropic thinking signature 不得在恢复时丢失。

### 13.3 Checkpoint payload

```ts
export interface AgentCheckpointV1 {
  schemaVersion: 1;
  runId: string;
  turnId: string;
  checkpointNo: number;
  boundary: CheckpointBoundary;
  baseHistoryRevision?: number;
  baseMessageCount?: number;
  /** 未压缩时只保存本 run 相对 base history 的增量。 */
  workingTail?: Msg[];
  /** 发生摘要压缩后保存完整 working history。 */
  compactedHistory?: Msg[];
  runner: Omit<AgentRunnerState, 'messages'>;
  /** P3 单副本兼容字段；P5 durable inbox 启用后为空。 */
  pendingEnvelopes: AgentMessageEnvelopeV1[];
  injectedMessageIds: string[];
  createdAt: string;
}
```

恢复：

```text
load current session + history_revision
→ revision 与 checkpoint.baseHistoryRevision 比较
→ 相同：base history + workingTail，或直接 compactedHistory
→ 恢复 runner state
→ pending envelope 去重
→ 判断 in-flight tools
```

如果 revision 不一致：标记 `recovery_required`，禁止 `replaceMessages()` 覆盖新历史。

### 13.4 敏感数据与加密

Checkpoint 可能必须保存 ToolCall args 和 ToolResult，单纯脱敏会破坏恢复。因此：

- `agent_checkpoints.payload` 保存**版本化加密 envelope**，不使用明文 JSON 列；
- 使用 AES-256-GCM，格式包含 `keyId/nonce/tag/ciphertext`；
- MySQL + checkpoint enabled 时必须配置 `AIOP_CHECKPOINT_KEY_BASE64`，缺失则启动失败；
- MemoryStore 可使用进程内随机 key，但重启后本来就不具备持久恢复；
- Runtime Event、audit、log 仍只输出脱敏元数据，不能因为 checkpoint 已加密就放宽日志；
- payload 大小上限固定默认 32 MiB，可由服务端配置调低；启动时校验该值小于数据库 `max_allowed_packet` 的安全预算。超限时 run 继续执行会失去恢复保证，因此应 fail closed 并明确报错，而不是静默不保存；contentBlocks 中的大附件/图片优先保存引用而非重复内联 base64，避免每个工具边界全量放大；
- `agentRuntime.checkpoint.enabled=true` 且使用 MySQL 时强制执行 key 和 packet-size 启动校验；flag=false 时表可存在但不读写 checkpoint，不能静默写明文；
- key rotation 通过 keyId 支持旧 key 解密，新 checkpoint 用当前 key；
- 禁止在 `agent_runs.error_message/usage` 等明文字段写入完整工具参数、结果或凭据。

### 13.5 Checkpoint 失败策略

- `run.accepted/input.accepted` 保存失败：不开始模型调用；
- `assistant.completed` 保存失败：不开始工具；
- `tool.started` 保存失败：不 dispatch 对应工具；
- `tool.completed` 保存失败：不开始后续 group，当前已启动的 parallel 调用等待收敛并尽力保存；由于结果未能持久化，相关调用视为结果未知，run 标记 `recovery_required`（除非全部 retrySafe）；
- `final.completed` 保存失败：不发布 done；
- Store 短暂错误最多重试 3 次，指数退避 100/200/400ms；
- 不允许“记录日志后忽略 checkpoint 失败继续执行副作用工具”。

---

## 14. 恢复语义

### 14.1 恢复级别

```ts
export type RecoveryDecision =
  | { kind: 'safe' }
  | {
      kind: 'manual';
      uncertainToolCalls: Array<{
        id: string;
        name: string;
      }>;
    }
  | { kind: 'unavailable'; reason: string };
```

判定：

| Checkpoint 状态 | 决策 |
|---|---|
| before model / 完整 assistant 且未启动工具 | safe；可重新调用模型或执行工具 |
| tool batch 中部分 call 已有结果，其余从未启动 | 已有结果跳过；未启动按正常执行 |
| 存在 in-flight 但无结果，且全部 `retrySafe=true` | safe；允许重试缺失调用 |
| 存在 in-flight 且任一 `retrySafe=false` | manual；标记 `recovery_required` |
| checkpoint 解密失败/版本不支持 | unavailable |
| session history revision 已变化 | manual/unavailable，不自动覆盖 |
| 处于 waiting approval/question | 可恢复到等待点，但必须重新发起交互并重新确认 |

### 14.2 显式 resume

一期默认不在服务启动时自动继续交互 run：

1. recovery scanner 查找过期 lease 下的 `running/waiting_*/cancelling`；
2. 标记 `interrupted`；
3. 加载 latest checkpoint 并计算 RecoveryDecision；
4. safe：允许用户调用 resume；
5. manual：一期前端展示不确定工具列表，只允许：
   - 放弃当前 run，并由用户在新 turn 中基于已核实的外部状态继续；
   - 用户明确确认所有不确定工具均未生效后，重试缺失调用。该确认写 runtime audit；
   - 一期不接受客户端伪造 ToolResult，也不提供“确认已生效后注入等价结果”，避免篡改模型历史和绕过工具审计；
6. unavailable：只允许放弃并开启新 turn。

P5 新增：

```text
GET  /v1/agent/runs/:runId
POST /v1/agent/runs/:runId/resume
POST /v1/agent/runs/:runId/cancel
```

所有接口按 `(tenantId,userId,runId)` 过滤；跨用户返回 404。

### 14.3 不承诺 exactly-once

外部系统调用存在经典“不确定结果窗口”：请求已到下游并生效，但 aiop 在收到/保存响应前中断。除非下游支持幂等键或查询确认，否则无法仅靠本地 checkpoint 判断结果。

因此：

- `retrySafe=false` 是默认；
- 对支持幂等键的工具，工具实现应使用稳定的 `runId + toolCallId` 生成下游 idempotency key，再声明 retrySafe；
- 对只读调用可声明 retrySafe；
- Checkpoint 解决“已知完成结果不重放”，不能消除所有外部副作用不确定性。

### 14.4 保留策略

默认保留策略：

- completed：terminal commit 后立即删除 checkpoint；
- cancelled：仅在确认无 started/in-flight 调用、所有已返回结果已保存后删除 checkpoint；
- failed/interrupted/recovery_required：保留 7 天；
- agent_runs：默认保留 90 天，可由合规配置延长；
- 清理由独立轻量 sweep 完成；不复用 Scheduler 用户任务。

---

## 15. 数据模型与数据库迁移

新增 `0010_agent_runtime.sql`，只做 additive migration，不修改历史迁移。

### 15.1 sessions history revision

```sql
ALTER TABLE sessions
  ADD COLUMN history_revision BIGINT NOT NULL DEFAULT 0;

ALTER TABLE task_runs
  ADD COLUMN agent_run_id CHAR(36) NULL,
  ADD KEY idx_task_runs_agent_run (agent_run_id);
```

规则：

- `appendMessage/appendMessages/replaceMessages` 成功时同事务 `history_revision = history_revision + 1`；
- `touchSession` 只改标题/时间时不增加 history revision；
- AgentRuntime 记录 base revision，terminal commit 使用 CAS；
- legacy 路径迁移期间仍修改 revision，避免与新 Runtime 并发覆盖。

### 15.2 agent_runs

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id                CHAR(36)     NOT NULL,
  turn_id               CHAR(36)     NOT NULL,
  tenant_id             VARCHAR(64)  NOT NULL,
  user_id               VARCHAR(64)  NOT NULL,
  session_id            VARCHAR(128) NOT NULL,
  message_id            CHAR(36)     NOT NULL,
  source                 VARCHAR(32)  NOT NULL,
  mode                   VARCHAR(16)  NOT NULL,
  status                 VARCHAR(32)  NOT NULL,
  input_payload          LONGTEXT     NOT NULL,
  input_payload_bytes    BIGINT       NOT NULL,
  request_fingerprint    CHAR(64)     NOT NULL,
  attempt                INT          NOT NULL DEFAULT 1,
  state_version          BIGINT       NOT NULL DEFAULT 1,
  idempotency_hash       CHAR(64)     NULL,
  base_history_revision  BIGINT       NULL,
  last_checkpoint_no     BIGINT       NOT NULL DEFAULT 0,
  max_run_ms             BIGINT       NULL,
  steps                  INT          NOT NULL DEFAULT 0,
  result_text            MEDIUMTEXT   NULL,
  usage                   JSON         NULL,
  context_usage           JSON         NULL,
  cost                    JSON         NULL,
  error_code             VARCHAR(64)  NULL,
  error_message          VARCHAR(1024) NULL,
  started_at             TIMESTAMP(3) NULL,
  completed_at           TIMESTAMP(3) NULL,
  created_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (run_id),
  UNIQUE KEY uniq_agent_run_turn (turn_id),
  UNIQUE KEY uniq_agent_run_message (tenant_id, user_id, message_id),
  UNIQUE KEY uniq_agent_run_idempotency
    (tenant_id, user_id, session_id, source, idempotency_hash),
  KEY idx_agent_runs_session
    (tenant_id, user_id, session_id, created_at),
  KEY idx_agent_runs_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

MySQL UNIQUE 允许多个 NULL；没有幂等键的 run 不冲突。`input_payload` 使用与 checkpoint 相同的版本化加密 envelope，持久保存初始消息和 `AgentRunProfileSnapshot`；不能只依赖 latest checkpoint，因为 checkpoint 在 terminal 状态会删除。`request_fingerprint` 用规范化 envelope + profile 计算，用于幂等冲突比对。`result_text` 使用 MEDIUMTEXT，保证跨实例 `wait()` 返回完整最终文本，不做静默截断。`state_version` 每次状态/attempt 变更递增，是 late callback、cancel/resume 和 lease owner 切换的 CAS 条件。

### 15.3 agent_checkpoints

```sql
CREATE TABLE IF NOT EXISTS agent_checkpoints (
  run_id          CHAR(36)     NOT NULL,
  tenant_id       VARCHAR(64)  NOT NULL,
  user_id         VARCHAR(64)  NOT NULL,
  session_id      VARCHAR(128) NOT NULL,
  checkpoint_no   BIGINT       NOT NULL,
  boundary        VARCHAR(32)  NOT NULL,
  step_no         INT          NOT NULL DEFAULT 0,
  payload         LONGTEXT     NOT NULL,
  payload_bytes   BIGINT       NOT NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (run_id),
  KEY idx_agent_checkpoints_owner
    (tenant_id, user_id, session_id),
  CONSTRAINT fk_agent_checkpoint_run
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

只保留 latest checkpoint，通过 `INSERT ... ON DUPLICATE KEY UPDATE` 覆盖；更新条件必须保证 `new checkpoint_no > stored checkpoint_no`，防止乱序覆盖。

### 15.4 agent_session_leases

```sql
CREATE TABLE IF NOT EXISTS agent_session_leases (
  tenant_id       VARCHAR(64)  NOT NULL,
  user_id         VARCHAR(64)  NOT NULL,
  session_id      VARCHAR(128) NOT NULL,
  run_id          CHAR(36)     NOT NULL,
  owner_id        VARCHAR(128) NOT NULL,
  generation      BIGINT       NOT NULL,
  lease_expires_at TIMESTAMP(3) NOT NULL,
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, user_id, session_id),
  KEY idx_agent_leases_expiry (lease_expires_at),
  KEY idx_agent_leases_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`agent_session_leases.run_id` 不加外键：异常恢复和租约抢占需要避免外键阻塞清理；业务层验证 run 归属。

### 15.5 agent_run_inbox

```sql
CREATE TABLE IF NOT EXISTS agent_run_inbox (
  id             BIGINT       NOT NULL AUTO_INCREMENT,
  run_id         CHAR(36)     NOT NULL,
  tenant_id      VARCHAR(64)  NOT NULL,
  user_id        VARCHAR(64)  NOT NULL,
  session_id     VARCHAR(128) NOT NULL,
  message_id     CHAR(36)     NOT NULL,
  payload        LONGTEXT     NOT NULL,
  payload_bytes  BIGINT       NOT NULL,
  status         VARCHAR(16)  NOT NULL DEFAULT 'queued',
  consumed_checkpoint_no BIGINT NULL,
  consumed_at    TIMESTAMP(3) NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_agent_run_inbox_message (run_id, message_id),
  KEY idx_agent_run_inbox_pending (run_id, status, id),
  KEY idx_agent_run_inbox_owner
    (tenant_id, user_id, session_id, id),
  CONSTRAINT fk_agent_run_inbox_run
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- payload 使用与 checkpoint 相同的加密 codec，因为用户追加消息可能包含附件和敏感文本；
- `status` 只允许 `queued | consumed | persisted`；owner 在模型边界按 id 顺序读取 queued 行；`saveAgentCheckpoint(checkpoint, consumedInboxIds)` 在同一事务内保存已注入 messageIds，并把对应行设为 consumed、记录 `consumed_checkpoint_no/consumed_at`，避免“先标消费后 checkpoint”或“先 checkpoint 后未标消费”的双写窗口；
- injection gate 不是进程内布尔值：以 `agent_runs.status` 为持久事实源。append 事务必须锁定 run/session 行，仅当 status 为 `running/waiting_approval/waiting_question` 时插入 inbox；看到 `committing/cancelling` 时按 §10.2 等待或返回可重试错误；结束状态下转 persist_only；
- terminal commit 在同一 session 事务中先 CAS `status → committing` 关闭 gate，再锁定/处理 queued inbox。run terminal 后清理 consumed 行；queued 行必须先按 persist_only 写会话并标 persisted，才能删除；
- `(run_id,message_id)` 唯一键和 messageId 去重保证 append 重试不会产生重复行。

### 15.6 Kysely schema

`src/db/schema.ts` 增加新表，并扩展 `TaskRunsTable.agent_run_id`；`src/db/store.ts` 同步给 `TaskRun` 增加 `agentRunId?: string`：

```ts
export interface TaskRunsTable {
  // existing fields ...
  agent_run_id: string | null;
}

export interface Database {
  // existing ...
  agent_runs: AgentRunsTable;
  agent_checkpoints: AgentCheckpointsTable;
  agent_session_leases: AgentSessionLeasesTable;
  agent_run_inbox: AgentRunInboxTable;
}
```

`payload` 的类型是 string，不让 mysql2 自动解析为 JSON；解密和 JSON decode 只在 CheckpointCodec 内进行。

---

## 16. Store API 与事务语义

### 16.1 类型

```ts
export interface SessionLeaseToken {
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
  ownerId: string;
  generation: number;
}

export interface AgentRunMutationGuard {
  lease?: SessionLeaseToken;
  expectedStateVersion: number;
  expectedAttempt: number;
  expectedStatuses: AgentRunStatus[];
}

export interface AgentRunRecord {
  runId: string;
  turnId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  messageId: string;
  source: AgentMessageSource;
  mode: 'interactive' | 'unattended';
  status: AgentRunStatus;
  attempt: number;
  stateVersion: number;
  idempotencyHash?: string;
  requestFingerprint: string;
  encryptedInput: string;
  maxRunMs?: number;
  baseHistoryRevision?: number;
  lastCheckpointNo: number;
  steps: number;
  resultText?: string;
  usage?: Usage;
  context?: SessionContextUsage;
  cost?: CostEstimate;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRunCommit {
  expectedHistoryRevision: number;
  mode: 'append' | 'replace';
  messages: Msg[];
  text: string;
  steps: number;
  usage: Usage;
  context: SessionContextUsage;
  cost: CostEstimate;
}
```

### 16.2 Store 方法

```ts
export interface Store extends AuditSink {
  // existing ...

  createAgentRun(
    ctx: RequestContext,
    input: CreateAgentRunInput,
    acceptedCheckpoint: StoredCheckpoint,
  ): Promise<AgentRunRecord>;

  getAgentRun(
    ctx: RequestContext,
    runId: string,
  ): Promise<AgentRunRecord | undefined>;

  updateAgentRunStatus(
    ctx: RequestContext,
    runId: string,
    update: AgentRunStatusUpdate,
    guard: AgentRunMutationGuard,
  ): Promise<
    | { kind: 'updated'; stateVersion: number }
    | { kind: 'stale' | 'lease_lost' }
  >;

  saveAgentCheckpoint(
    ctx: RequestContext,
    checkpoint: StoredCheckpoint,
    guard: AgentRunMutationGuard,
    consumedInboxIds?: number[],
  ): Promise<
    | { kind: 'saved'; stateVersion: number }
    | { kind: 'stale' | 'lease_lost' }
  >;

  loadAgentCheckpoint(
    ctx: RequestContext,
    runId: string,
  ): Promise<StoredCheckpoint | undefined>;

  completeAgentRun(
    ctx: RequestContext,
    runId: string,
    sessionId: string,
    commit: AgentRunCommit,
    guard: AgentRunMutationGuard,
  ): Promise<
    | { kind: 'completed'; historyRevision: number; stateVersion: number }
    | { kind: 'stale' | 'lease_lost' | 'history_conflict' }
  >;

  deleteAgentCheckpoint(
    ctx: RequestContext,
    runId: string,
    guard: AgentRunMutationGuard,
  ): Promise<'deleted' | 'stale' | 'lease_lost'>;

  acquireSessionLease(input: AcquireLeaseInput): Promise<SessionLease | undefined>;
  renewSessionLease(input: RenewLeaseInput): Promise<SessionLease | undefined>;
  releaseSessionLease(input: ReleaseLeaseInput): Promise<boolean>;

  /**
   * 仅用于 collision=reject：原子创建 running run、accepted checkpoint 并获取 session lease；
   * session 已占用时不插入任何 run/checkpoint，返回 conflict；幂等重复返回 duplicate。
   */
  createRunningAgentRun(
    ctx: RequestContext,
    input: CreateAgentRunInput,
    acceptedCheckpoint: StoredCheckpoint,
    ownerId: string,
  ): Promise<
    | { kind: 'created'; run: AgentRunRecord; lease: SessionLease }
    | { kind: 'duplicate'; run: AgentRunRecord }
    | { kind: 'conflict' }
  >;

  enqueueRunMessage(
    ctx: RequestContext,
    runId: string,
    envelope: StoredEnvelope,
  ): Promise<
    | { kind: 'inserted' | 'duplicate' }
    | { kind: 'gate_closed'; status: AgentRunStatus }
  >;

  listPendingRunMessages(
    ctx: RequestContext,
    runId: string,
    lease: SessionLeaseToken,
    limit: number,
  ): Promise<Array<{ inboxId: number; envelope: StoredEnvelope }>>;

  flushUnconsumedRunMessages(
    ctx: RequestContext,
    runId: string,
    sessionId: string,
    lease: SessionLeaseToken,
  ): Promise<number>;

  claimNextQueuedRun(
    ownerId: string,
  ): Promise<ClaimedAgentRun | undefined>;

  listExpiredActiveRuns(limit: number): Promise<AgentRunRecord[]>;
}
```

### 16.3 关键事务

#### createAgentRun / createRunningAgentRun

`collision=enqueue` 的 `createAgentRun` 在一个事务内：

1. 只接受 unattended profile；插入 status=queued 的 agent_runs，并写加密 `initial envelope + AgentRunProfileSnapshot`、max_run_ms 和 request fingerprint；
2. 插入 accepted checkpoint；
3. 若 idempotency unique 冲突，读取已有 run 并比对 session/request fingerprint；一致才返回 duplicate，不一致返回 idempotency conflict；
4. 不发布事件，直到事务提交。

`collision=reject` 必须调用 `createRunningAgentRun`：

1. 只接受 interactive `collision='reject'` profile；先以 SessionKey 行锁/lease CAS 原子判断占用；
2. 未占用时同事务插入 status=running 的 run（含加密 initial envelope/profile snapshot、request fingerprint、max_run_ms）、accepted checkpoint 并写 lease；
3. 已占用返回 conflict，事务中不得留下 accepted run；
4. 幂等重复先比对 session/request fingerprint；一致返回原 run，不误报 conflict，不一致返回 idempotency conflict。

#### saveAgentCheckpoint

一个事务内：

1. 验证 run 的 tenantId/userId；
2. 以 `expectedStateVersion + expectedAttempt + expectedStatuses` 锁定 agent_runs；distributed lease 开启时，在同一事务内验证 token 的 tenant/user/session/run/ownerId/generation/expiry；
3. CAS 覆盖 checkpointNo 更大的 checkpoint；
4. 如传入 consumedInboxIds，同事务验证这些行属于当前 run/user 且 status=queued，再设置 status=consumed、`consumed_checkpoint_no` 和 consumed_at；
5. 更新 agent_runs.last_checkpoint_no、steps，并递增 state_version；checkpoint 保存本身不得隐式改变未在 update 中声明的 status；
6. stale state 或 lease lost 返回 typed 结果，不得退化为无 guard 的重试；其他失败不返回成功。

#### completeAgentRun

一个事务内：

1. 以 guard 验证 `expectedStateVersion + expectedAttempt + expectedStatuses`；distributed lease 开启时，验证完整 fencing token；
2. 先用事务内 upsert 确保 session 行存在，再 `SELECT sessions ... FOR UPDATE`；首轮按 revision=0 创建，禁止无行可锁竞态；
3. CAS run status 为 `committing`、递增 state_version，持久关闭 injection gate；
4. 验证 history_revision 等于 expected；
5. append 或 replace messages；消息变更、session title/updated_at 和 `history_revision + 1` 必须在同一事务，现有 legacy append/replace 也要在 P0 修成该原子语义；
6. 把 queued inbox 按 persist_only 写入会话并标 persisted，或按本次 checkpoint 已记录的 consumed 状态清理；不得直接删除未处理行；
7. 更新 agent_runs 为 completed，写 result_text/steps/usage/context_usage/cost/completed_at 并再次递增 state_version，使跨实例 `wait()` 能完整返回 AgentRunResult；
8. 删除 checkpoint并提交。

revision 冲突时整个事务回滚并抛 `AgentHistoryConflictError`，Runtime 标记 recovery_required，不能发布 done。

#### terminal failure/cancel

- failed/interrupted/recovery_required 保留 checkpoint；
- cancelled 仅在 checkpoint 证明无 in-flight，或所有 started 调用已明确结束且结果已保存时删除 checkpoint；否则必须转 recovery_required；
- queued run 取消使用 `expectedStatus=queued` CAS，同时删除其尚未执行 checkpoint/inbox；
- 所有结束状态更新必须使用 mutation guard，避免 late callback、旧 attempt 或旧 lease owner 把 cancelled/recovery_required 改回 completed。

### 16.4 MemoryStore

MemoryStore 必须实现同一语义：

- key 都包含 tenantId/userId；
- checkpointNo CAS；
- historyRevision；
- session lease 与 fencing token；
- durable run inbox；
- 测试中可注入 clock，避免依赖真实时间。

MemoryStore 不要求跨进程恢复，但不能在测试中放宽隔离和状态机。

---

## 17. 分阶段实施计划

### P0：契约与基础设施，不切换入口

变更：

- 新增 `src/agent/runtime/types.ts`、`envelope.ts`、`events.ts`；
- 定义 Runtime Event mapper，但 HTTP 仍走旧路径；
- 增加 migration、Kysely schema、Store/MemoryStore/MySQLStore run/checkpoint API；
- 增加 CheckpointCodec 与配置校验；
- `sessions.history_revision` 接入现有 append/replace 方法，并把消息 INSERT/DELETE、session upsert/touch、revision 增量改为单事务原子操作；空消息批次不增加 revision。

验收：

- 旧 HTTP/CLI/Scheduler 行为不变；
- migration 可从 0009 正常升级；
- Store tenant/user isolation、revision/CAS/encryption 测试通过。

### P1：工具执行规划

变更：

- `ToolHandler.execution`；
- 新增 `ToolExecutionPlanner`；
- `runAgent()` 从无条件 `Promise.all` 改为 planner；
- 审计并标注内置工具；MCP/未知工具默认 serial；
- 保持 Policy→Approval→Hook→dispatch 顺序。

验收：

- parallel 工具真实并行；
- serial barrier 不被跨越；
- 同 resource key 严格串行，不同 key 并行；
- ToolResult 按模型原顺序；
- 未声明工具串行；
- 全量现有 agent/policy/hook/ask-user/change-plan 测试通过。

### P2：Runner Boundary + Checkpoint

变更：

- `runAgent()` 增加 delta-based `onBoundary/resumeState`；CheckpointManager 在唯一 aggregate 上合并，不接受并行 callback 的完整陈旧快照；
- 每个 tool dispatch 前持久化 `tool.started + recovery policy snapshot`，每个 result 完成后保存部分 batch；
- CheckpointManager、恢复判定、故障注入；
- 暂不切换 HTTP 主入口，可用单元/集成 harness 验证。

验收：

- tool A 完成、tool B 前中断，恢复不重跑 A；
- unsafe in-flight tool 进入 recovery_required；
- checkpoint 保存失败后不执行下一副作用 group；
- 模型永远只收到完整 tool-result batch。

### P3：AgentRuntime + 进程内 TurnCoordinator

变更：

- 新增 `AgentRuntime`、Coordinator、InteractionAdapter；
- `src/runtime.ts` 组装 `agentRuntime`；
- HTTP `/v1/agent`、append、terminate 改为调用 Runtime；
- SSE adapter 维持现有事件；
- 第一阶段 HTTP collision 仍为 reject；disconnect 仍为 cancel。

验收：

- 现有 HTTP SSE、append、terminate、approval/question 测试无破坏；
- SessionKey 包含 userId；
- 同 session 串行、跨 session 并行；
- done 事件后消息必然已提交；
- pending append 返回成功后进程中断也可恢复。

### P4：CLI / Scheduler 迁移

变更：

- CLI 不再直接调用 `runAgent()`；
- Scheduler 通过 unattended profile 调 Runtime；
- Scheduler 使用幂等键和 enqueue；
- 保持 timeout、preApproved、AutoDeny、Skill visibility、usage audit。

验收：

- CLI 历史与输出不回归；
- Scheduler claim 仍不重复；
- Scheduler 与交互 run 同 session 时排队、不注入；
- maxRunMs 从 running 开始计算；
- task_runs 结果正确。

### P5：数据库 lease 与显式恢复 API

变更：

- `agent_session_leases` CAS/heartbeat，所有 protected Store mutation 使用完整 fence + stateVersion/attempt/status guard；
- durable `agent_run_inbox`、持久 gate 与 owner 原子消费；
- recovery scanner；
- run status/resume/cancel API；
- 前端最小“运行中断/可恢复/需人工核实”提示；
- 多副本故障测试。

验收：

- 两副本同时提交同 SessionKey，只有一个 running；
- owner 宕机、lease 过期后 run 标记 interrupted；
- safe checkpoint 可显式 resume；
- 非幂等未知结果不自动重试；
- 跨用户 runId 查询/恢复返回 404。

### 发布顺序与混部约束

1. 先发布 additive migration 和关闭状态的代码；
2. 全部 Pod 升级完成后再启用 AgentRuntime；
3. 旧 Pod 会绕过 session lease，**不能在旧/新路径混跑时宣称多副本串行成立**；启用前需滚动完成并排空旧 Pod；
4. 使用以下 feature flags：
   - `agentRuntime.enabled`；
   - `agentRuntime.checkpoint.enabled`；
   - `agentRuntime.distributedLease.enabled`；
   - `agentRuntime.runtimeEventsV1.enabled`；
5. 回滚只关闭新路径，不删除 0010 migration。降级 runbook 固定为：停止入口流量和 queue worker → 停止领取新 run → 等待最多 30 秒 → 按 checkpoint 判定将剩余 run 标 interrupted/recovery_required → 冲刷 queued inbox → 释放 lease → 关闭 flags → 回滚二进制。不得让旧二进制继续处理尚处 running/committing 的新 Runtime run。

---

## 18. 兼容迁移清单

### 18.1 HTTP

| 现有逻辑 | 迁移后 |
|---|---|
| `ActiveAgentRuns` Map | `TurnCoordinator` |
| `pendingMessages` array | Coordinator durable pending queue |
| `AbortController` | Run control，由 handle/cancel 管理 |
| `runAgentSse()` 内 list/append/replace | AgentRuntime |
| `InteractiveApprovalGate` 直接绑 SSE | HTTP InteractionAdapter |
| `StreamEvent` 直接 SSE | RuntimeEvent → legacy SSE mapper |
| compactionWatermarks HTTP Map | checkpoint runner state；必要时 Runtime cache |
| usage audit | AgentRuntime terminal flow |

保留路由：

- `POST /v1/agent`；
- `POST /v1/sessions/:id/append`；
- `POST /v1/sessions/:id/terminate`；
- approvals/questions 路由。

会话删除纳入 Coordinator：DELETE 先在 SessionKey 下拒绝新 start/append，取消 active + queued run 并等待 slot 释放；仅无 lease、无 committing run、inbox 已冲刷时删除 session。若等待超时返回 409/503，不允许删除后旧 run terminal commit 重建会话。实现可用 session tombstone/version 作为第二道提交防线。

向后兼容增加字段不删除字段：`session/done/terminated` payload 可增加 runId/turnId。

### 18.2 CLI

删除 CLI 自行 list/append 的代码，只消费 handle.events/completion。默认身份仍来自 `rt.defaultContext`，不能从任务文本解析身份。

### 18.3 Scheduler

`Scheduler` ticker/claim 不变；只替换 runner 内部执行。`task_runs` 与 `agent_runs` 是不同维度：前者是定时任务业务执行记录，后者是统一 Agent runtime 记录。0010 同时给 `task_runs` 增加 nullable `agent_run_id CHAR(36)` 和索引。为保持当前 ticker 在 runner 完成后一次调用 `recordTaskRun()` 的最小改动，`TaskRunner` 结果新增 `agentRunId`，ticker 在最终写 task_run 时一并保存；不在 start receipt 返回时提前创建或更新 task_run，也不把关联 ID 混入 detail 文本。

### 18.4 Compaction

- compaction 状态进入 runner checkpoint；
- terminal commit 时：`compacted=true` → replace；否则 append tail；
- replace 必须校验 history_revision；
- compaction summary 失败仍按当前行为由硬裁剪兜底；
- 不再由 HTTP 持有跨请求 watermark Map，watermark 随 checkpoint/run result 保存；后续可在 session metadata 持久化跨 run watermark，本期可保持 Runtime 内存缓存作为性能优化，但不能影响正确性。

---

## 19. 测试计划

### 19.1 新增测试文件

- `tests/agent-runtime.test.ts`
- `tests/turn-coordinator.test.ts`
- `tests/runtime-events.test.ts`
- `tests/tool-concurrency.test.ts`
- `tests/checkpoint.test.ts`
- `tests/session-lease.test.ts`

扩展：

- `tests/agent.test.ts`
- `tests/http.test.ts`
- `tests/scheduler.test.ts`
- `tests/db.test.ts`
- `tests/policy.test.ts`
- `tests/hooks.test.ts`
- `tests/ask-user.test.ts`
- `tests/change-plan.test.ts`

### 19.2 Tool concurrency 用例

1. 两个 parallel 工具使用 barrier 同时开始，证明并行；
2. `parallel A/B → serial C → parallel D/E`，C 必须在 A/B 后、D/E 前；
3. resource A1/A2 同 key 串行，B1 不同 key 可并行；
4. resolver 抛错/空 key → serial；
5. 未声明 handler → serial；
6. 一个调用失败不改变结果数组顺序；
7. Policy block、Approval deny、Hook deny 都不 dispatch；
8. cancel 后不启动下一 group；
9. tool.completed 按实际完成顺序，ToolResult 按模型顺序。

### 19.3 Coordinator 用例

1. 同 `(tenant,user,session)` 两个 start 串行；
2. 同 tenant/session、不同 user 可并行；
3. 不同 session 可并行；
4. HTTP reject 返回冲突；
5. Scheduler enqueue FIFO；
6. append 在模型边界注入一次；
7. terminal gate 关闭后的 append 不丢失；
8. pending 上限与 429；
9. cancel 只影响目标用户/会话；
10. dispose 不再接收新 run 并释放资源。

### 19.4 Runtime Event 用例

1. base metadata 完整且身份来自 ctx；
2. sequence 严格递增，eventId 稳定；
3. checkpoint.saved 在 Store 成功后；
4. run.completed 在 session commit 后；
5. `tool.call_created` 仅在当前用户私有实时流保留 call args 以兼容前端；日志、audit、公共事件均不记录 args；
6. Runtime Event 正确映射为现有 SSE；
7. model retry rollback 字段不丢失；
8. error/tool output 脱敏与长度限制。

### 19.5 Checkpoint 用例

1. accepted checkpoint 事务失败时不返回 accepted；
2. assistant 完成 checkpoint 失败时不执行工具；
3. tool A 完成并保存、B 前故障，resume 跳过 A；
4. A/B parallel 各自完成，checkpointNo 不乱序覆盖；
5. 已启动未返回的 retrySafe tool 可恢复；
6. 已启动未返回的默认工具 → recovery_required；
7. checkpoint 解密错误 → unavailable；
8. history revision 冲突不 replace；
9. compaction checkpoint 恢复后历史顺序正确；
10. pending envelope 在重启后仍注入且不重复；
11. cancel 后已完成 tool result 被记录，但 turn 不提交正常历史；仍有未知 in-flight 时为 recovery_required 且 checkpoint 保留；
12. checkpoint payload 明文中搜索不到测试 token/password；
13. `thinkingBlocks/contentBlocks` 加密 checkpoint round-trip，Anthropic thinking signature 恢复后不丢失；
14. 部署后把某工具 retrySafe 从 false 改为 true，旧 checkpoint 仍按 tool.started 时冻结的 false 判定；
15. parallel completed delta 以相反顺序到达时 authoritative aggregate 保留两者，不被陈旧快照覆盖。

### 19.6 MySQL / 多副本用例

在配置真实 MySQL 时运行：

1. 0010 migration 可重复启动且只应用一次；
2. run/checkpoint tenant+user 隔离；
3. latest checkpoint CAS；
4. completeAgentRun revision CAS 与事务回滚；
5. committing 期间 append 等待，commit 后再持久化，不触发 revision 冲突或丢消息；
6. 两个 Store 实例竞争同 SessionKey，只有一个获得 lease；
7. heartbeat generation 不匹配时续约失败；
8. lease 过期可被新 owner 获取；
9. 旧 owner 丢 lease 后无法 checkpoint/complete/status/delete；GC pause 后恢复的旧 owner 即使 checkpointNo 更大也被 fencing 拒绝；
10. append 命中非 owner 副本后写 inbox，owner 注入并原子标记 consumed；append/checkpoint/terminal commit 三方并发不丢失、不重复；
11. queued run 被任一 worker 领取后，仅凭加密 initial envelope + profile snapshot 重建，`wait()` 从 Store 得到 completed 或 non-completed 结束结果；
12. queued run 取消后不会再被 worker claim，其 accepted checkpoint/inbox 被安全清理；
13. question/approval/plan answer 按 tenant+user+session+run+attempt 隔离，同租户其他用户不能代答。

### 19.7 端到端故障注入

增加测试专用 fault hook：

- `after_model_boundary`；
- `after_tool_started_checkpoint_before_dispatch`；
- `after_tool_dispatch_before_completed_checkpoint`；
- `after_tool_checkpoint`；
- `before_terminal_commit`；
- `after_terminal_commit_before_event`。

关键场景：

```text
模型：tool A（记录调用次数）+ tool B
→ A 完成并 checkpoint
→ 注入进程故障
→ resume
→ A 调用次数仍为 1，B 正常执行，最终消息完整
```

对于 `after_tool_dispatch_before_completed_checkpoint` 的非幂等工具，验收结果必须是 recovery_required，而不是自动重试；`after_tool_started_checkpoint_before_dispatch` 会产生保守的 false-positive in-flight，同样进入 recovery_required，不能冒险自动执行。

---

## 20. 验收标准

### 20.1 功能

- [ ] HTTP、CLI、Scheduler 均通过 AgentRuntime 执行；
- [ ] `runAgent()` 不依赖 HTTP、Store 或 RequestContext 认证实现；
- [ ] 同 SessionKey 无并发 turn，跨 session 保持并行；
- [ ] 活跃 run 的用户追加消息在模型边界注入；
- [ ] Scheduler 到同 session 时排队而非注入；
- [ ] Runtime Event 有稳定 v1 契约和单调 sequence；
- [ ] 现有 SSE 前端无需同步大改即可工作；
- [ ] 未声明工具默认串行；
- [ ] parallel/resource/serial 调度符合规则；
- [ ] 已 checkpoint 的工具结果在恢复时不重复执行；
- [ ] 未知副作用不自动重试；
- [ ] done 发布时消息和 run 状态已落库；
- [ ] `DisconnectPolicy=cancel` 保持当前断连终止行为，`continue` 只断开事件消费者。

### 20.2 安全

- [ ] 身份只来自服务端验证的 `RequestContext`；
- [ ] body、聊天文本、metadata、LLM 工具参数均不能覆盖 tenantId/userId/role；
- [ ] A 用户不能查询、取消、恢复 B 用户的 run/checkpoint；
- [ ] Policy、Approval、Hooks、PermissionRules、Skill visibility 在所有 Runtime 入口一致；
- [ ] 用户凭据作用域和 Sandbox 用户隔离不因 Runtime 抽象而改变；
- [ ] Runtime Event、audit、日志不含 token/密码/完整敏感参数；
- [ ] Checkpoint payload 加密，生产 key 缺失时 fail closed；
- [ ] Tool concurrency metadata 不暴露给模型修改；
- [ ] resume 不沿用失效的进程内审批结果。

### 20.3 可靠性

- [ ] checkpoint 保存失败不会继续启动新的副作用工具；
- [ ] session history revision 冲突不会覆盖新消息；
- [ ] lease 丢失会停止新工具执行，旧 owner 的所有 protected mutation 被数据库 fencing 拒绝；
- [ ] pending message 在成功响应后不会静默丢失，append/inbox/checkpoint/terminal commit 无双写窗口；
- [ ] cancelled run 不破坏既有历史；未知 in-flight 的取消结果为 recovery_required 并保留证据；
- [ ] failed/interrupted run 可给出 safe/manual/unavailable 的明确恢复判断。

---

## 21. 安全边界

必须继续遵循以下硬规则：

1. **身份只来自服务端验证过的 JWT（`RequestContext.userId`），永远不来自聊天文本、请求 body 或 LLM 输出。**
2. Channel/Webhook sender 必须先通过服务端验证和账号绑定映射到 tenantId/userId。
3. 所有 Store API 以 RequestContext 过滤；run/checkpoint/lease 同样按 tenant + user 隔离。
4. Tool schema 不增加 userId/tenantId 等可由模型伪造的身份参数。
5. Policy、Approval、PreToolUse Hook、PermissionRules 顺序不因 planner 改造而变化。
6. Skill 可见性同时在模型展示和工具执行链路检查。
7. 注入过用户凭据的 Sandbox 不跨用户复用；AgentRuntime 不能缓存/复用其他用户的 ToolContext。
8. Event、Checkpoint 明文 metadata、Audit 中不得泄露 token、密码和敏感环境变量；恢复所需敏感正文仅存在于加密 payload。
9. Checkpoint 解密后对象只在当前 run 内存生命周期存在，不写 debug log，不进入异常字符串。
10. resource key 不得包含秘密；同样不能依赖模型声明的“我是管理员”之类文本。
11. resume 是新的执行 attempt，必须重新验证当前用户状态、角色、Policy、Skill visibility 和凭据有效性。
12. 用户已被 disabled 时，即使存在旧 checkpoint 也禁止 resume。

---

## 22. 可观测性

新增以下指标：

```text
aiop_agent_runs_active{mode,source}
aiop_agent_runs_queued{source}
aiop_agent_run_duration_seconds{status,mode}
aiop_agent_session_queue_depth
aiop_agent_checkpoint_save_seconds{boundary}
aiop_agent_checkpoint_failures_total{boundary,reason}
aiop_agent_checkpoint_payload_bytes
aiop_agent_recovery_total{decision,outcome}
aiop_agent_lease_lost_total
aiop_tool_execution_seconds{tool,mode,status}
aiop_tool_concurrency_active{tool,resource_group}
aiop_runtime_event_dropped_total{type}
```

日志统一字段：

```text
runId, turnId, attempt, tenantId, userId, sessionId,
checkpointNo, boundary, toolName, toolCallId, leaseOwner
```

日志不记录完整 envelope、tool args、tool result、checkpoint plaintext。

`agent_runs` 保存 usage/steps/status，`audit_events` 可增加 `runtime` kind，记录：

- resume requested/completed/rejected；
- recovery_required；
- lease lost；
- checkpoint decrypt/version failure；
- 用户显式取消。

普通 token delta/tool output 不进入 audit。

---

## 23. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Checkpoint 每工具写库增加延迟 | 长 tool batch 写放大 | 只保留 latest；只在稳定边界写；监控 payload/latency |
| parallel 工具同时完成导致 checkpoint 乱序 | 新结果被旧快照覆盖 | boundary 只报 delta；唯一 authoritative aggregate 在 per-run mutex 内 merge + checkpointNo/stateVersion CAS |
| 非幂等工具中断结果未知 | 可能重复副作用 | 默认 retrySafe=false，进入 manual recovery |
| resource key 配错 | 仍发生并发冲突 | 未声明/异常均 serial；关键工具专项测试 |
| 旧/新 Pod 混跑绕过 lease | 同 session 并发 | 全量 rollout 后统一启用，启用前排空旧 Pod |
| history replace 覆盖 append | 消息丢失 | SessionKey 串行 + history_revision CAS |
| pending append 只在内存或与 terminal 双写 | 用户消息丢失/重复注入 | P3 成功响应前更新 owner aggregate；P5 durable inbox + 持久 gate + checkpoint/consume/flush 事务 |
| interaction store 进程内 | 重启后无法直接续接 | interrupted + resume 后重新发布交互、重新确认 |
| Checkpoint 包含敏感 args/result | 数据泄露 | AES-GCM、独立 key、事件/日志脱敏、访问按用户过滤 |
| 加密 key 丢失或轮换错误 | checkpoint 无法恢复 | keyId、多 key 解密、备份与轮换演练；失败 unavailable |
| payload 过大 | DB/内存压力 | 增量 workingTail、压缩后才存 full history、32 MiB fail closed |
| Runtime 抽象吞掉入口差异 | Scheduler/CLI 安全语义变化 | profile 显式区分 interactive/unattended，回归测试 |
| done 早于落库 | UI 读不到结果 | terminal transaction 后才发布 completed |
| 取消时工具仍在下游执行 | 状态不一致/证据被清理 | cooperative cancel + 30s quiesce；已返回结果 checkpoint；未知结果转 recovery_required 并保留 checkpoint；late callback 受 fence/stateVersion 拒绝 |

---

## 24. 开发任务拆分

| 任务 | 主要文件 | 依赖 | 交付物 |
|---|---|---|---|
| T1 Runtime types/envelope/events | `src/agent/runtime/{types,envelope,events}.ts` | — | v1 契约、验证、映射、脱敏 |
| T2 DB migration/schema | `0010_agent_runtime.sql`、`schema.ts` | T1 | runs/checkpoints/inbox/leases/revision/task run link |
| T3 Store API | `store.ts`、`memory.ts`、`mysql.ts` | T2 | revision 原子事务、stateVersion/attempt/status CAS、lease fencing、inbox gate/consume/flush、隔离测试 |
| T4 CheckpointCodec | `checkpoint.ts`、配置 schema | T1/T3 | AES-GCM、版本、大小限制 |
| T5 Tool metadata/planner | `tools.ts`、`tool-execution.ts`、各 tool builder | T1 | 三种调度、默认 serial |
| T6 Runner boundaries/resume | `core.ts` | T4/T5 | tool.started、delta boundary、authoritative aggregate、recovery policy snapshot、partial batch checkpoint、resumeState |
| T7 TurnCoordinator | `coordinator.ts` | T1/T3/T4 | session queue、pending、cancel |
| T8 AgentRuntime | `agent-runtime.ts`、`interaction.ts`、`runtime.ts` | T3-T7 | 统一 facade |
| T9 HTTP migration | `server/http.ts` | T8 | legacy SSE adapter、append/terminate |
| T10 CLI/Scheduler migration | `index.ts`、`scheduler/runner.ts` | T8 | 统一执行入口 |
| T11 Lease/recovery API | `session-lease.ts`、HTTP routes | T3/T7/T8 | 多副本串行、显式 resume |
| T12 Tests/chaos | `tests/*runtime*` 等 | 全部 | 单测、MySQL 集成、故障注入 |

建议按 T1→T4、T5→T6、T7→T10、T11→T12 的顺序实施。T2/T3 与 T5 可在接口冻结后并行开发。

---

## 25. 最终落地形态

完成一期后，三个入口应只保留各自 adapter 差异：

```text
HTTP
  authenticate + body parser + SSE/interaction adapter
        └── AgentRuntime

CLI
  default RequestContext + terminal event adapter
        └── AgentRuntime

Scheduler
  due-task claim + unattended profile + task_run record
        └── AgentRuntime
```

模型—工具核心保持：

```text
AgentRuntime
  └── TurnCoordinator
       └── runAgent()
            └── ToolExecutionPlanner
                 └── Policy → Approval → Hook → dispatch
```

这样既保留 aiop 已有安全与工具体系，又补齐统一运行边界、消息/事件契约、并发安全和中断恢复，为后续 Channel、Trigger、Background Task 或多副本运行提供稳定地基。
