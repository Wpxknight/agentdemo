# 智能助手设计方案（TypeScript）

> 一个支持 **Skill / MCP / E2B Sandbox（含远端连接与浏览器桌面）/ 自定义模型服务（Anthropic + OpenAI 双协议）** 的智能助手，
> 并具备**多集群 kubectl 运维**能力（动态拉起 in-cluster sandbox + 安全护栏）。
> 实现语言：**TypeScript**（Node.js，前后端可同栈）。

---

## 1. 设计目标

| 能力 | 说明 |
|---|---|
| 自定义模型服务 | 支持 `base_url` / `api_key` 配置，同时兼容 **Anthropic**(`/v1/messages`) 与 **OpenAI**(`/v1/chat/completions`) 协议；可接官方、第三方中转、本地 vLLM/Ollama |
| Skill | Claude Code 风格的渐进式技能（`SKILL.md` + frontmatter），按需加载，省 token |
| MCP | 作为 MCP client，支持 stdio / SSE / Streamable HTTP transport |
| E2B Sandbox | 隔离执行代码；支持**新建 / 连接远端 / 动态拉起**；支持**浏览器桌面**（noVNC 流 + computer-use / CDP） |
| 多集群运维 | 统一 `kubectl(cluster, args)` 工具，动态拉起 in-cluster sandbox，凭据用 Pod SA，配 policy 护栏 |

核心设计原则：**对内统一一套消息/工具格式**，对外用 adapter 适配差异；**Skill / MCP / Sandbox / kubectl 全部归一为"工具"**交给 agent loop。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│  Agent Core  (agentic loop / tool dispatch / policy)      │
├──────────┬──────────┬──────────┬──────────┬──────────────┤
│  Model   │  Skill   │   MCP    │ Sandbox  │  K8s Ops      │
│  Layer   │ Registry │  Client  │ Manager  │ (kubectl)     │
├──────────┴──────────┴──────────┴──────────┴──────────────┤
│  Config  (models / skills / mcpServers / clusters)        │
└─────────────────────────────────────────────────────────┘
```

数据流：
```
用户 → Agent Core → Model Layer(选模型/协议) → 模型返回 tool_calls
     → Policy 中间件(策略/审批/审计) → Tool Dispatch(路由到 Skill/MCP/Sandbox/K8s)
     → 结果回填 messages → 循环直到无 tool_call
```

---

## 3. 技术栈

| 关注点 | 选型 |
|---|---|
| 语言/运行时 | TypeScript + Node.js（≥ 20） |
| 模型 SDK | `@anthropic-ai/sdk`、`openai`（均支持自定义 `baseURL`/`apiKey`） |
| MCP | `@modelcontextprotocol/sdk`（client 模式） |
| Sandbox | `e2b` / `@e2b/code-interpreter`、`@e2b/desktop` |
| 后端 | Fastify / Express + SSE（把 agent 事件流式推给前端） |
| 前端 | 任意 Web 框架；聊天流式 + `<iframe>` 嵌 noVNC 桌面流 |
| 校验 | `zod`（config 与工具入参校验） |
| 日志/审计 | `pino` + 独立审计 sink |

最新 Claude 模型 id：`claude-opus-4-8`、`claude-sonnet-4-6`、`claude-haiku-4-5-20251001`。

---

## 4. 模型层（Anthropic + OpenAI 双协议）

### 4.1 内部中立格式

定义一套与 provider 无关的消息/事件类型，adapter 负责双向翻译。

```ts
// model/types.ts
export type Role = 'user' | 'assistant' | 'tool';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface ToolCall { id: string; name: string; args: unknown; }
export interface ToolResult { id: string; content: string; isError?: boolean; }

export interface Msg {
  role: Role;
  text?: string;
  toolCalls?: ToolCall[];   // assistant
  toolResults?: ToolResult[]; // tool
}

// 流式中立事件
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'stop'; reason: string };

export interface ChatModel {
  stream(input: {
    system: string;
    messages: Msg[];
    tools: ToolDef[];
  }): AsyncIterable<StreamEvent>;
}
```

### 4.2 两个 adapter

| | Anthropic 协议 | OpenAI 协议 |
|---|---|---|
| endpoint | `POST /v1/messages` | `POST /v1/chat/completions` |
| SDK | `@anthropic-ai/sdk` | `openai` |
| system | 顶层 `system` 字段 | `messages[0]` role=system |
| 工具调用 | content block `tool_use` / `tool_result` | `tool_calls` / role=tool message |
| 流式事件 | `content_block_delta` 等 | `choices[].delta` |

```ts
// model/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicModel implements ChatModel {
  private client: Anthropic;
  constructor(private cfg: { baseURL: string; apiKey: string; model: string }) {
    this.client = new Anthropic({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  }

  async *stream({ system, messages, tools }) {
    const stream = this.client.messages.stream({
      model: this.cfg.model,
      max_tokens: 8192,
      system,
      tools: tools.map(t => ({
        name: t.name, description: t.description, input_schema: t.inputSchema,
      })),
      messages: toAnthropicMessages(messages), // 内部格式 -> content blocks
    });

    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta')
        yield { type: 'text_delta', text: ev.delta.text };
      // tool_use 块累积后 yield { type:'tool_call', ... }
      // message_delta -> usage / stop
    }
  }
}
```

```ts
// model/openai.ts
import OpenAI from 'openai';

export class OpenAIModel implements ChatModel {
  private client: OpenAI;
  constructor(private cfg: { baseURL: string; apiKey: string; model: string }) {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  }

