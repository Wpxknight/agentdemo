# 实现计划：aios-request 技能可执行化 + Claude Code 机制借鉴

> 配套背景：`skills/aios-request` 已随镜像部署、`load_skill` 可加载，但智能体**无法实际执行**该技能。
> 本文档分两个计划：**计划一**修通技能执行链路（本次交付）；**计划二**借鉴 claude-code 源码快照
> （`/home/opt/develop/aicoding/claude-code`，真实 TS 实现）补齐平台机制（分批交付）。
> 硬约束：**环境信息（平台地址、client id 等）与认证密钥一律不写死进脚本/镜像**，
> 环境信息走环境变量/服务端配置注入，凭据只在运行时由用户在对话中提供。

## 诊断结论（2026-07-07）

| # | 问题 | 证据 |
|---|---|---|
| 1 | 智能体读不到技能子模块文档：`load_skill` 只返回顶层 SKILL.md 正文，而 aios-request 顶层只是模块索引，`aios-base`/`aios-report` 等子 SKILL.md 无任何 agent 工具可读（`listDir`/`readFile` 只暴露给控制台 HTTP API） | `src/skill/registry.ts:161`、`src/server/http.ts` |
| 2 | 技能脚本不可执行：脚本在 server 容器 `/app/skills/`，而 agent 唯一执行工具 `sbx__run_code`/`sbx__run_command` 跑在 OpenSandbox 沙箱里，`load_skill` 返回的"附带文件（在 /app/skills/...）"是死路径 | `src/tools/builtin.ts:51,76` |
| 3 | 环境信息写死且指向错误环境：`config.py` 硬编码 blockelite 的 `BASE_URL`/`CLIENT_ID`，与目标平台（如 10.10.72.20:30001）不符 | `skills/aios-request/aios-base/scripts/config.py:8-13` |
| 4 | 技能摘要注入无预算控制：技能增多后 `summaries()` 会无限撑大 system prompt | `src/skill/registry.ts:115` |
| 5 | 附带 bug：审计里 `inputTokens` 恒为 0 | `audit_events` 表实测 |

约束补充：`aios-request` 目录 48MB，其中 `aios-guide/guide-knowledge` 占 47MB——同步进沙箱必须有大小过滤与按需机制。

---

# 计划一：aios-request 技能可执行化

## A1 服务端：技能工具扩展（`src/skill/registry.ts`、`src/runtime.ts`）

### A1.1 `skill__read_file` 工具

- inputSchema：`{ name: string, path: string }`。
- 行为：`path` 是文件 → 返回内容；是目录 → 返回该层 `listDir` 清单（name/isDirectory/size）。
- 复用已有 `registry.readFile()/listDir()`，路径安全校验沿用 `normalizeSkillPath`/`safeResolve`。
- 大小守护：>256KB 的文件截断返回并注明（防止把 guide-knowledge 类大文件灌进上下文）。
- 工具归类无需改：`http.ts:1125` 已把 `skill__` 前缀归为 `skill` 类。

### A1.2 `skill__sync_to_sandbox` 工具

- inputSchema：`{ name: string, paths?: string[] }`；`paths` 缺省 = 整个技能目录。
- 行为：把技能文件从 server 容器推进**当前会话沙箱**的 `/workspace/skills/<name>/`。
- 实现（SandboxHandle 只有 runCode/runCommand，无文件 API）：
  1. 服务端用 `tar -C <skillDir> -czf - <paths...>` 打包（child_process，stdout 进内存）；
  2. base64 后按 **64KB/片** 分片（避开 shell 单命令长度限制），逐片
     `runCommand("printf '%s' '<chunk>' >> /tmp/skill-<name>.b64")`；
  3. 末片后 `base64 -d ... | tar -xzf - -C /workspace/skills/<name>` 并清理临时文件。
- 过滤规则：默认**跳过单文件 >2MB** 的内容；返回值列出 synced/skipped 两组清单，
  模型需要大文件时用 `paths` 显式指定（仍受单次同步总量 ≤16MB 上限约束，超限报错让模型缩小范围）。
- 幂等：同步前 `rm -rf /workspace/skills/<name>` 目标子路径，重复调用安全。
- 接线：新增 `buildSkillTools(registry, manager, resolve)`（放 `src/tools/skill.ts`），
  在 `runtime.ts:210-216` 处替换现有 `tools.register(skills.tool())`，
  沙箱解析复用 `builtin.ts` 的 `defaultResolver`（每会话一个沙箱）。

### A1.3 `load_skill` 返回值修正

