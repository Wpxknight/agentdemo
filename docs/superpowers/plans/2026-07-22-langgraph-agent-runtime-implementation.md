# LangGraph Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不丢失 AIoP 现有 Agent、安全、交互、流式输出和持久化能力的前提下，引入可切换的 `AgentRuntime + AgentKernel`，并逐步接入进程内 LangGraph 执行内核。

**Architecture:** AIoP 继续作为企业控制面和事实数据源，现有 `runAgent()` 先由 `LegacyAgentKernel` 完整封装，再通过 `AgentRuntime` 统一供 HTTP、CLI、Scheduler 调用。LangGraph 内核在同一接口后增量实现，工具调用始终经过 AIoP Policy、Approval、Hook 和 ToolRegistry，MySQL checkpoint 仅保存单次 run 的执行恢复状态。

**Tech Stack:** TypeScript 6、Node.js 20、Vitest、Kysely/MySQL、`@langchain/langgraph@1.4.8`、Zod 4

---

## 文件结构

- `/home/opt/develop/aicoding/aiop/src/agent/core.ts`：保留当前 Legacy Agent 循环和 `RunAgentOptions` / `RunAgentResult` 行为契约。
- `/home/opt/develop/aicoding/aiop/src/agent/kernel.ts`：定义稳定 `AgentKernel` 接口、内核名称和运行上下文。
- `/home/opt/develop/aicoding/aiop/src/agent/legacy-kernel.ts`：把现有 `runAgent()` 适配为 `AgentKernel`。
- `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`：统一内核选择、运行入口和 Legacy 回退。
- `/home/opt/develop/aicoding/aiop/src/agent/services/prompt.ts`：构造系统提示并保留交互/无人值守规则。
- `/home/opt/develop/aicoding/aiop/src/agent/services/model-gateway.ts`：模型流读取、重试、usage 与失败尝试回滚信息。
- `/home/opt/develop/aicoding/aiop/src/agent/services/context-service.ts`：消息预算、图片保留、摘要压缩和 watermark。
- `/home/opt/develop/aicoding/aiop/src/agent/services/tool-broker.ts`：固定 Policy → Approval → Hook → dispatch 顺序和工具事件。
- `/home/opt/develop/aicoding/aiop/src/agent/services/event-bridge.ts`：内核事件到现有 `StreamEvent` / SSE 的兼容映射。
- `/home/opt/develop/aicoding/aiop/src/agent/services/session-committer.ts`：成功、失败、终止和压缩后的消息提交策略。
- `/home/opt/develop/aicoding/aiop/src/agent/langgraph/*`：LangGraph state、节点、路由、内核和图版本注册表。
- `/home/opt/develop/aicoding/aiop/src/agent/checkpoint/*`：Kysely/MySQL checkpointer 与序列化实现。
- `/home/opt/develop/aicoding/aiop/tests/agent-behavior-v1.test.ts`：跨内核必须共同通过的功能契约。
- `/home/opt/develop/aicoding/aiop/tests/agent-runtime.test.ts`：内核选择、参数透传、回退和取消测试。
- `/home/opt/develop/aicoding/aiop/tests/langgraph-kernel.test.ts`：图循环、流式事件、工具和恢复测试。
- `/home/opt/develop/aicoding/aiop/tests/mysql-checkpointer.test.ts`：checkpoint 协议和租户/run 隔离测试。

### Task 1: 冻结 AgentKernel 与 Legacy Runtime 兼容层

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/kernel.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/legacy-kernel.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`
- Create: `/home/opt/develop/aicoding/aiop/tests/agent-runtime.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/runtime.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/index.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/server/http.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/scheduler/runner.ts`

- [x] **Step 1: 写内核透传和默认 Legacy 内核的失败测试**

```ts
it('routes the complete options object through the configured kernel', async () => {
  const kernel = { name: 'test', run: vi.fn(async () => expectedResult) } satisfies AgentKernel;
  const runtime = new AgentRuntime({ kernel });
  await expect(runtime.run(options)).resolves.toBe(expectedResult);
  expect(kernel.run).toHaveBeenCalledWith(options);
});