  async *stream({ system, messages, tools }) {
    const stream = await this.client.chat.completions.create({
      model: this.cfg.model,
      stream: true,
      messages: toOpenAIMessages(system, messages), // system 进 messages[0]
      tools: tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    });

    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta;
      if (d?.content) yield { type: 'text_delta', text: d.content };
      // d.tool_calls 累积 -> yield tool_call
    }
  }
}
```

### 4.3 工厂（由 config 驱动）

```ts
// model/factory.ts
export function createModel(cfg: ModelConfig): ChatModel {
  switch (cfg.protocol) {
    case 'anthropic': return new AnthropicModel(cfg);
    case 'openai':    return new OpenAIModel(cfg);
  }
}
```

> ⚠️ 跨协议有损：Anthropic 的 prompt caching、thinking blocks 在 OpenAI 协议无等价物。内部格式可保留 provider-specific 的透传字段，adapter 能用则用、不能用则忽略。

---

## 5. Agent Core（agentic loop）

```ts
// agent/core.ts
export async function runAgent(opts: {
  model: ChatModel;
  task: string;
  tools: ToolRegistry;     // 汇集 内置 + Skill + MCP + Sandbox + K8s
  policy: PolicyMiddleware;
  onEvent: (e: StreamEvent) => void;
}) {
  const messages: Msg[] = [{ role: 'user', text: opts.task }];

  while (true) {
    const calls: ToolCall[] = [];
    let text = '';

    for await (const ev of opts.model.stream({
      system: buildSystemPrompt(opts.tools),
      messages,
      tools: opts.tools.defs(),
    })) {
      opts.onEvent(ev);
      if (ev.type === 'text_delta') text += ev.text;
      if (ev.type === 'tool_call') calls.push(ev.call);
    }

    messages.push({ role: 'assistant', text, toolCalls: calls });
    if (calls.length === 0) break;

    const results = await Promise.all(calls.map(async (c) => {
      const decision = await opts.policy.check(c);          // 策略/审批门
      if (decision.blocked) return { id: c.id, content: decision.reason, isError: true };
      return opts.tools.dispatch(c);                         // 路由执行
    }));

    messages.push({ role: 'tool', toolResults: results });
  }
}
```

`ToolRegistry.dispatch` 按工具名前缀路由：`mcp:*` → MCP client，`skill:*` → Skill，`sbx:*` → Sandbox，`kubectl` → K8s ops。

---

## 6. Skill 系统

Skill = 目录 + `SKILL.md`（frontmatter `name`/`description` + 正文），**渐进式加载**：

- 启动时只把每个 skill 的 `name + description` 注入 system prompt（省 token）。
- 提供内置工具 `load_skill(name)`，模型判断相关时调用，才读取全文及引用文件。

```
skills/
  pdf-extract/
    SKILL.md        # --- name: pdf-extract \n description: ... ---  + 正文
    extract.py      # 可在 sandbox 中执行的脚本
```

```ts
// skill/registry.ts
export class SkillRegistry {
  private skills = new Map<string, { description: string; dir: string }>();

  async load(rootDir: string) { /* 扫描目录, 解析 frontmatter */ }

  summaries(): string {            // 注入 system prompt
    return [...this.skills].map(([n, s]) => `- ${n}: ${s.description}`).join('\n');
  }

  loadSkillTool(): ToolDef { /* name:'load_skill', 入参 {name} */ }

  async expand(name: string): Promise<string> {
    // 读取 SKILL.md 全文（含引用文件），作为 tool_result 返回给模型
  }
}
```

---

## 7. MCP 集成

作为 MCP **client**，支持 stdio / SSE / HTTP。启动时连接 → `listTools()` → 转成内部 `ToolDef`（命名空间前缀 `mcp:<server>:<tool>`）→ 加入 registry。

```ts
// mcp/manager.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class McpManager {
  private clients = new Map<string, Client>();

  async connect(cfg: McpServerConfig) {
    const transport = cfg.transport === 'stdio'
      ? new StdioClientTransport({ command: cfg.command!, args: cfg.args })
      : new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers: cfg.headers } });

    const client = new Client({ name: 'assistant', version: '1.0.0' });
    await client.connect(transport);
    this.clients.set(cfg.name, client);
  }

  async tools(): Promise<ToolDef[]> {
    const out: ToolDef[] = [];
    for (const [server, c] of this.clients) {
      const { tools } = await c.listTools();
      for (const t of tools)
        out.push({ name: `mcp:${server}:${t.name}`, description: t.description ?? '', inputSchema: t.inputSchema });
    }
    return out;
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const [, server, tool] = name.split(':');
    const res = await this.clients.get(server)!.callTool({ name: tool, arguments: args as any });
    return { id: '', content: JSON.stringify(res.content), isError: res.isError };
  }
}
```

---

## 8. E2B Sandbox（执行 / 远端 / 动态拉起 / 浏览器桌面）

### 8.1 三种生命周期

```ts
import { Sandbox } from '@e2b/code-interpreter';

// (a) 新建
const sbx = await Sandbox.create({ timeoutMs: 3600_000, apiKey });

// (b) 连接远端已有（持久化复用）
const sbx2 = await Sandbox.connect(sandboxId, { apiKey });
await sbx2.setTimeout(3600_000); // 续命，防回收

// (c) 执行
const exec = await sbx.runCode('print(2+2)');
```

### 8.2 浏览器桌面（远端 sandbox 内）

用 `@e2b/desktop`：完整 Linux 桌面 + noVNC 流。

```ts
import { Sandbox as Desktop } from '@e2b/desktop';

const d = await Desktop.create();
await d.stream.start();
const url = d.stream.getUrl();   // 前端 <iframe src={url}> 即可看到桌面

// 方式 A: computer-use（截图 → 模型给坐标 → 操作）通用
await d.launch('google-chrome');
await d.leftClick(x, y); await d.write('...'); const png = await d.screenshot();

// 方式 B: Playwright over CDP（桌面里起 Chrome --remote-debugging-port）
// 结构化操作 DOM，更稳更快，适合明确的网页自动化
```

重连远端桌面同样靠 `sandboxId` + `Desktop.connect(id)`，前端始终用 `stream.getUrl()` 渲染。

### 8.3 暴露为工具

`sbx:run_code` / `sbx:run_command` / `sbx:browser_navigate` / `sbx:browser_click` / `sbx:screenshot`，全部交给 agent loop。

---

## 9. 多集群 kubectl 运维

### 9.1 核心抽象：目标集群 ⊥ 执行位置

把"**操作哪个集群**"和"**kubectl 在哪跑**"解耦。**sandbox 动态拉起为目标集群内的 Pod**，同时拿到：
- **可达性**（在集群网络里，API 天然可达）
- **隔离性**（仍是 sandbox）
- **凭据**（作为 Pod 跑，kubectl 用 **in-cluster config** / projected SA token，**无需 kubeconfig，凭据不出集群**）

### 9.2 集群注册表（存"怎么拉起"，不存凭据）

```ts
// config/clusters.ts
export interface ClusterSpec {
  e2bControl: string;       // 该集群内的 E2B 控制面地址
  template: string;         // 预装 kubectl/helm/jq 的模板镜像（缓解冷启动）
  namespace: string;        // sandbox Pod 所在 ns
  serviceAccount: string;   // 拉起时绑定的 SA = 权限边界
  access: 'ro' | 'rw';
  allowNamespaces?: string[];
}