- 删除现有"附带文件（在 `<skill.dir>`）"死路径提示（`registry.ts:155-160`）。
- 改为追加固定使用引导：
  - 子文档/脚本源码用 `skill__read_file` 按需读取；
  - 要执行脚本先 `skill__sync_to_sandbox`，然后在沙箱内以 `/workspace/skills/<name>/` 为根执行；
  - 提示环境变量与凭据约定（见 A2）。

### A1.4 `summaries()` 注入预算（借鉴 claude-code `SkillTool/prompt.ts`）

- 每条 description 截断到 **250 字符**；总预算默认 **4000 字符**（`skills.summaryBudget` 可配），
  超预算的技能只保留 name 行并追加一行"其余技能用 load_skill 按名加载"。

## A2 环境信息 / 凭据外部化

### A2.1 `aios-base/scripts/config.py` 去硬编码

| 常量 | 改为 | 缺失时行为 |
|---|---|---|
| `BASE_URL` | `os.environ["AIOS_BASE_URL"]` | 抛错："缺少 AIOS_BASE_URL。请向用户确认平台 API 地址，然后在执行命令前 export" |
| `LOGIN_URL` | `os.environ["AIOS_LOGIN_URL"]`（缺省回退 `AIOS_BASE_URL` 的 origin） | 同上 |
| `CLIENT_ID` | `os.environ["AIOS_CLIENT_ID"]` | 同上 |
| `SYSTEM_ID` | `os.environ.get("AIOS_SYSTEM_ID", "1")` | 有默认 |
| `CLUSTER_NAME` | `os.environ.get("AIOS_CLUSTER_NAME", "")`，用到的脚本自行校验 | 用到时报错 |

- 现有 blockelite 地址与 client id **全部删除**（如需示例，写进 SKILL.md 文档而非代码）。
- `TOKEN_FILE`/`CONTEXT_FILE` 不变：token 只落在沙箱临时文件系统，沙箱销毁即消失。

### A2.2 凭据流（保持"对话内提供"，禁止落库/落镜像）

- `setup_auth.py` 增加 `AIOS_USERNAME`/`AIOS_PASSWORD` 环境变量读取（优先于 `--username/--password`），
  推荐用法改为 `export AIOS_PASSWORD='...' && python setup_auth.py`，避免密码出现在进程列表。
- SKILL.md 明确：凭据只允许来自用户当轮对话；禁止模型把密码写入任何持久文件或回显到汇报里。

### A2.3 服务端稳定环境注入（可选层，待确认 ①）

- `src/config/schema.ts:130`：`skills: z.object({ dir, summaryBudget?, sandboxEnv? })`，
  `sandboxEnv: z.record(z.string()).optional()`。
- 会话沙箱创建时并入 `SandboxSpec.envs`（`builtin.ts` defaultResolver 处），
  OpenSandbox provider 已支持透传（`opensandbox.ts:147`）。
- 用途：管理员把 `AIOS_BASE_URL` 等**环境信息**配置在 `config.jsonc`；
  聊天里用户临时给的地址由模型 `export` 覆盖。**凭据禁止走此通道**（schema 校验 key 名，
  拒绝 `*PASSWORD*`/`*TOKEN*`/`*SECRET*`）。

## A3 SKILL.md 执行流程改写（`skills/aios-request/SKILL.md`）

新增"执行流程"一节（放模块索引之前），六步：

1. `load_skill("aios-request")`；
2. `skill__sync_to_sandbox("aios-request")`（首次；结果里注意 skipped 清单）；
3. 按任务选模块，`skill__read_file` 读对应子 SKILL.md（依赖 `aios-base` 的模块先读它）；
4. 检查沙箱内 `AIOS_BASE_URL`/`AIOS_CLIENT_ID` 等是否就绪，缺失就向用户询问后 export；
5. 凭据：向用户索取账号密码（若对话里已给出则直接用），`setup_auth.py` 完成登录；
6. 在沙箱 `/workspace/skills/aios-request/<module>/scripts/` 下执行业务脚本。

同时：模块索引里的相对链接补充说明"用 skill__read_file 读取"；"使用前准备"一节改为环境变量约定表。

## A4 测试、部署与端到端验证

- 单测（`tests/skill.test.ts` 扩展）：
  - `skill__read_file`：正常读、目录清单、`../` 越权拒绝、大文件截断；
  - `skill__sync_to_sandbox`：mock SandboxHandle 断言分片命令序列与解包命令、>2MB 跳过、总量超限报错；
  - `summaries()`：250 字符截断与总预算裁剪。
