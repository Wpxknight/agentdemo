# AIOS Sandbox 动态集群调度设计

> 文档版本：1.1  
> 更新日期：2026-08-13  
> 状态：需求已确认，待实现

## 1. 背景与目标

当前 AIoP 在平台 Sandbox 设置中固定配置 `placement.clusterId` 和 `placement.namespace`，AIOS Lifecycle provider 创建的沙箱都使用同一调度位置。该方式无法满足用户在聊天中指定目标集群的场景，例如：

> 帮我查看 pc1 集群的资源使用情况

目标行为：模型从对话中识别目标集群，在沙箱工具调用中显式传入 `clusterName` 或 `clusterId`，AIoP 规范化后透传给 `aios-sandbox`：

```json
{
  "placement": {
    "clusterName": "pc1",
    "namespace": "aios-system"
  }
}
```

同时兼容按集群 ID 调度：

```json
{
  "placement": {
    "clusterId": "35",
    "namespace": "aios-system"
  }
}
```

可验收目标：

1. 模型能通过结构化工具参数表达集群名称或 ID，不新增自然语言正则解析器。
2. 动态 placement 缺省 namespace 固定为 `aios-system`。
3. 同一会话访问不同 placement 时不复用同一沙箱。
4. 设置页删除 Cluster ID 和 Namespace，旧持久化配置升级不阻断启动。
5. AIoP 不扩大既有模板、角色和 AIOS Sandbox 控制面授权边界。

## 2. 现状与关键决策

当前实现的关键事实：

- `SandboxSpec` 尚无独立 placement；`namespace` 是 profile/Pod 属性，不能代替 AIOS Lifecycle placement。
- `sandboxSpecForProfile` 生成身份、会话和 profile 复用键，`SandboxManager` 仅按 `spec.key` 复用句柄。
- `AiosE2bProvider` 构造时要求固定 `placement.clusterId`，创建请求始终使用 provider 固定 placement。
- AIOS Lifecycle 设置 schema、HTTP API、数据库记录和 Web 表单都要求固定 placement。
- `/v1/sandbox/run-code` 和 `/v1/sandbox/run-command` 已存在，当前只透传 profile、代码或命令参数。

| 决策 | 选择 | 原因与影响 |
| --- | --- | --- |
| 集群语义提取 | 模型根据工具 schema 提取 | 不维护脆弱的自然语言规则；模型漏传时由运行时明确失败 |
| placement 所属层级 | 调用级 `SandboxSpec.placement` | 同一会话可访问多个集群；provider 不再把固定 placement 作为唯一来源 |
| 集群选择器 | `clusterName` 与 `clusterId` 严格二选一 | 避免同一请求包含两个可能不一致的目标 |
| namespace | 动态 placement 缺省为 `aios-system` | 满足本次业务约定；不继承 profile 的 Pod namespace |
| 复用隔离 | 规范化 placement 加入内部 `SandboxSpec.key` | 防止跨集群复用；与设置页 API Key 无关 |
| 兼容策略 | 旧 placement 只作为内部 fallback，GET 隐藏、再次保存时移除 | 支持滚动升级，同时完成无数据库迁移的惰性迁移 |
| 最终授权 | AIOS Sandbox 控制面校验目标；AIoP 不降级或换目标重试 | 动态参数是不可信输入；平台 API Key 的实际授权范围需上线前验证 |

## 3. 方案对比

### 方案 A：调用级 placement，旧配置 fallback（推荐）

工具调用携带 placement，运行时统一规范化、扩展缓存键，AIOS provider 优先使用动态值；旧设置仅在调用完全未提供 placement 时 fallback。

优点：改动局部、支持 name/ID、多集群隔离清晰、可渐进升级。  
缺点：所有会触发 AIOS 沙箱创建的入口最终都需要动态参数或 fallback；模型漏传会失败。

### 方案 B：会话级目标集群状态

先从对话设置会话的当前集群，之后所有沙箱工具隐式继承。

优点：后续工具参数较少，浏览器或导出等工具可继承。  
缺点：需要新增持久化/并发语义，用户在同一轮切换集群时容易使用陈旧状态，超出本次最小改动范围。

### 方案 C：继续使用全局固定 placement

由管理员在设置页修改固定目标。

优点：实现最简单。  
缺点：无法满足同一会话按用户意图访问不同集群，修改配置还会切换整个 runtime generation。