export const clusters: Record<string, ClusterSpec> = {
  'prod-eu': { e2bControl: 'https://e2b.prod-eu.internal', template: 'ops-kubectl',
               namespace: 'ai-ops', serviceAccount: 'ai-ops-rw', access: 'rw' },
  'prod-us': { e2bControl: 'https://e2b.prod-us.internal', template: 'ops-kubectl',
               namespace: 'ai-ops', serviceAccount: 'ai-ops-ro', access: 'ro' },
};
```

> 集群身份在**拉起那一刻**绑定：E2B 把 sandbox 作为 Pod 调度进 `namespace` 并指定 `serviceAccountName`，Pod 起来即用该 SA 的 in-cluster config。

### 9.3 生命周期管理器（懒加载 + 复用 + 回收）

**不要每条命令拉一个**（冷启动昂贵）。按 **(session × cluster)** 懒加载、复用、idle 回收。

```ts
// sandbox/lifecycle.ts
interface Entry { sandbox: Sandbox; lastUsed: number; }

export class SandboxManager {
  private cache = new Map<string, Entry>(); // key = `${sessionId}:${cluster}`
  private idleMs = 10 * 60_000;

  async ensure(sessionId: string, cluster: string): Promise<Sandbox> {
    const key = `${sessionId}:${cluster}`;
    const hit = this.cache.get(key);
    if (hit) { hit.lastUsed = Date.now(); return hit.sandbox; }

    const spec = clusters[cluster];
    const sandbox = await Sandbox.create({
      domain: spec.e2bControl,           // 指向目标集群控制面
      template: spec.template,
      metadata: { namespace: spec.namespace, serviceAccount: spec.serviceAccount },
    });
    audit.log('sandbox.create', { sessionId, cluster, sa: spec.serviceAccount });
    this.cache.set(key, { sandbox, lastUsed: Date.now() });
    return sandbox;
  }

  // 定时器：idle 超时 / 会话结束 → kill + 审计销毁
  async gc() {
    const now = Date.now();
    for (const [key, e] of this.cache) {
      if (now - e.lastUsed > this.idleMs) {
        await e.sandbox.kill(); this.cache.delete(key);
        audit.log('sandbox.destroy', { key });
      }
    }
  }
}
```

冷启动缓解：**预烘焙模板** + **会话级复用**（够用）；高频核心集群再加 **warm pool**（每集群预热 1~2 个空闲 sandbox 直接领用）。

### 9.4 kubectl 工具

```ts
// tools/kubectl.ts
export function kubectlTool(mgr: SandboxManager): ToolHandler {
  return {
    def: {
      name: 'kubectl',
      description: '在指定集群执行 kubectl。变更类命令会先 dry-run 并可能需要审批。',
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string' },
          args: { type: 'string' },
          dryRun: { type: 'boolean', default: false },
        },
        required: ['cluster', 'args'],
      },
    },
    async run({ cluster, args, dryRun }, ctx) {
      const sbx = await mgr.ensure(ctx.sessionId, cluster);
      // 每集群一个 sandbox、用 in-cluster config，物理上不会打错集群
      const cmd = dryRun ? `kubectl ${args} --dry-run=server` : `kubectl ${args}`;
      const res = await sbx.commands.run(cmd);
      audit.log('kubectl.exec', { cluster, args, dryRun, exit: res.exitCode });
      return { id: '', content: res.stdout + res.stderr, isError: res.exitCode !== 0 };
    },
  };
}
```

### 9.5 Policy 中间件（dispatch 之前，运维必备）

```ts
// agent/policy.ts
const MUTATING = /\b(apply|delete|edit|scale|patch|replace|cordon|drain|rollout)\b/;

export class PolicyMiddleware {
  async check(call: ToolCall): Promise<{ blocked: boolean; reason?: string; needApproval?: boolean }> {
    if (call.name !== 'kubectl') return { blocked: false };
    const { cluster, args } = call.args as { cluster: string; args: string };
    const spec = clusters[cluster];

    // 1. 读写分离：ro 集群拦截一切变更
    if (spec.access === 'ro' && MUTATING.test(args))
      return { blocked: true, reason: `cluster ${cluster} is read-only` };

    // 2. 危险模式：禁止无 selector 的批量删除 / --all-namespaces 删除
    if (/delete\b.*--all-namespaces/.test(args) || /delete\b.*--all\b/.test(args))
      return { blocked: true, reason: 'mass deletion forbidden' };

    // 3. 生产变更：需人工审批门
    if (cluster.startsWith('prod-') && MUTATING.test(args))
      return { blocked: false, needApproval: true };

    return { blocked: false };
  }
}
```

> 审批门实现：`needApproval` 时暂停 agent loop，把 **server dry-run 的 diff** 推给用户确认，确认后再真正执行。

### 9.6 安全双层

| 层 | 职责 |
|---|---|
| **Agent 侧 Policy 中间件** | 业务策略：读写分离、dry-run 预演、生产审批、危险命令拦截、全量审计（RBAC 表达不了的） |
| **Sandbox 内 SA RBAC** | 硬权限边界、纵深防御的最后一道（"能不能做"） |

两层缺一不可。动态短命 sandbox 的红利：凭据随用随生、窗口短、爆炸半径随时间收敛。

### 9.7 多集群运维全貌

```
Agent ──kubectl(cluster,args)──> Policy(读写分离/dry-run/审批/危险拦截/审计)
                                      │通过
                                      ▼
                              SandboxManager.ensure(session,cluster)
                              ├─ 缓存命中 → 复用
                              └─ 未命中 → 目标集群控制面动态拉起
                                          (template + namespace + SA) → 缓存 + idle TTL
                                                  │
                                                  ▼
                                  sandbox(Pod, in-cluster SA) 执行 kubectl
                              [idle TTL / 会话结束 → 自动销毁 + 审计]
```

---

## 10. 配置系统

单一 config（用 `zod` 校验），驱动所有层。**凭据从环境变量/密钥管理注入，不写死。**

```ts
// config/schema.ts
import { z } from 'zod';