- 附带修复：排查 `inputTokens` 恒 0（`runAgent` usage 聚合 → audit 落库链路），补断言。
- 交付流程：`npm test` + `npm run build` → `docker build -t aiop:dev .` → rollout（`deploy/dev-k8s/README.md`）。
- 端到端验收：**新会话**发原始任务
  "用aios-request技能 统计下 http://10.10.72.20:30001/ 平台任务资源占用情况（用户名/密码对话内提供）"，
  验证轨迹完整：load_skill → sync → read_file(aios-base, aios-report) → 询问/使用凭据 →
  沙箱内登录成功 → 调用报表接口 → 输出统计结果。轨迹与结果截图/记录归档到本文档附录。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 沙箱 shell 单命令长度限制导致分片写入失败 | 64KB/片保守值；失败时指数回退减半重试一次 |
| 沙箱缺 `base64`/`tar` | sync 首步探测（`command -v`），缺失则报错并提示模型改用 skill__read_file + 手写文件 |
| 密码泄漏进日志/审计 | sync/exec 工具结果不回显 env；SKILL.md 明令禁止回显；审计 detail 里对 `password=`/`AIOS_PASSWORD` 做掩码 |
| 47MB guide-knowledge 误同步 | 默认 2MB 单文件过滤 + 16MB 总量上限双保险 |

---

# 计划二：借鉴 claude-code（分批）

> 主参考 `/home/opt/develop/aicoding/claude-code`（完整 TS 实现）；
> `/home/opt/develop/aicoding/claw-code`（Rust 简化重写）仅作对照。

## P0（安全与注入质量）

| # | 项 | 参考 | aiop 落点 | 要点 |
|---|---|---|---|---|
| P0-1 | 工具权限规则引擎 | `src/utils/permissions/{permissions,PermissionRule,permissionRuleParser}.ts` | `src/ops/policy` 与 `agent/tools.ts` dispatch 前 | allow/deny/ask 三级规则，模式如 `kubectl(delete:*)`、`mcp__<server>`；deny 的工具在发给模型前整体剥离（`filterToolsByDenyRules` 做法）；ask 融合现有 InteractiveApprovalGate。**含 kubectl 只读自动分类**（借鉴 `BashTool/readOnlyValidation.ts` 思想）：get/describe/logs/top/events 等自动放行，变更类才进审批，避免审批疲劳 |
| P0-2 | PreToolUse hooks | `src/utils/hooks/{execHttpHook,ssrfGuard}.ts` | 新增 `src/agent/hooks.ts`，dispatch 前调用 | shell 与 HTTP webhook 两种执行器；hook 返回 deny 即拦截并把原因回给模型；webhook 带 SSRF 防护与超时；配置进 `config.jsonc` |
| P0-3 | 技能摘要预算 | `src/tools/SkillTool/prompt.ts`（1% 上下文预算、250 字符描述） | 已并入计划一 A1.4 | — |

## P1（能力补齐）

| # | 项 | 参考 | aiop 落点 | 要点 |
|---|---|---|---|---|
| P1-1 | TodoWrite 工具 | `src/tools/TodoWriteTool/`（含 prompt.ts 的使用规范） | 新工具 + SSE `todo_updated` 事件 + 前端 TaskProgress 对接 | pending/in_progress/completed 三态；持久化到会话 |
| P1-2 | WebFetch 工具 | `src/tools/WebFetchTool/{preapproved,utils}.ts` | 新增 `src/tools/webfetch.ts` | 域名预批准清单（config 配置）+ SSRF 防护 + HTML→文本归一 |
| P1-3 | 用量/成本 | `src/cost-tracker.ts`、`costHook.ts` | `runAgent` usage 聚合 + audit 表加列 + 控制台展示 | cache-read/cache-creation 分开记；按模型定价表折算；顺带含 inputTokens=0 修复（计划一先修统计，本项做展示） |
| P1-4 | `ask_user` 询问工具 | `src/tools/AskUserQuestionTool/{AskUserQuestionTool.tsx,prompt.ts}` | 新工具 + SSE `question_required` 事件 + 前端选项卡片（复用 approval_required 的等待/恢复机制） | 1-4 题、每题 2-4 选项 + 自动"其他"自由输入、multiSelect、选项 preview；直接服务计划一第 4/5 步（环境变量/凭据询问）：模型中途提问不结束本轮运行 |
| P1-5 | 变更计划模式 | `src/tools/{EnterPlanModeTool,ExitPlanModeTool}/` | 新增 plan 模式状态 + `submit_change_plan` 工具 + SSE 计划审批事件 | 生产变更先产出结构化方案（变更项/影响面/回滚方式），用户批准后才解锁执行类工具；与 P0-1 分工：规则拦单点危险操作，计划模式管成套变更 |