| 维度 | 方案 A | 方案 B | 方案 C |
| --- | --- | --- | --- |
| 实现复杂度 | 中 | 高 | 低 |
| 多集群正确性 | 高 | 中，依赖状态一致性 | 不满足 |
| 兼容成本 | 低 | 高 | 低 |
| 权限边界清晰度 | 高，逐调用显式 | 中，依赖会话状态 | 中 |
| 实施周期 | 约 5 人天 | 约 8 人天 | 不适用 |

推荐方案 A。方案 B 可在后续确有大量隐式 placement 工具需求时单独设计。

## 4. 运行时数据模型与规则

新增 provider-neutral placement：

```ts
interface SandboxPlacement {
  clusterId?: string;
  clusterName?: string;
  namespace: string;
}

interface SandboxSpec {
  // existing fields...
  placement?: SandboxPlacement;
}
```

统一规范化规则：

1. `clusterId`、`clusterName`、`namespace` 去除首尾空白，不改变大小写。
2. 动态参数中 `clusterId`、`clusterName` 必须且只能有一个非空值；两者同时存在或都为空时拒绝。
3. 调用完全未提供 placement 参数时，允许使用旧配置 fallback；仅提供 namespace 而没有集群选择器时拒绝，不与 fallback 混合拼装。
4. 动态 placement 的 namespace 为空或缺失时设为 `aios-system`；旧 fallback 保留其原 namespace，避免升级改变既有沙箱位置。
5. 规范化和校验在进入 `SandboxManager.get` 前完成，Provider 再执行防御性校验。
6. `SandboxSpec.namespace` 继续表示 profile/Pod 属性；`SandboxSpec.placement.namespace` 专用于 AIOS Lifecycle 调度，二者不得互相覆盖。

建议提供单一公共函数，避免工具、HTTP 和 provider 各自实现不同规则：

```ts
normalizeSandboxPlacement(input, fallback?)
  -> { placement, cacheSuffix, metadata } | PlacementError
```

错误至少区分：选择器冲突、缺少选择器、namespace-only、AIOS 模式缺少动态值和 fallback。错误文本不得包含 API Key。

## 5. 工具契约与模型行为

本次主要 profile 工具增加可选参数：

- `sandbox_ensure`
- `sandbox_run_code`
- `sandbox_run_command`

参数定义：

```json
{
  "clusterName": { "type": "string", "description": "目标 Kubernetes 集群名称；与 clusterId 二选一" },
  "clusterId": { "type": "string", "description": "目标 Kubernetes 集群 ID；与 clusterName 二选一" },
  "namespace": { "type": "string", "description": "目标 namespace，缺省 aios-system", "default": "aios-system" }
}
```

工具描述必须明确：

- 用户提到集群名称时传 `clusterName`，明确给出 ID 时传 `clusterId`。
- 不得根据名称自行猜测 ID，也不得同时传 name 和 ID。
- 用户未指定 namespace 时省略该参数，由运行时填充 `aios-system`。

现有 AIOS code/command 能力还会暴露兼容工具 `sbx__run_code`、`sbx__run_command`。为避免模型选中兼容工具后无法表达 placement，这两个入口应复用同一 placement 参数 schema 和规范化逻辑；或者在 AIOS 模式停止暴露它们，仅保留 profile 工具。推荐前者，兼容风险更低。

非 AIOS provider 接收到 placement 参数时不得静默改变本地/E2B/OpenSandbox 调度。工具层可忽略并保持现有行为，但仍应执行 name/ID 冲突校验，避免同一工具契约因 provider 不同而产生歧义。

## 6. 缓存、生命周期与审计

placement 必须在调用 `SandboxManager.get` 之前写入 spec 并扩展复用键。推荐使用结构化稳定编码，不直接用未经转义的冒号拼接字段：

```text
<existing-profile-key>:placement:<JSON.stringify([selectorType, selectorValue, namespace])>
```

示例：

```text
["tenant","user","session"]:profile:code-id:placement:["clusterName","pc1","aios-system"]
```

同一规范化函数同时生成 key suffix 和 metadata，防止两者不一致。metadata 使用独立字段：

```json
{
  "placementSelector": "clusterName",
  "placementCluster": "pc1",
  "placementNamespace": "aios-system"
}
```

因此：