it('uses LegacyAgentKernel by default', () => {
  expect(new AgentRuntime().kernelName).toBe('legacy');
});
```

- [x] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `npm test -- tests/agent-runtime.test.ts`

Expected: FAIL，提示无法解析 `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts` 或导出不存在。

- [x] **Step 3: 实现稳定接口和 Legacy 适配器**

```ts
export type AgentKernelName = 'legacy' | 'langgraph' | (string & {});

export interface AgentKernel {
  readonly name: AgentKernelName;
  run(options: RunAgentOptions): Promise<RunAgentResult>;
}

export class LegacyAgentKernel implements AgentKernel {
  readonly name = 'legacy';
  run(options: RunAgentOptions): Promise<RunAgentResult> {
    return runAgent(options);
  }
}

export class AgentRuntime {
  readonly kernel: AgentKernel;
  constructor(options: { kernel?: AgentKernel } = {}) {
    this.kernel = options.kernel ?? new LegacyAgentKernel();
  }
  get kernelName(): AgentKernelName { return this.kernel.name; }
  run(options: RunAgentOptions): Promise<RunAgentResult> { return this.kernel.run(options); }
}
```

- [x] **Step 4: 将 Runtime 装配和三个入口切换到统一 facade**

`buildRuntime()` 必须创建一个共享 `AgentRuntime`；HTTP 测试中的轻量 Runtime fixture 未提供该字段时，通过 `defaultAgentRuntime` 兼容回退。所有调用仍传递原有完整 `RunAgentOptions`，不删除或改名任何字段。

- [x] **Step 5: 运行定向测试、类型检查和全量测试**

Run: `npm test -- tests/agent-runtime.test.ts tests/agent.test.ts tests/http.test.ts tests/scheduler.test.ts && npm run typecheck && npm test`

Expected: 新测试通过；42 个原测试文件继续通过；类型检查退出码为 0。

- [x] **Step 6: 提交兼容层**

```bash
git add src/agent/kernel.ts src/agent/legacy-kernel.ts src/agent/runtime.ts src/runtime.ts src/index.ts src/server/http.ts src/scheduler/runner.ts tests/agent-runtime.test.ts docs/superpowers/plans/2026-07-22-langgraph-agent-runtime-implementation.md
git commit -m "feat: add pluggable agent runtime

Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 2: 建立 agent-behavior-v1 跨内核契约

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/tests/agent-behavior-v1.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/tests/agent.test.ts`

- [x] **Step 1: 写可复用 kernel factory 契约套件**

```ts
export function agentBehaviorV1(name: string, createKernel: () => AgentKernel): void {
  describe(`agent-behavior-v1: ${name}`, () => {
    it('preserves thinking blocks and signatures', async () => { /* 使用真实脚本模型断言 messages */ });
    it('preserves model retry rollback events and usage', async () => { /* 断言 model_retry */ });
    it('runs policy approval hook and dispatch in order', async () => { /* 断言调用序列 */ });
    it('drains pending input only at model boundaries', async () => { /* 断言消息顺序 */ });
    it('preserves compaction and image retention behavior', async () => { /* 断言 context_compacted */ });
    it('propagates abort without dispatching later tools', async () => { /* 断言终止 */ });
  });
}
```

- [x] **Step 2: 运行 Legacy Kernel 特征测试并冻结当前基线**

Run: `npm test -- tests/agent-behavior-v1.test.ts`

Expected: Legacy Kernel 的 6 项关键特征测试通过；未来 LangGraph Kernel 复用同一 suite。

- [x] **Step 3: 使用 LegacyAgentKernel 固化独立 fixture**

契约套件使用独立脚本模型和长历史 fixture，调用 `new LegacyAgentKernel()`，避免与旧测试共享可变状态。

- [x] **Step 4: 运行契约与全量测试**

Run: `npm test -- tests/agent-behavior-v1.test.ts tests/agent.test.ts && npm test`

Expected: Legacy Kernel 的全部行为契约通过，全量无回归。

- [x] **Step 5: 提交行为基线**

```bash
git add tests/agent-behavior-v1.test.ts tests/agent.test.ts
git commit -m "test: freeze agent behavior v1 contract

Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 3: 提取 PromptService 与 ModelGateway

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/services/prompt.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/services/model-gateway.ts`
- Create: `/home/opt/develop/aicoding/aiop/tests/model-gateway.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/core.ts`

- [x] **Step 1: 写提示拼装、流式累积、重试和 usage 的失败测试**

测试必须断言交互规则、无人值守规则、自定义 system 拼接顺序、thinking signature、失败流丢弃字符数、失败尝试 usage 仍累计。

- [x] **Step 2: 运行定向测试确认新服务不存在**

Run: `npm test -- tests/model-gateway.test.ts`

Expected: FAIL，模块或导出不存在。

- [x] **Step 3: 移动现有逻辑到服务并保持返回结构**

```ts
export interface ModelTurn {
  text: string;
  thinking?: string;
  thinkingBlocks?: Array<{ thinking: string; signature: string }>;
  calls: ToolCall[];
  usage: Usage;
}
```

`core.ts` 仅调用服务，不改变事件产生时机和重试上限。

- [x] **Step 4: 运行行为契约、类型检查和全量测试**

Run: `npm test -- tests/model-gateway.test.ts tests/agent-behavior-v1.test.ts && npm run typecheck && npm test`

Expected: 全部通过。

- [x] **Step 5: 提交服务提取**

```bash
git add src/agent/core.ts src/agent/services/prompt.ts src/agent/services/model-gateway.ts tests/model-gateway.test.ts
git commit -m "refactor: extract prompt and model gateway

Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 4: 提取 ContextService 与 ToolBroker

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/services/context-service.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/services/tool-broker.ts`
- Create: `/home/opt/develop/aicoding/aiop/tests/tool-broker.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/core.ts`

- [x] **Step 1: 写压缩水位和工具安全顺序失败测试**

工具测试必须覆盖 policy block、approval deny、hook deny、独立 `ToolContext`、stdout/stderr、askUser、plan approval、并行结果保持原 call 顺序。

- [x] **Step 2: 运行测试确认服务不存在**

Run: `npm test -- tests/tool-broker.test.ts`

Expected: FAIL，模块或导出不存在。

- [x] **Step 3: 提取现有逻辑并保持接口**

```ts
export interface ToolBroker {
  execute(call: ToolCall, options: RunAgentOptions): Promise<ToolResult>;
  executeBatch(calls: ToolCall[], options: RunAgentOptions): Promise<ToolResult[]>;
}
```

`executeBatch()` 可以并行完成，但返回数组顺序必须与模型产生的 `calls` 一致。

- [x] **Step 4: 运行行为契约、类型检查和全量测试**

Run: `npm test -- tests/tool-broker.test.ts tests/context.test.ts tests/agent-behavior-v1.test.ts && npm run typecheck && npm test`

Expected: 全部通过。

- [x] **Step 5: 提交服务提取**

```bash
git add src/agent/core.ts src/agent/services/context-service.ts src/agent/services/tool-broker.ts tests/tool-broker.test.ts
git commit -m "refactor: extract context and tool broker services

Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 5: 引入 LangGraph 最小内核并保持 Legacy 默认