export const Config = z.object({
  models: z.record(z.object({
    protocol: z.enum(['anthropic', 'openai']),
    baseURL: z.string().url(),
    apiKey: z.string(),
    model: z.string(),
  })),
  defaultModel: z.string(),
  skills: z.object({ dir: z.string() }),
  mcpServers: z.record(z.object({
    transport: z.enum(['stdio', 'sse', 'http']),
    command: z.string().optional(), args: z.array(z.string()).optional(),
    url: z.string().optional(), headers: z.record(z.string()).optional(),
  })),
  clusters: z.record(z.object({
    e2bControl: z.string(), template: z.string(), namespace: z.string(),
    serviceAccount: z.string(), access: z.enum(['ro', 'rw']),
    allowNamespaces: z.array(z.string()).optional(),
  })),
  // MySQL 连接全部来自环境变量（见 14.4），不放进配置文件
  // MYSQL_HOST / MYSQL_PORT / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD_BASE64 ...
});
```

```jsonc
// config.example.jsonc
{
  "models": {
    "my-claude": { "protocol": "anthropic", "baseURL": "https://...", "apiKey": "${ANTHROPIC_KEY}", "model": "claude-opus-4-8" },
    "my-gpt":    { "protocol": "openai",    "baseURL": "https://...", "apiKey": "${OPENAI_KEY}",    "model": "gpt-4o" },
    "local":     { "protocol": "openai",    "baseURL": "http://localhost:8000/v1", "apiKey": "x", "model": "qwen" }
  },
  "defaultModel": "my-claude",
  "skills": { "dir": "./skills" },
  "mcpServers": {
    "filesystem": { "transport": "stdio", "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/data"] },
    "github":     { "transport": "http", "url": "https://...", "headers": { "Authorization": "Bearer ${GH_TOKEN}" } }
  },
  "clusters": {
    "prod-eu": { "e2bControl": "https://e2b.prod-eu.internal", "template": "ops-kubectl", "namespace": "ai-ops", "serviceAccount": "ai-ops-rw", "access": "rw" },
    "prod-us": { "e2bControl": "https://e2b.prod-us.internal", "template": "ops-kubectl", "namespace": "ai-ops", "serviceAccount": "ai-ops-ro", "access": "ro" }
  }
  // MySQL 不在此文件配置，全部走环境变量（见 §14.4）：
  //   MYSQL_HOST / MYSQL_PORT / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD_BASE64 / MYSQL_SSL / MYSQL_POOL_SIZE
}
```

---

## 11. 安全与审计

- **凭据**：模型 apiKey 从密钥管理注入；集群凭据 = sandbox Pod 的 SA，最小 RBAC，**不出集群**。
- **审计 sink**（独立落盘/上报）至少记录：
  - `model.call`（会话/模型/token）
  - `tool.dispatch` / `kubectl.exec`（谁/会话/集群/命令/结果）
  - `sandbox.create` / `sandbox.destroy`（会话/集群/SA/生命周期）— "谁在何时对哪个集群有过执行能力"可追溯
  - `policy.block` / `approval.granted`
- **爆炸半径**：危险命令规则引擎、生产审批门、动态短命 sandbox。
- **拉起也要过策略**：对 `prod-*` 拉 rw sandbox 本身也需审批，防拉起被滥用。

---

## 12. 目录结构

```
src/
  agent/
    core.ts          # agentic loop
    policy.ts        # dispatch 前策略/审批/审计
    tools.ts         # ToolRegistry: 汇集 + 路由 dispatch
  model/
    types.ts         # 内部中立格式
    anthropic.ts     # Anthropic 协议 adapter
    openai.ts        # OpenAI 协议 adapter
    factory.ts
  skill/
    registry.ts      # 渐进式加载
  mcp/
    manager.ts       # MCP client（stdio/sse/http）
  sandbox/
    lifecycle.ts     # SandboxManager: 懒加载/复用/GC
    desktop.ts       # 浏览器桌面（noVNC/computer-use/CDP）
  tools/
    kubectl.ts       # 多集群 kubectl 工具
    builtin.ts       # run_code / run_command / screenshot ...
  config/
    schema.ts        # zod
    load.ts          # 读取 + 环境变量注入
  server/
    http.ts          # Fastify + SSE 事件流
  audit/
    sink.ts
skills/              # 各 SKILL.md
config.example.jsonc
```

---

## 13. 落地路线图

1. **模型层 + agent loop**：打通单工具调用，验证 Anthropic / OpenAI 双 adapter（含流式）。
2. **内置工具 + E2B `run_code`**：新建 + connect 两种模式。
3. **MCP client**：接一个 stdio server 验证命名空间路由。
4. **Skill registry**：渐进式加载 + `load_skill`。
5. **多集群 kubectl**：`SandboxManager`（懒加载/TTL/GC）+ `kubectl` 工具 + Policy 中间件 + 审计。
6. **E2B Desktop + 浏览器**：先 computer-use，再按需加 CDP；前端嵌 noVNC 流。
7. **审批门 + warm pool**：生产变更交互式审批；高频集群预热池。
8. **持久化**：外部 MySQL（连接走环境变量、密码 base64）；应用无状态多副本。
9. **定时任务**：`schedule_task` 工具会话式创建落库；调度器 tick（`SKIP LOCKED`）触发 → 调 skill/mcp → 写 `task_runs`。
10. **多租户 + 会话隔离 + 本地认证**（§15 P1）：各表 `tenant_id`、`AuthProvider`/`LocalAuthProvider`、`RequestContext` 贯穿。
11. **RBAC 三角色 + 授权融合**（§15 P2）：权限矩阵、API RBAC 中间件、Policy 融合、用户/租户管理。
12. **SSO 对接**（§15 P3）：`OidcAuthProvider`、claims→tenant/role 映射、JIT 建号。

---

## 14. 持久化与存储（外部 MySQL）

设计约束：**只用外部独立 MySQL**，不内嵌数据库、不引入 Redis。MySQL 连接（地址/端口/库名/用户/密码）**全部由环境变量配置**，密码以 **base64 编码**传入、应用启动时解码。

> ⚠️ **base64 是编码，不是加密**。它只是避免明文直观可见，挡不住能读到该值的人。真正的机密性靠：把 base64 值放进 **k8s Secret**（Secret 本身即 base64 存储）+ RBAC 限制读取 + etcd 静态加密 / 外部密钥管理（Vault、External Secrets）。本设计按需求做"环境变量传 base64 → 应用解码"，安全性仍依赖 Secret 体系。

### 14.1 原则

- **唯一数据库 = 外部独立 MySQL**：消息、审计、任务执行记录都进 MySQL；应用本身**无状态**（Deployment，可多副本 HA，不需要 PVC）。
- **连接参数全走环境变量**：地址/端口/库/用户/密码，便于不同环境（dev/staging/prod）灵活切换。
- **密码 base64**：环境变量传 base64 字符串，应用启动解码后再建连接池。
- **低频声明式数据**仍走 k8s 原生对象：Secret / ConfigMap / CRD。
- **调度**用应用内调度器（轮询 DB 中的 `scheduled_tasks`），无队列/调度组件（见 §14.7）。

> ⚠️ **红线**：高频/增长数据绝不进 etcd/CRD（单对象 ~1.5MB 上限），一律进 MySQL。

### 14.2 数据 → 存储映射

| 数据 | 写频 | 存储 |
|---|---|---|
| 模型 apiKey、MySQL 密码、SA token | 低 | **Secret**（base64，配合 RBAC / 密钥管理） |
| 模型 / MCP 配置 | 低 | **ConfigMap** |
| 集群注册表（集群→拉起 spec） | 低、声明式 | **CRD `Cluster`** 或 ConfigMap |
| 定时任务定义 | 中、用户会话创建 | **MySQL `scheduled_tasks`** |
| 会话 / 消息历史 | 高 | **MySQL** |
| 审计日志 | 高、追加 | **MySQL** |
| 任务执行记录 / 状态 | 高 | **MySQL `task_runs`** |
| sandbox 会话映射 | 临时、可重建 | 内存（重启从 MySQL 重建） |
| 浏览器截图 / 大产物（可选） | 大对象 | 外部 S3 / 对象存储（不放 DB） |

### 14.3 存储布局

```
控制面集群（助手所在）:                       外部:
  ┌────────────────────────────────┐       ┌──────────────┐
  │ Secret    apiKey / MYSQL 密码(b64)│       │              │ ← 消息/审计
  │ ConfigMap 模型/MCP/集群注册表      │  ───▶ │ 独立 MySQL    │   定时任务定义
  │ ─────────────────────────────── │       │ (host:port)  │   task_runs 结果
  │ Deployment: 应用(无状态, N 副本)   │       └──────────────┘
  │   └ 内含调度器 tick(轮询 DB)       │       (可选) S3 ← 截图/大产物
  └────────────────────────────────┘
  应用无 PVC、无状态：所有持久数据（含定时任务）在外部 MySQL，可随意多副本/重启
