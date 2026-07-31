# 模型与上下文设计

## 1. 所有权边界

模型调用和上下文不再由 AIoP 自建一套 Provider-neutral loop。

| 能力 | 边界 | 当前路径 |
| --- | --- | --- |
| Provider、模型流与 usage | Pi 复用 | `@earendil-works/pi-ai` |
| Model 配置到 Pi model/provider 的映射 | 薄适配 | `packages/pi-runtime/src/pi/models.ts`、`src/runtime.ts` |
| 产品输入到 Pi user message | 薄适配 | `packages/pi-runtime/src/pi/agent.ts` |
| AgentHarness 事件到 Durable Event | 薄适配 | `packages/pi-runtime/src/pi/event-codec.ts` |
| Session Tree、branch、stats | Pi 复用 | Pi Session API |
| SessionStorage 与 committed leaf | AIoP 自研 | `packages/pi-runtime/src/pi/session.ts`、`packages/pi-runtime/src/store/pi-session-mysql.ts` |
| Compaction 执行 | Pi 复用 + 薄适配 | `packages/pi-runtime/src/pi/compaction.ts` |
| 产品消息与用量投影 | AIoP 自研 | `src/agent/projections.ts` |

## 2. 模型选择

`src/runtime.ts` 从运行设置构造 Pi `Model`/`Models`。协议支持 `anthropic` 与 `openai`，配置包含 base URL、模型、上下文窗口、图片保留数、effort 和可选价格；API key 经设置密钥服务加密保存，不写入 Session、事件或文档。

Pi 的 retry、thinking level、stream event 和 provider error 是执行语义。AIoP 增加模型并发配额、Durable Run 预算、成本投影和产品级错误映射，不另建 Provider-neutral loop。

## 3. Session 与上下文

Pi Session Tree 保存完整会话分支；AIoP MySQL 保存：

- `pi_sessions.current_leaf_id`：当前工作 leaf；
- `pi_sessions.committed_leaf_id`：最后一个已完成 Durable Turn 的 leaf；
- `pi_session_entries`：Pi entry 与稳定 sequence；
- Turn commit 中的 `pi_session_id`、`pi_leaf_id`、`pi_entry_seq`。

恢复时只使用 committed path。未提交分支可用于当前 Attempt 调试，但不能进入产品消息或后续恢复上下文。

### 3.1 一条消息如何进入上下文

1. 产品层只提交 `AgentInputMessage`，不构造 Pi assistant/toolResult 消息。
2. `PiAgentSession` 把用户输入追加到 Session，并让 `AgentHarness` 从当前 branch 构造模型上下文。
3. `context` hook 会清理浏览器预览等不应长期进入模型的内容。
4. Tool result 以 Pi 原生消息保存在 Session Tree；产品 Event 只保存裁剪后的展示与恢复事实。
5. Turn 成功提交后，`committed_leaf_id` 才成为下一次恢复的上下文起点。

因此，Session Tree、durable event 和产品 message DTO 是三个不同视图，不能互相替代。

## 4. Compaction

Pi 提供 compaction、branch summary 和 Session stats。`packages/pi-runtime/src/pi/compaction.ts` 直接导出 `prepareCompaction`/`compact` 的薄包装，运行时通过 AgentHarness 事件记录压缩前后统计：

- Durable Run 在外围持续检查取消、lease 和预算；
- `packages/pi-runtime/src/pi/event-codec.ts` 只记录消息数、token、summary 长度等裁剪信息，不持久化完整 prompt；
- 产品 projection 从已提交 leaf 计算上下文和用量；
- compaction 失败时恢复边界仍是最后 committed leaf。

## 5. 事件与消息边界

旧的兼容消息 codec 与兼容消息类型已删除。当前边界是 `packages/pi-runtime/src/pi/agent.ts` 的输入/交互映射和 `packages/pi-runtime/src/pi/event-codec.ts` 的持久事件投影：

- Pi Session 原生保存 assistant、thinking、ToolCall、ToolResult 与 image；
- 已知 Harness event 投影为稳定、限长、脱敏的 durable detail；
- 未知 Pi event 记录为 `pi_extension`，仅保留类型和安全 key；
- 产品 DTO 不暴露凭据、内部 prompt 或 Tool 原始敏感参数。

## 6. 测试入口

- `tests/pi-runtime/event-codec.test.ts`
- `tests/pi-runtime/pi-agent.test.ts`
- `tests/pi-runtime/mysql-session-storage.test.ts`
- `tests/pi-runtime/session-projection.test.ts`
- `tests/pi-runtime/model-concurrency.test.ts`

## 7. 容易混淆的地方

- `src/llm/` 仍服务产品配置、测试和部分直接能力，但 Agent loop 的模型流由 Pi `Models` 驱动。
- EventCodec 不是完整 transcript codec；它故意限制字符串、数组、深度、key 和总字节数。
- compaction summary 是上下文内容，不是审批、审计或 Tool Ledger 的事实源。
- 模型 usage 与产品 cost projection 可能来自不同层；新增 provider 字段时要同步检查 projection 和 tests。