## P2（架构演进，视效果启动）

- **子智能体**：参考 `src/tools/AgentTool/runAgent.ts` 的可复用 runner + 受限工具集；aiop 的 `runAgent` 抽出复用入口，先支持只读 Explore 型子 agent。
- **microCompact 增量压缩**：参考 `src/services/compact/{autoCompact,microCompact}.ts`；aiop 已有整体摘要压缩，补增量路径降低长会话停顿。
- **ToolSearch 延迟披露**：MCP 工具规模增长后再做（参考 `src/tools/ToolSearchTool/`）。
- **技能分叉执行**：技能在独立子 agent 中运行（依赖子智能体落地），隔离 token 预算。
- **沙箱后台任务**：`sbx__run_command` 加 `run_in_background` 参数 + `sbx__task_output`/`sbx__task_stop`
  （参考 BashTool 后台执行 + TaskOutput/TaskStop）；解决 `rollout status`、tail 日志等长命令
  阻塞 agent 循环的问题；涉及沙箱句柄生命周期管理。
- **定时任务失败主动通知**：复用 P0-2 的 HTTP webhook 执行器，scheduler 增加 `onTaskFailed`
  事件外推（企微/钉钉/通用 webhook）；实现成本低，解决"巡检挂了无人知晓"。

## 明确不借鉴 / 暂缓

- Linux namespace 沙箱（aiop 已有 OpenSandbox，更强）；
- CLAUDE.md 指令文件层级加载、Ink TUI、IDE bridge（平台形态不同）；
- JSONL 会话存储（aiop 用 MySQL，更适合多租户）；
- WebSearch（集群内多无公网出口，WebFetch + 预批准域名已够用）；
- auto-memory / 记忆抽取（`memdir/`、`services/extractMemories/`）：对运维场景有价值
  （记住集群特性），但记忆污染与跨租户泄漏的防护设计成本高，M1-M3 消化后再立项。

---

# 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 计划一 A1-A4 | 端到端任务（统计平台任务资源占用）在新会话跑通 |
| M2 | P0-1 + P0-2 | 规则拦截/审批/hook 拒绝三条路径各有集成测试；生产 ns 危险操作可被规则拦截 |
| M3 | P1-1..5 | 长任务 todo 可视化；WebFetch 可用且域名受控；控制台展示会话成本；ask_user 中途提问不断轮；生产变更须经方案审批 |
| M4（可选） | P2 项 | 单独立项评估 |

# 待确认

1. **①** A2.3 `skills.sandboxEnv` 服务端注入层：做 / 不做（不做则环境信息完全靠对话提供）。
   —— 已实现（含凭据类键 schema 拒绝），2026-07-08。
2. **②** 本次交付范围：M1，还是 M1+M2，还是 M1+M2+M3。—— 先交付 M1（本次），后续按 P0→P1 分批。

---

# 附录：M1 端到端验证记录（2026-07-08）

代码 `f0d2c70`，281 测试全过，部署 `aiop-dev`。验证会话 `9900000000000002`，
任务原话："用aios-request技能 统计下 http://10.10.72.20:30001/ 平台任务资源占用情况…（凭据对话内提供）"。

**轨迹（13 步，与设计的六步流程一致）：**

1. `load_skill("aios-request")` ✓
2. `skill__read_file` 读 `aios-base/SKILL.md`、`aios-report/SKILL.md` ✓
3. `skill__sync_to_sandbox`（全量）→ 触发 16MB 总量上限报错（guide-knowledge 47MB 为大量
   ≤2MB 小文件，绕过单文件过滤）→ 模型按报错指引改用
   `paths: ["aios-base","aios-report"]` 重试成功（47 文件 / 174KB）——双保险按设计工作 ✓
4. 沙箱内 `env | grep AIOS_` 检查环境变量 ✓
5. 探测平台：会话沙箱与 netdiag 沙箱双路探测 `30001` 均超时（该地址从宿主机也不可达，
   属环境网络问题，非 aiop 缺陷）；模型未回显密码、未执行修改操作，正确汇报阻塞并列出
   所需信息（网络可达性 + `AIOS_CLIENT_ID`）✓
6. usage 统计修复生效：`inputTokens=125335, outputTokens=2129`（此前恒 0）✓

**遗留（环境侧，非代码问题）：**

- `10.10.72.20:30001` 需从沙箱可达（当前整机不可达，需网络打通或改地址）；
- `AIOS_CLIENT_ID` 需用户提供（建议配入 `skills.sandboxEnv`）；
- 沙箱镜像缺 `requests`/`cryptography`，建议预装进 opensandbox 模板镜像（需单独确认）。