```

### 14.4 环境变量配置 + 解码

```ts
// config/mysql.ts —— 全部从环境变量读取
export interface MysqlConfig {
  host: string; port: number; database: string;
  user: string; password: string; ssl?: boolean; poolSize: number;
}

export function loadMysqlConfig(): MysqlConfig {
  const env = process.env;
  const b64 = env.MYSQL_PASSWORD_BASE64;
  if (!b64) throw new Error('MYSQL_PASSWORD_BASE64 is required');

  return {
    host:     required('MYSQL_HOST'),
    port:     Number(env.MYSQL_PORT ?? 3306),
    database: required('MYSQL_DATABASE'),
    user:     required('MYSQL_USER'),
    password: Buffer.from(b64, 'base64').toString('utf8'),  // ← base64 解码
    ssl:      env.MYSQL_SSL === 'true',
    poolSize: Number(env.MYSQL_POOL_SIZE ?? 10),
  };
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`env ${key} is required`);
  return v;
}
```

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `MYSQL_HOST` | 连接地址 | 必填 |
| `MYSQL_PORT` | 端口 | `3306` |
| `MYSQL_DATABASE` | 库名 | 必填 |
| `MYSQL_USER` | 用户名 | 必填 |
| `MYSQL_PASSWORD_BASE64` | **base64 编码的密码** | 必填 |
| `MYSQL_SSL` | 是否启用 TLS | `false` |
| `MYSQL_POOL_SIZE` | 连接池大小 | `10` |

> 生成 base64 密码：`echo -n 'your-password' | base64`（`-n` 不加换行，否则解码出多余 `\n`）。

### 14.5 数据访问层（mysql2 + Kysely）

```ts
// db/index.ts
import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { loadMysqlConfig } from '../config/mysql';

export function createDb(): Kysely<DB> {
  const c = loadMysqlConfig();
  const pool = createPool({
    host: c.host, port: c.port, database: c.database,
    user: c.user, password: c.password,              // 已解码
    ssl: c.ssl ? {} : undefined,
    connectionLimit: c.poolSize, charset: 'utf8mb4',
  });
  return new Kysely<DB>({ dialect: new MysqlDialect({ pool }) });
}

// 业务通过 Store 接口访问，便于测试 mock
export interface Store {
  appendMessage(m: { session: string; role: string; content: string; ts: number }): Promise<void>;
  listMessages(session: string): Promise<Msg[]>;
  writeAudit(a: { session: string; kind: string; cluster?: string; detail: string; ts: number }): Promise<void>;
}
```

建表（迁移，`utf8mb4`、epoch 整型时间戳避时区坑）：

```sql
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session VARCHAR(64), role VARCHAR(16), content LONGTEXT, ts BIGINT,
  INDEX idx_session (session)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session VARCHAR(64), kind VARCHAR(32), cluster VARCHAR(64),
  detail LONGTEXT, ts BIGINT,
  INDEX idx_cluster (cluster), INDEX idx_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 14.6 部署：无状态 Deployment + Secret 注入

应用无 PVC、无状态，可多副本。MySQL 连接参数从 Secret/ConfigMap 注入。

```yaml
# secret.yaml —— 密码以 base64 存（k8s Secret data 本就是 base64）
apiVersion: v1
kind: Secret
metadata: { name: mysql-secret }
data:
  MYSQL_PASSWORD_BASE64: eW91ci1wYXNzd29yZA==   # base64('your-password')
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: ai-ops }
spec:
  replicas: 2                          # ← 无状态，可多副本 HA
  selector: { matchLabels: { app: ai-ops } }
  template:
    metadata: { labels: { app: ai-ops } }
    spec:
      containers:
        - name: app
          image: ai-ops:latest
          env:
            - { name: MYSQL_HOST, value: "mysql.db.internal" }
            - { name: MYSQL_PORT, value: "3306" }
            - { name: MYSQL_DATABASE, value: "ai_ops" }
            - { name: MYSQL_USER, value: "ai_ops" }
            - name: MYSQL_PASSWORD_BASE64
              valueFrom: { secretKeyRef: { name: mysql-secret, key: MYSQL_PASSWORD_BASE64 } }
          envFrom: [{ secretRef: { name: model-secret } }]   # 模型 apiKey 等
          ports: [{ containerPort: 8080 }]
```

> 注：k8s Secret 的 `data` 字段本身就要求 base64,经 `secretKeyRef` 注入到容器的环境变量值**仍是那串 base64**（k8s 不会替你解码业务自定义编码——它只对 Secret 存储层做 base64,注入 env 时给的是 data 里的原始字符串）。所以应用拿到的 `MYSQL_PASSWORD_BASE64` 是 base64,由 14.4 的代码解码。这正好满足"环境变量传 base64"的要求。