**Files:**
- Modify: `/home/opt/develop/aicoding/aiop/package.json`
- Modify: `/home/opt/develop/aicoding/aiop/package-lock.json`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/langgraph/state.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/langgraph/kernel.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/langgraph/graph.ts`
- Create: `/home/opt/develop/aicoding/aiop/tests/langgraph-kernel.test.ts`

- [x] **Step 1: 写单轮、工具循环和 maxSteps 的失败测试**

LangGraph Kernel 必须通过同一 `agent-behavior-v1` 契约，并额外断言一个 AIoP run 使用唯一 `thread_id`。

- [x] **Step 2: 运行测试确认 LangGraph 内核不存在**

Run: `npm test -- tests/langgraph-kernel.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 固定依赖并实现最小 StateGraph**

Run: `npm install @langchain/langgraph@1.4.8`

图只包含 `prepare → model → route → tools → model → finish`，节点调用 Tasks 3-4 的 AIoP 服务，不直接调用 LangChain model/tool adapter。

- [x] **Step 4: 保持 Legacy 为默认并增加显式内核选择**

仅当 `AIOP_AGENT_KERNEL=langgraph` 时选择 LangGraph；值无效或初始化失败时记录原因并回退 Legacy。默认值仍为 `legacy`。

- [x] **Step 5: 运行双内核契约、类型检查和全量测试**