- 同一身份、会话、profile 和 placement 复用同一沙箱。
- name 与 ID 即使最终指向同一集群，也视为不同 placement；AIoP 不具备可靠映射关系，不做合并。
- 同一会话切换集群或 namespace 会创建不同沙箱。
- 会话销毁继续依据 metadata 中的 `sessionId` 回收该会话下所有 placement 沙箱，不能依赖解析新 key。
- 已运行沙箱不迁移；只有新建沙箱应用动态 placement。

设置页 AIOS Sandbox API Key 仅用于 Lifecycle HTTP 鉴权，不参与复用键生成，也不得写入 metadata、日志或错误。

## 7. Provider、设置与兼容

AIOS provider 构造参数中的固定 placement 改为可选 fallback。创建顺序：

1. 使用已规范化的 `spec.placement`。
2. 若调用完全未提供 placement，使用旧设置或旧静态配置中的 fallback。
3. 两者都不存在时，在发起 Lifecycle HTTP 请求前失败，不静默选择集群。

Lifecycle `POST /sandboxes` 透传且只透传一种选择器：

```json
{ "placement": { "clusterName": "pc1", "namespace": "aios-system" } }
```

或：

```json
{ "placement": { "clusterId": "35", "namespace": "aios-system" } }
```

设置变更：

- AIOS Lifecycle 页面仅保留 Enabled、Lifecycle URL、API Key。
- 公共 GET 设置 API 不再返回 placement。
- PUT 接口在兼容窗口内允许旧客户端携带 `placement`，但忽略且不持久化；其他未知字段仍返回 400。
- 数据库旧记录读取时保留 placement 作为内部 deprecated fallback；不得投影到公共设置响应。
- 下一次保存写入无 placement 的新结构，实现惰性迁移；不新增数据库 migration。
- 静态 `sandbox.aios.placement` 改为可选 deprecated fallback。静态配置不会因页面保存而改变，应在后续破坏性配置版本中移除。

回滚到旧版本前，必须确认数据库 `sandbox.default` 仍含旧 placement；新版本保存后的记录已不含该字段，旧版本 schema 将无法启动 AIOS Lifecycle。发布前应备份该设置记录，回滚时恢复旧 placement。这是本次唯一需要显式处理的回滚兼容点。

## 8. HTTP API 与权限边界

`POST /v1/sandbox/run-code`、`POST /v1/sandbox/run-command` 明确增加：

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `cluster_name` | string | 否 | 与 `cluster_id` 二选一 |
| `cluster_id` | string | 否 | 与 `cluster_name` 二选一 |
| `namespace` | string | 否 | 动态 placement 缺省 `aios-system` |

HTTP 层完成类型和冲突校验后，转换为工具 camelCase 参数。两个接口继续执行现有 `requireAuth` 和 profile 授权；选择 clusterName/clusterId 不授予 `sandbox-diag` 权限。参数错误返回 400。

动态 placement 是不可信输入。安全边界如下：

- AIoP 只允许使用当前用户可见的 profile；`sandbox-diag` 继续仅 `platform_admin` 可见并在 acquire 时复核。
- AIoP 不把 clusterName/clusterId 当作授权凭据，不自行声称用户有目标集群权限。
- Lifecycle 请求当前使用平台配置的 AIOS Sandbox API Key。只有当该 Key/控制面能按预期限制允许的集群范围时，控制面拒绝才构成有效最终边界；metadata 中的 tenant/user/session 仅用于审计，除非控制面有明确可信校验，否则不能视为用户授权。
- AIOS 返回 401/403 或目标不存在时，AIoP 原样报告失败，不改用 fallback、不换 clusterName/clusterId、不使用更高权限模板重试。
- 若远端环境验证表明平台 Key 可创建任意集群且控制面没有用户级校验，本功能上线前必须由管理员收窄 Key 的集群范围，或另行设计 AIoP allowlist/用户授权查询；模型提示不能替代此控制。

## 9. 可观测性与非功能要求

- 创建成功日志包含 selector 类型、目标集群、namespace、profile、sessionId 和 sandboxId；不记录 API Key。
- 参数冲突、缺少 placement、AIOS 401/403、目标不存在分别可区分；禁止在 401/403 后自动降级。
- placement 仅增加短字符串和缓存条目维度，不改变单次创建请求复杂度。容量上，同一会话访问 N 个 placement 最多保留 N 个对应 profile 沙箱，仍受现有空闲回收和会话销毁控制。
- 并发请求使用相同规范化 key 时继续由现有 inflight 去重；不同 placement 不共享 inflight。
- 不新增开源组件、数据库表或部署单元。

