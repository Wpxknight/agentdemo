# 模型与上下文设计

## 1. 中立模型契约

Agent 核心不直接使用 Anthropic 或 OpenAI 的 wire format，而使用 `src/model/types.ts` 定义的中立结构。

| 类型 | 作用 |
| --- | --- |
| `Msg` | user/assistant/tool 消息、正文、思考、工具调用与多模态块 |
| `ToolDef` | 暴露给模型的工具名称、描述和 JSON Schema |
| `ToolCall` | 模型生成的调用 id、名称与参数 |
| `ToolResult` | 文本回退、结构化内容块和错误标记 |
| `StreamEvent` | 文本、思考、工具、用量、重试、压缩等中立事件 |
| `ChatModel` | `stream(input)` 异步流接口 |

~~~mermaid
flowchart LR
  Agent[Agent Core]
  Neutral[Neutral Contracts]
  Anthropic[Anthropic Adapter]
  OpenAI[OpenAI Adapter]
  AAPI[Anthropic compatible API]
  OAPI[OpenAI compatible API]

  Agent --> Neutral
  Neutral --> Anthropic --> AAPI
  Neutral --> OpenAI --> OAPI
~~~

Adapter 负责消息转换、工具 Schema 映射、流式事件转换、usage 归一化，并保留 Anthropic thinking block 及 signature。

## 2. 模型配置与选择

`createModel(id, config)` 根据 `protocol: anthropic | openai` 创建 Adapter。配置包含 base URL、API Key、模型名、上下文窗口、图片保留数量、reasoning effort 和 token 单价。

启动时只读取 `default` 租户的 LLM 设置并创建进程级 Model 实例。设置 API 的 Store 调用带请求 tenant key，但 `updateModel()` 会立即替换该进程的全局 Model；当前实现并不是每租户独立模型路由。多租户部署中应把 LLM 设置视为平台级配置，限制修改权限，并避免用非 default tenant 写入造成数据库记录与实际全局运行态不一致。公开设置只返回 Key 是否设置与预览，不返回完整密钥。

## 3. 提示词组合

`buildSystemPrompt()` 组合平台基础行为、运行时额外 system 文本、Skill 摘要、沙箱能力提示和无人值守限制。

提示词是行为引导，不是授权边界。工具调用仍必须经过 Rules、Policy、Approval 和 Hook。

## 4. 模型轮次

~~~mermaid
sequenceDiagram
  participant G as Kernel
  participant C as Context
  participant M as Model Gateway
  participant A as Adapter
  participant P as Provider

  G->>C: compact at boundary
  C-->>G: governed messages
  G->>M: runModelTurn
  M->>C: hard compact to request budget
  M->>M: filter tool definitions
  M->>A: stream system messages tools
  A->>P: provider request
  P-->>A: streaming chunks
  A-->>M: neutral StreamEvent
  M-->>G: text thinking calls usage
~~~

`runModelTurn()` 为一次完整尝试收集文本、思考、工具调用和 usage。可重试错误会整轮重放，前端通过 `model_retry` 回滚失败尝试的展示。

## 5. 上下文预算

默认算法：

`request budget = context window - 32000 output reserve - 16000 safety margin`

且最小预算为 20,000 token。估算规则：

- 文本约按 4 字符/token。
- PNG/JPEG 图片取像素估算与 base64 长度估算的较大值。
- 工具调用、结果、thinking 与 signature 都计入。
- Provider tokenizer 可能不同，因此保留安全余量。

## 6. 三层上下文治理

~~~mermaid
flowchart TD
  Input[Full history]
  Images[Keep recent image messages]
  Single[Truncate oversized text fields]
  Budget{Within hard budget}
  Drop[Drop oldest messages preserving tool pairs]
  Boundary{Reached summary trigger}
  Summary[Summarize stale history]
  Recent[Keep recent messages]
  Send[Send to model]

  Input --> Images --> Single --> Budget
  Budget -->|no| Drop --> Boundary
  Budget -->|yes| Boundary
  Boundary -->|yes| Summary --> Recent --> Send
  Boundary -->|no| Send
~~~

### 6.1 图片治理

只保留最近 K 条带图消息中的图片，旧图片替换为文本占位。K 可为 0。该逻辑同时处理用户附件和工具截图。

### 6.2 硬预算裁剪

- 单条消息限制到预算的约四分之一，至少保留 2,000 token。
- 再从最旧消息开始丢弃。
- 不让结果以孤立 tool 消息开头。
- 裁剪后确保首条 user 语义。
- 最后一条消息保留，必要时转成 user 文本回退。

### 6.3 摘要压缩

达到触发阈值时，将旧消息渲染为受限纯文本，生成 `SUMMARY_PREFIX` 开头的历史摘要；近期消息和真实用户输入保持原样。压缩后完整替换会话历史。

`compactionWatermark` 防止压缩后仍略高于阈值时每轮重复摘要。只有历史继续增长到 watermark 以上才再次尝试。

## 7. 模型重试

`MAX_MODEL_RETRIES = 10`，不含首次尝试。

- 网络错误、5xx、408、429 可重试。
- 其他 4xx 不重试。
- 指数退避从默认 1 秒开始，上限 30 秒。
- AbortSignal 可终止流和退避等待。
- 每次失败产生 `model_retry`，包含应丢弃的文本、思考字符数和工具 id。

重试是整轮重放，不能把失败流中的 tool_call 当作已确认调用。

## 8. Thinking 与多模态

Anthropic thinking block 包含 `thinking + signature`。跨工具轮次回填时必须原样保留。展示用聚合 thinking 与协议用 thinking blocks 分开保存。

多模态统一为 `ToolContentBlock` 的 text 或 image。`ToolResult.content` 始终保留文本回退。

## 9. 用量与成本

模型 Adapter 发出 usage：

- input tokens；
- output tokens；
- cache read tokens；
- cache creation tokens。

Agent Run 累加用量；会话成本根据租户模型设置中的每百万 token 单价折算。未配置价格时只能展示 token，不能推断真实账单。

## 10. 错误边界

| 场景 | 处理 |
| --- | --- |
| 上下文过长 | 请求前硬裁剪；边界处尝试摘要压缩 |
| 单条消息过大 | 截断文本字段；图片按保留策略处理 |
| 摘要失败 | 不破坏原历史，继续使用硬裁剪 |
| Provider 断流 | 整轮重试并发出回滚信息 |
| 不可重试 4xx | 立即失败并保存解释结果 |
| 用户终止 | AbortSignal 中断流或退避 |
| thinking signature 丢失 | 协议错误，需保留原始 block 修复 |

## 11. 测试边界

- Anthropic/OpenAI 消息与流事件映射。
- ToolCall、ToolResult、多模态和 thinking block 回填。
- token 估算、图片剥离、工具配对和首条 user 保证。
- 单条超大消息和长历史裁剪。
- 摘要切分、watermark 与完整历史替换。
- 重试次数、4xx 分类、指数退避、AbortSignal。
- usage 累加与成本计算。

## 12. 源码依据

- `src/model/types.ts`
- `src/model/factory.ts`
- `src/model/anthropic.ts`
- `src/model/openai.ts`
- `src/model/cost.ts`
- `src/agent/context.ts`
- `src/agent/services/context-service.ts`
- `src/agent/services/model-gateway.ts`
- `src/agent/services/prompt.ts`
- `src/runtime.ts`