Run: `npm test -- tests/agent-behavior-v1.test.ts tests/langgraph-kernel.test.ts && npm run typecheck && npm test`

Expected: Legacy 与 LangGraph 同时通过契约。

- [x] **Step 6: 提交最小 LangGraph 内核**

```bash
git add package.json package-lock.json src/agent/langgraph tests/langgraph-kernel.test.ts
git commit -m "feat: add langgraph agent kernel

Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 6: 实现 MySQL Checkpointer 与图版本注册表

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/checkpoint/mysql.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/checkpoint/schema.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/langgraph/registry.ts`
- Create: `/home/opt/develop/aicoding/aiop/tests/mysql-checkpointer.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/mysql.ts`

- [x] **Step 1: 写 saver 协议、隔离和删除失败测试**

覆盖 `getTuple/list/put/putWrites/deleteThread`，主键包含 tenant、run/thread、checkpoint namespace 和 id；列表顺序与 LangGraph saver 协议一致。

- [x] **Step 2: 运行测试确认表和 saver 不存在**

Run: `npm test -- tests/mysql-checkpointer.test.ts`

Expected: FAIL，表或 saver 不存在。

- [x] **Step 3: 实现 Kysely 表结构和 BaseCheckpointSaver**

checkpoint payload 使用 LangGraph serializer；AIoP 额外列保存 `tenant_id/run_id/graph_name/graph_version/expires_at`，不把 session 消息写入 checkpoint。

- [x] **Step 4: 接入 checkpoint validation 和恢复测试**

Run: `npm install -D @langchain/langgraph-checkpoint-validation@1.0.4 && npm test -- tests/mysql-checkpointer.test.ts`

Expected: 协议验证和崩溃后恢复测试通过。

- [x] **Step 5: 运行类型检查和全量测试后提交**

Run: `npm run typecheck && npm test`

```bash
git add package.json package-lock.json src/agent/checkpoint src/agent/langgraph/registry.ts src/db/mysql.ts tests/mysql-checkpointer.test.ts
git commit -m "feat: persist langgraph checkpoints in mysql

Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 7: Durable Interaction、Tool Ledger 与 SessionCommitter

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/src/agent/services/session-committer.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/interactions/store.ts`
- Create: `/home/opt/develop/aicoding/aiop/src/agent/tool-ledger/store.ts`
- Create: `/home/opt/develop/aicoding/aiop/tests/session-committer.test.ts`
- Create: `/home/opt/develop/aicoding/aiop/tests/durable-interaction.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/server/http.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/store.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/memory.ts`
- Modify: `/home/opt/develop/aicoding/aiop/src/db/mysql.ts`

- [ ] **Step 1: 写重启恢复、幂等和最终提交失败测试**

覆盖审批/提问持久化、恢复时身份校验、工具 `started/completed/unknown`、非幂等 unknown 转 `recovery_required`、成功/失败/终止消息格式与现有 HTTP 行为一致。