## 10. 验收与测试要点

### 单元与契约测试

- trim、大小写保留、默认 namespace。
- clusterName、clusterId 两种 Lifecycle 请求体。
- name/id 同传、两者为空、namespace-only 均拒绝且不发 HTTP 请求。
- 动态 placement 优先于旧 fallback；无参数时使用 fallback；动态参数无 namespace 时不继承 fallback namespace。
- 同 placement key 相同，不同 selector/value/namespace key 不同；包含冒号、引号等字符时无碰撞。
- placement metadata 正确且不含 API Key。
- 非 AIOS provider 行为不变。

### 集成与 HTTP 测试

- “查看 pc1 集群资源”对应工具调用包含 `clusterName=pc1`。
- `/v1/sandbox/run-*` snake_case 到工具 camelCase 映射正确，冲突返回 400。
- 普通用户不能选择 `sandbox-diag`，动态 placement 不绕过 profile RBAC。
- AIOS 401/403 不 fallback、不重试其他目标，错误可识别。
- 同一会话 pc1、pc2 创建两个沙箱；重复 pc1 复用；会话销毁回收二者。
- 并发相同 placement 只创建一次，并发不同 placement 分别创建。

### 设置、升级与 UI 测试

- 新设置 schema 不要求 placement，GET 不返回 placement，Web 不展示也不提交 Cluster ID/Namespace。
- 旧数据库设置可加载并作为 fallback；旧 PUT payload 被接受但不再持久化 placement。
- 新保存记录不含 placement；备份恢复旧记录后可回滚旧版本。
- 静态旧 placement 仍能作为 fallback，配置缺失时 AIOS runtime 可启动并加载 catalog，但首次无 placement 创建明确失败。

### 远端验收

- 使用 Make 命令完成镜像构建和测试环境部署。
- 在允许的 clusterName 和 clusterId 各创建一次沙箱，核对实际集群和 namespace。
- 使用无权限/不存在的集群验证控制面拒绝，确认 AIoP 未降级重试。
- 检查日志、审计与页面，不出现 API Key 或已移除的固定 placement 字段。

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 模型选中不支持 placement 的兼容工具 | 动态调度失败 | 同步扩展 `sbx__run_*`，或 AIOS 模式停止暴露它们 |
| 平台 API Key 权限过宽 | 普通用户可请求非预期集群 | 上线前做远端 403 验证；收窄 Key 或增加独立授权设计 |
| key 拼接碰撞 | 跨 placement 错误复用 | 使用结构化稳定编码并覆盖特殊字符测试 |
| 新记录回滚到旧版本 | 旧版本缺 placement 无法启用 AIOS | 部署前备份设置，回滚 Make 目标恢复旧记录 |
| 旧 fallback 长期保留 | 行为继续依赖隐式集群 | 日志标记 fallback 使用，后续版本统计并移除 |
| 非本次工具隐式创建 AIOS 沙箱 | 无 fallback 时失败 | 本期明确失败；后续按实际需求扩展调用级 placement 或设计会话级上下文 |

## 12. 工时估算

| 工作包 | 主要角色 | 常规估算（人天） | 估算说明 |
| --- | --- | --- | --- |
| Runtime 数据模型、规范化、key/metadata | 后端 | 1.0 | 含单元测试 |
| AIOS provider、设置兼容、HTTP API | 后端 | 1.5 | 含旧记录兼容和接口测试 |
| 工具 schema、提示和兼容工具 | 后端 | 0.75 | 含模型工具契约测试 |
| Web 设置页与前端构建 | 前端 | 0.5 | 删除字段、payload 和类型 |
| 回归、镜像、远端部署与权限验收 | 测试/研发 | 1.25 | 含 Make 构建部署和远端 smoke test |
| **合计** |  | **5.0** |  |

估算前提：`aios-sandbox` 已兼容 `clusterName` 请求体，不需要修改其控制面；包含开发、自测、回归、镜像构建和一次远端测试环境部署，不包含等待外部权限变更的自然时间。置信度中等；在完成 Runtime 契约和远端权限探测后复估。