### 14.7 定时任务（数据库驱动，会话式创建）

定时任务**不是静态 k8s CronJob**，而是**用户用自然语言创建、存进 MySQL、由应用内调度器轮询触发**的动态任务。流程：

```
用户："每天1点执行巡检"
  └─▶ 助手解析 cron(0 1 * * *) → 调 schedule_task 工具 → 写入 scheduled_tasks 表
                                                              │
应用内 Scheduler（每分钟 tick）                                │
  └─▶ 查到期任务(FOR UPDATE SKIP LOCKED，多副本安全)            ◀─┘
      → runAgent(按 action 调用 skill / mcp / 工具，过 Policy)
      → 写 task_runs(结果/状态/耗时)
      → 按 cron 算 next_run_at，回写
```

#### 表结构

```sql
-- 任务定义（用户配置，存数据库）
CREATE TABLE scheduled_tasks (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(128),
  cron        VARCHAR(64),                       -- '0 1 * * *'
  action_type ENUM('skill','mcp','prompt'),      -- 调 skill / 调 MCP 工具 / 自由 prompt
  action_ref  VARCHAR(128),                      -- skill 名 / 'mcp:server:tool' / 空
  params      JSON,                              -- 入参、目标 cluster、prompt 文本等
  cluster     VARCHAR(64),
  enabled     TINYINT DEFAULT 1,
  pre_approved TINYINT DEFAULT 0,                -- 创建时是否已授权变更（见下）
  next_run_at BIGINT,                            -- epoch，下次触发
  created_by  VARCHAR(64), created_at BIGINT,
  INDEX idx_due (enabled, next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 每次执行的结果记录
CREATE TABLE task_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT, started_at BIGINT, finished_at BIGINT,
  status ENUM('running','success','failed','skipped'),
  result LONGTEXT, error LONGTEXT,
  INDEX idx_task (task_id), INDEX idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### 会话式创建（助手工具）

助手把"每天1点"这类自然语言**自己转成 cron**，再调工具落库。提供 `schedule_task` / `list_scheduled_tasks` / `update_scheduled_task` / `delete_scheduled_task` 一组工具：

```ts
// tools/schedule.ts
import parser from 'cron-parser';

export function scheduleTaskTool(store): ToolHandler {
  return {
    def: {
      name: 'schedule_task',
      description: '创建定时任务。把用户的自然语言时间转成标准 cron 表达式后调用。',
      inputSchema: { type:'object', required:['name','cron','actionType'], properties:{
        name:{type:'string'}, cron:{type:'string'},
        actionType:{enum:['skill','mcp','prompt']},
        actionRef:{type:'string'}, params:{type:'object'}, cluster:{type:'string'},
      }},
    },
    async run({ name, cron, actionType, actionRef, params, cluster }, ctx) {
      const next = parser.parseExpression(cron).next().getTime();   // 校验 + 算下次
      await store.createTask({ name, cron, actionType, actionRef, params, cluster,
        createdBy: ctx.user, nextRunAt: next, enabled: 1 });
      return { content: `已创建定时任务「${name}」，cron=${cron}，下次 ${new Date(next).toISOString()}` };
    },
  };
}
```

#### 调度器（多副本安全，无额外组件）

调度器是应用内的一个定时 tick。**多副本下用 `FOR UPDATE SKIP LOCKED` 原子领取到期任务**，保证每个任务只被一个副本执行——无需 Redis、无需 leader 选举。

```ts
// scheduler/ticker.ts
import parser from 'cron-parser';

async function tick(db, deps) {
  const now = Date.now();
  // 1) 事务内领取并立即推进 next_run_at（领到的任务别的副本看不到）
  const due = await db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom('scheduled_tasks').selectAll()
      .where('enabled','=',1).where('next_run_at','<=',now)
      .forUpdate().skipLocked().execute();           // ← MySQL 8.0 SKIP LOCKED
    for (const t of rows) {
      const next = parser.parseExpression(t.cron).next().getTime();
      await trx.updateTable('scheduled_tasks').set({ next_run_at: next })
        .where('id','=',t.id).execute();
    }
    return rows;
  });
  // 2) 锁外逐个执行并记录
  for (const t of due) await runTask(t, deps);
}

async function runTask(t, { store, runAgent }) {
  const runId = await store.startRun(t.id);          // task_runs: running
  try {
    const result = await runAgent({                  // 复用同一套 agent + Policy
      task: buildTaskPrompt(t),                      // 让 agent 去 load skill / 调 mcp / 执行 prompt
      meta: { scheduled: true, preApproved: !!t.pre_approved },
    });
    await store.finishRun(runId, 'success', result);
  } catch (e) {
    await store.finishRun(runId, 'failed', null, String(e));
  }
}

