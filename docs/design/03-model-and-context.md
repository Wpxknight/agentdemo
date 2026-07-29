# 模型与上下文设计

## 1. 所有权边界

模型调用和上下文不再由 AIoP 自建一套 Provider-neutral loop。

| 能力 | 边界 | 当前路径 |
| --- | --- | --- |
| Provider、模型流与 usage | Pi 复用 | `@earendil-works/pi-ai` |
| Model 配置到 Pi model/provider 的映射 | 薄适配 | `packages/pi-runtime/src/pi/models.ts`、`src/runtime.ts` |
| Agent message 与产品 DTO 转换 | 薄适配 | `packages/pi-runtime/src/pi/message-codec.ts` |
| 流事件与 Durable Event 转换 | 薄适配 | `packages/pi-runtime/src/pi/event-codec.ts` |
| Session Tree、branch、stats | Pi 复用 | Pi Session API |
| SessionStorage 与 committed leaf | AIoP 自研 | `packages/pi-runtime/src/pi/session.ts`、`packages/pi-runtime/src/store/pi-session-mysql.ts` |
| Compaction 执行 | Pi 复用 + 薄适配 | `packages/pi-runtime/src/pi/compaction.ts` |
| 产品消息与用量投影 | AIoP 自研 | `src/agent/projections.ts` |

## 2. 模型选择

`src/runtime.ts` 从非敏感模型配置构造 Pi `Model` 与 `Provider`。协议、base URL、模型名称和能力由配置决定；凭据从受控 Credential Store 注入，不写入 Session、事件或文档。

Pi 的 retry、thinking level、stream event 和 provider error 是执行语义。AIoP 只增加模型并发配额、Durable Run 预算和产品级错误映射。

## 3. Session 与上下文

Pi Session Tree 保存完整会话分支；AIoP MySQL 保存：

- `pi_sessions.current_leaf_id`：当前工作 leaf；
- `pi_sessions.committed_leaf_id`：最后一个已完成 Durable Turn 的 leaf；
- `pi_session_entries`：Pi entry 与稳定 sequence；
- Turn commit 中的 `pi_session_id`、`pi_leaf_id`、`pi_entry_seq`。

恢复时只使用 committed path。未提交分支可用于当前 Attempt 调试，但不能进入产品消息或后续恢复上下文。

## 4. Compaction

Pi 提供 compaction、branch summary 和 Session stats。`packages/pi-runtime/src/pi/compaction.ts` 负责将 AIoP 的预算和事件要求映射到 Pi：

- 压缩前检查 Run 取消、lease 和预算；
- 不把审批、ledger 或敏感 Tool 参数拼进摘要；
- 记录 compaction 计数和 token/cost projection；
- compaction 失败时保留最后 committed leaf。

## 5. Codec 兼容性

`message-codec.ts` 和 `event-codec.ts` 是唯一兼容边界，必须保持：

- assistant text/thinking、ToolCall、ToolResult 的顺序；
- image、usage、stop reason 和 provider metadata 的可解释映射；
- 未知 Pi entry 可安全忽略或保留为 opaque metadata，不能破坏恢复；
- 产品 DTO 不暴露凭据、内部 prompt 或 Tool 原始敏感参数。

## 6. 测试入口

- `tests/pi-runtime/message-codec.test.ts`
- `tests/pi-runtime/event-codec.test.ts`
- `tests/pi-runtime/mysql-session-storage.test.ts`
- `tests/pi-runtime/session-projection.test.ts`
- `tests/pi-runtime/model-concurrency.test.ts`