- [ ] **Step 2: 运行测试确认持久记录不存在**

Run: `npm test -- tests/session-committer.test.ts tests/durable-interaction.test.ts`

Expected: FAIL，store 方法不存在。

- [ ] **Step 3: 实现记录模型和事务提交**

工具 idempotency key 使用 `tenantId + runId + toolCallId`；审批 resume 必须校验 tenant、session、run、user、状态和过期时间。

- [ ] **Step 4: 将 LangGraph interrupt 映射到现有 HTTP 事件**

继续发送 `question_required/change_plan_required/approval_required`，恢复请求转为 `Command({ resume })`，前端协议不变。

- [ ] **Step 5: 运行 HTTP、Scheduler、行为契约和全量测试**

Run: `npm test -- tests/http.test.ts tests/scheduler.test.ts tests/session-committer.test.ts tests/durable-interaction.test.ts tests/agent-behavior-v1.test.ts && npm run typecheck && npm test`

Expected: 全部通过。

- [ ] **Step 6: 提交持久交互和提交器**

```bash
git add src/agent/services/session-committer.ts src/agent/interactions src/agent/tool-ledger src/server/http.ts src/db tests/session-committer.test.ts tests/durable-interaction.test.ts
git commit -m "feat: add durable agent interactions and tool ledger

Co-authored-by: AIOS <noreply@bocloud.com>"
```

### Task 8: 灰度、回退与最终验收

**Files:**
- Create: `/home/opt/develop/aicoding/aiop/tests/agent-kernel-parity.test.ts`
- Modify: `/home/opt/develop/aicoding/aiop/docs/DESIGN-langgraph-aiop-integration.md`
- Modify: `/home/opt/develop/aicoding/aiop/src/agent/runtime.ts`

- [ ] **Step 1: 写 Legacy/LangGraph 同输入 parity 测试**

相同脚本模型和工具输入必须得到相同 messages、text、steps、usage、compacted 和事件序列；仅允许 `thread_id/checkpoint` 等内部元数据不同。

- [ ] **Step 2: 加入租户/用户/会话级 feature flag 与自动回退**

灰度顺序固定为测试租户 → 内部用户 → 只读工具会话 → 全工具会话；运行开始后锁定 kernel 和 graphVersion，不在同一个 run 中切换。

- [ ] **Step 3: 执行完整验证矩阵**

Run: `npm run typecheck && npm test`

Expected: 类型检查退出码 0；全部测试通过。

- [ ] **Step 4: 更新设计文档实施状态和回滚手册**

文档必须记录环境变量、灰度规则、checkpoint 清理、失败恢复、禁用 LangGraph 后 Legacy 回退步骤，以及未迁移的控制面模块。

- [ ] **Step 5: 提交最终验收结果**

```bash
git add src/agent/runtime.ts tests/agent-kernel-parity.test.ts docs/DESIGN-langgraph-aiop-integration.md
git commit -m "docs: add langgraph rollout and rollback guide

Co-authored-by: AIOS <noreply@bocloud.com>"
```

## 自检结果

- 功能覆盖：所有 `RunAgentOptions` 由 Task 1 原样透传，Task 2 冻结核心行为，Tasks 3-4 仅提取服务，Tasks 5-8 才逐步切换图内核。
- 安全覆盖：Policy → Approval → Hook → dispatch、RBAC、Sandbox/MCP/Skill、审计和 Tool Ledger 均保留在 AIoP。
- 兼容覆盖：HTTP/SSE、CLI、Scheduler、失败/终止持久化、thinking signature、图片、重试、pending message 和 compaction 均有明确测试任务。
- 恢复覆盖：一个 run 一个 `thread_id`，checkpoint 与 session message 分离，durable interaction 和 tool ledger 覆盖 LangGraph 无法独立解决的恢复窗口。
- 占位符检查：计划没有未定义的 TBD；后续每一阶段均有明确文件、断言范围、命令、预期结果和提交边界。