setInterval(() => tick(db, deps).catch(log.error), 60_000);  // 每分钟
```

`buildTaskPrompt` 按 `action_type` 生成给 agent 的指令：`skill` → 让它 `load_skill` 并执行；`mcp` → 直接 dispatch 对应 MCP 工具；`prompt` → 直接把 `params.prompt` 交给 agent。

#### 无人值守 × 审批门的处理

定时任务在**无人在场**时运行，审批门无法实时等人确认。规则：

- **只读/安全动作**（巡检、查询）→ 直接执行。
- **变更类动作**（`prod-*` 上的 mutating）→ 由 `pre_approved` 决定：
  - 用户**创建任务时**若已确认授权（助手会就高危定时变更要求确认），置 `pre_approved=1`，运行时 Policy 放行；
  - 否则运行时 Policy 拦截，该次 run 记为 `skipped` 并告警，等待人工处理。
- 无论哪种，**dry-run 与全量审计照旧**，结果连同 diff 落 `task_runs`。

> 部署上调度器跟随主应用进程即可（多副本由 SKIP LOCKED 兜底）；若想隔离，也可单起一个 `replicas:1` 的 scheduler Deployment 专跑 tick。两种都不引入新组件。

### 14.8 备份与运维

- **备份**：由外部 MySQL 自身负责——`mysqldump` / binlog 增量 / 主从复制 / 托管实例快照。
- **凭据**：MySQL 密码、模型 apiKey 一律走 **Secret**；绝不进 ConfigMap / CRD / 库表 / 镜像。
- **多副本**：应用无状态,`replicas` 随意调；并发写由 MySQL 处理。
- **连接健壮性**：连接池(`mysql2` pool) + 启动期重试 + 健康探针,容忍 MySQL 短暂抖动。

---

## 15. 用户、租户与认证（多租户 RBAC + SSO）

在现有系统上叠加**多租户隔离 + 三级角色 + 可插拔认证（本地 → SSO）**。核心是给所有数据和操作打上 `(tenant, user, role)` 标签，并在 API 入口和 Policy 处统一鉴权。

### 15.1 概念模型

- **租户 Tenant**：顶层隔离边界。会话、集群访问、定时任务、审计都归属某租户，互不可见。
- **用户 User**：归属某租户（平台管理员除外，属全局）。
- **角色 Role**：
  - **平台管理员 Platform Admin**：全局，管理租户/全局配置/所有集群，可跨租户。
  - **租户管理员 Tenant Admin**：管理本租户用户、本租户集群访问、审批变更。
  - **普通用户 User**：在本租户内使用助手，受集群 ACL 与 Policy 约束。
- **会话隔离**：每个会话带 `tenant_id + user_id`；普通用户只见本人会话，租户管理员见本租户，平台管理员见全部。

### 15.2 角色权限矩阵

| 能力 | 平台管理员 | 租户管理员 | 普通用户 |
|---|:--:|:--:|:--:|
| 管理租户（增删/配额） | ✅ | ❌ | ❌ |
| 全局配置 / 模型服务 | ✅ | ❌ | ❌ |
| 管理用户 | ✅ 全部 | ✅ 本租户 | ❌ |
| 配置集群访问（授权给本租户） | ✅ | ✅ 本租户 | ❌ |
| 跨租户访问 | ✅ | ❌ | ❌ |
| 使用助手 / 发起会话 | ✅ | ✅ | ✅ |
| 查看会话与审计 | 全部 | 本租户 | 仅本人 |
| 审批生产变更（Policy 审批门） | ✅ | ✅ | ❌ |
| 创建定时任务 | ✅ | ✅ | ✅ 本人、受限 |
| 授权定时变更（`pre_approved`） | ✅ | ✅ | ❌ |
| 执行只读运维 | ✅ | ✅ | ✅ 按集群 ACL |
| 执行变更运维 | ✅ | ✅ | 需审批 |

### 15.3 数据隔离

- 所有业务表加 **`tenant_id`**（会话/消息/审计/`scheduled_tasks`/`task_runs`），并按需加属主 `user_id`。
- **每次查询强制带 `tenant_id` 过滤**——封装在数据访问层（Store 方法签名带 `ctx`），杜绝漏过滤。
- 集群注册表改为**租户级授权**：集群属平台，由平台/租户管理员授权给租户（`tenant_clusters` 映射 + 角色 ACL）。
- 行级隔离由应用强制（带 `tenant_id` 的 WHERE）；高敏场景可再叠 MySQL 视图/账号隔离。

### 15.4 认证与授权（可插拔，为 SSO 预留）

**认证抽象**——一开始本地，后续无缝换 SSO：

```ts
export interface Identity { userId: string; tenantId: string; role: Role; email?: string; }

export interface AuthProvider {
  // 从请求解析身份（本地：校验密码/会话 token；SSO：校验 OIDC token / 回调）
  authenticate(req: Request): Promise<Identity | null>;
}
// LocalAuthProvider（用户名+argon2 密码 → 签发会话 JWT）
// OidcAuthProvider（Authorization Code + PKCE，校验 IdP token）
```

- **统一上下文**：认证中间件解析出 `Identity` → 注入 `RequestContext{ tenant, user, role }` → 贯穿 Store 查询与工具 dispatch。
- **授权两层**：① API 层 RBAC 中间件（按角色放行端点/操作）；② 复用并扩展 §9.5 的 **Policy 中间件**——审批权限 = 租户/平台管理员，集群 ACL 按 `tenant_clusters`，普通用户变更仍需审批。
- **SSO 对接**：`OidcAuthProvider` 走 OIDC（OAuth2 Authorization Code + PKCE），把 IdP 的 claims/groups **映射成 tenant + role**（映射规则配置化），首次登录 **JIT 建号**；可选 SCIM 同步用户/组。本地与 SSO 由配置切换，业务代码不感知。

### 15.5 分阶段实施计划

按"先隔离、再权限、后单点登录"推进，每阶段可独立上线。

| 阶段 | 目标 | 范围 / 交付物 | 前置 |
|---|---|---|---|
| **P1 多租户 + 会话隔离 + 本地认证** | 数据按租户/用户隔离，能登录 | `tenants`/`users` 表 + 各表加 `tenant_id`；`AuthProvider` 接口 + `LocalAuthProvider`（argon2 + 会话 JWT）；`RequestContext` 贯穿；Store 全部按 `tenant_id` 过滤 | 现有 MySQL 持久化 |
| **P2 RBAC 三角色 + 授权融合** | 三级角色、按角色管控 | 角色与权限矩阵落地；API RBAC 中间件；扩展 Policy（审批权=管理员、集群 ACL=`tenant_clusters`）；租户管理员的用户管理、平台管理员的租户管理；定时任务按角色限授权 | P1 |
| **P3 SSO 对接外部用户系统** | 对接企业 IdP 单点登录 | `OidcAuthProvider`（OIDC + PKCE）；claims→tenant/role 映射配置；JIT 建号；本地/SSO 配置切换；登出/令牌刷新 | P2 |
| **P4（可选）增强** | 规模化与合规 | SCIM 用户/组同步；细粒度权限（资源级 ACL）；审计增强（登录、权限变更）；多 IdP / SAML | P3 |

> 关键前置设计（P1 就要做对，避免返工）：**身份上下文 `ctx` 从一开始就贯穿所有 Store 查询与工具 dispatch**，认证做成 `AuthProvider` 接口。这样 P3 接 SSO 只是新增一个 provider + 映射配置，不动业务代码。

---

## 16. 依赖与功能汇总

### 16.1 关键依赖

| 依赖包 | 用途 | 章节 |
|---|---|---|
| `@anthropic-ai/sdk` | Anthropic 协议模型调用（`/v1/messages`），自定义 baseURL/apiKey | §4 |
| `openai` | OpenAI 协议模型调用（`/v1/chat/completions`），自定义 baseURL/apiKey | §4 |
| `@modelcontextprotocol/sdk` | MCP client（stdio / SSE / Streamable HTTP） | §7 |
| `e2b` / `@e2b/code-interpreter` | E2B 代码沙箱：新建 / 连接远端 / 动态拉起、执行代码与命令 | §8, §9 |
| `@e2b/desktop` | 沙箱内浏览器桌面（noVNC 流 + computer-use 操作） | §8.2 |
| `playwright`（可选） | 浏览器自动化的 CDP 方式（比 computer-use 更稳更快） | §8.2 |
| `mysql2` | MySQL 驱动 / 连接池 | §14.5 |
| `kysely` | 类型安全 SQL query builder（MySQL dialect），含 `FOR UPDATE SKIP LOCKED` | §14.5 |
| `cron-parser` | 解析 cron 表达式、计算下次触发时间（定时任务） | §14.7 |
| `argon2`（或 `bcrypt`） | 本地认证密码哈希 | §15.4 |
| `jose`（或 `jsonwebtoken`） | 会话 JWT 签发/校验、OIDC token 校验 | §15.4 |
| `openid-client`（P3） | SSO：OIDC（OAuth2 Authorization Code + PKCE）对接外部 IdP | §15.4 |
| `zod` | 配置与工具入参校验 | §10 |
| `fastify`（或 `express`） | HTTP 服务 + SSE 把 agent 事件流式推前端 | §3 |
| `pino` | 结构化日志 + 独立审计 sink | §11 |

> 调度无独立组件：应用内 tick 轮询 MySQL + `SKIP LOCKED`（§14.7），仅多一个 `cron-parser` 库。模型层若想换成统一框架，可用 **Vercel AI SDK**（`ai` + `@ai-sdk/anthropic`/`@ai-sdk/openai`）替代上面前两项，一套接口适配双协议。

### 16.2 功能汇总

| 功能 | 说明 | 关键实现 | 章节 |
|---|---|---|---|
| 自定义模型服务 | 支持 baseURL/apiKey，兼容 Anthropic + OpenAI 双协议（官方/中转/本地） | 内部中立格式 + 两个 adapter，config 驱动工厂 | §4 |
| Agent 核心循环 | agentic loop：模型 → 工具调用 → 回填 → 直到无调用 | `runAgent` + `ToolRegistry` 统一 dispatch | §5 |
| Skill | Claude Code 风格渐进式技能，按需加载省 token | `SkillRegistry` + `load_skill` 工具 | §6 |
| MCP 集成 | 接入外部 MCP server，工具命名空间化路由 | `McpManager`（多 transport） | §7 |
| 沙箱执行 | 隔离跑代码/命令；新建、连接远端、动态拉起 | `Sandbox.create/connect`，`SandboxManager` | §8, §9 |
| 浏览器桌面 | 远端沙箱内完整桌面，前端嵌 noVNC 流；computer-use / CDP 操作 | `@e2b/desktop` + 工具封装 | §8.2 |
| 多集群 kubectl 运维 | 统一 `kubectl(cluster,args)`，按集群路由到 in-cluster 沙箱 | 集群注册表 + 动态拉起 + in-cluster SA | §9 |
| 沙箱生命周期管理 | (session×cluster) 懒加载、复用、idle TTL 回收 | `SandboxManager.ensure/gc` | §9.3 |
| 安全护栏（Policy） | 读写分离、dry-run 预演、生产审批门、危险命令拦截、全量审计 | dispatch 前 `PolicyMiddleware` + SA RBAC 双层 | §9.5, §11 |
| 持久化 | 外部 MySQL 存消息/审计/任务状态；应用无状态多副本 | `mysql2` + `kysely`，连接走环境变量 | §14 |
| 配置管理 | 模型/MCP/集群走 config，MySQL 连接走环境变量（密码 base64） | `zod` 校验 + 环境变量注入 | §10, §14.4 |
| 定时任务 | 用户会话式创建（自然语言→cron）、存 DB；调度器轮询触发、调 skill/mcp、记录结果 | `scheduled_tasks`/`task_runs` 表 + tick(`SKIP LOCKED` 多副本安全) + `cron-parser` | §14.7 |
| 审计 | 模型调用、工具执行、沙箱生命周期、policy 拦截/审批全记录 | 独立审计 sink（`pino`）+ MySQL `audit` 表 | §11, §14 |
| 多租户 + 会话隔离 | 数据按 `(tenant,user)` 隔离，会话互不可见 | 各表 `tenant_id` + Store 强制过滤 + `RequestContext` | §15.1, §15.3 |
| 角色权限（RBAC） | 平台管理员 / 租户管理员 / 普通用户三级 | 权限矩阵 + API RBAC 中间件 + Policy 融合 | §15.2, §15.4 |
| 认证 / SSO | 本地认证起步，可插拔切 OIDC 单点登录对接外部 IdP | `AuthProvider` 接口（Local / Oidc）+ claims→tenant/role 映射 | §15.4, §15.5 |

---

## 附：关键设计决策回顾

| 决策 | 理由 |
|---|---|
| 内部中立格式 + adapter | 一套 agent loop 适配任意协议/provider，自定义 baseURL/apiKey |
| 一切归一为"工具" | Skill/MCP/Sandbox/kubectl 统一 dispatch，agent loop 极简 |
| sandbox 动态拉起为 in-cluster Pod | 同时解决可达性、隔离、凭据三件事；凭据不出集群 |
| (session×cluster) 懒加载 + 复用 | 避免冷启动逐条命令拉起；idle GC 收敛爆炸半径 |
| 双层安全（Policy + SA RBAC） | 业务策略与硬权限边界分离，纵深防御 |
| 每集群一个 sandbox + in-cluster config | 物理上不会打错集群，比共享多 context kubeconfig 更安全 |
| 只用外部 MySQL，应用无状态 | 无 PVC、可多副本 HA；持久数据全在外部库，备份/复制交给 MySQL |
| MySQL 连接走环境变量、密码 base64 | 不同环境灵活切换；密码 base64 经 Secret 注入、应用解码（base64 是编码非加密，机密性靠 Secret + RBAC） |
| 定时任务存 DB + 应用内调度器 | 用户会话式创建（自然语言→cron），动态增删；调度器 tick 用 `SKIP LOCKED` 保证多副本只执行一次，无需 Redis/leader 选举 |
| 无人值守用 pre_approved 解审批 | 定时变更在创建时确认授权，运行时 Policy 据此放行；未授权的变更记 `skipped` 并告警 |
| 身份上下文 `ctx` 从 P1 就贯穿全链路 | Store 查询/工具 dispatch 都带 `(tenant,user,role)`；认证做成 `AuthProvider` 接口，P3 接 SSO 只加 provider 不动业务 |
| RBAC 与 Policy 融合而非另起一套 | 角色决定审批权与集群 ACL，复用 §9.5 Policy 中间件，鉴权逻辑单点收口 |
```
