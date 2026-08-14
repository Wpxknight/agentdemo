# AIOS Sandbox Placement 原样透传设计

> 文档版本：1.0
> 更新日期：2026-08-14
> 状态：已实现
> 本文覆盖并废止 AIoP 本地 `clusterName → clusterId` 兼容目录方案。

## 1. 目标与边界

AIoP 只负责接收、规范化和透传 Sandbox placement，不维护集群目录，不判断集群是否存在，也不判断调用方是否有权访问目标集群。

职责边界：

| 责任 | AIoP | aios-sandbox-server |
| --- | --- | --- |
| 字段类型、非空、name/id 二选一 | 是 | 可防御性复核 |
| namespace 缺省为 `aios-system` | 是 | 可防御性复核 |
| clusterName 与 clusterId 映射 | 否 | 是 |
| 集群、namespace 是否存在 | 否 | 是 |
| API Key、用户、模板和目标集群授权 | 否 | 是 |
| placement 复用隔离和审计 metadata | 是 | 否 |

AIoP 不调用本地数据库、配置目录、Kubernetes API 或 AIOS 集群查询接口验证 placement。`clusterName`、`clusterId`、`namespace` 的业务含义完全由 `aios-sandbox-server` 解释。

## 2. 当前实现与问题

当前动态 placement 主链路已经具备以下正确行为：

- `normalizeSandboxPlacement` 校验 selector，填充默认 namespace。
- placement 在 `SandboxManager.get` 前进入 `SandboxSpec.key` 和 metadata。
- 动态 placement 优先于旧配置 fallback。
- Lifecycle 4xx 可在直连 Sandbox HTTP API 中保留状态码。

需要删除的行为位于 AIOS Provider：

- `AiosE2bProviderOptions.clusterDirectory` 保存本地 `clusterName → clusterId` 目录。
- `lifecyclePlacement` 把名称改写为 ID。
- 未命中本地目录时，AIoP 在发出 HTTP 请求前返回“未授权或未知集群名称”。
- Runtime 从 `AIOP_AIOS_SANDBOX_CLUSTER_DIRECTORY` 读取目录并传入 Provider。

上述行为让 AIoP 成为不完整的集群权威源，且可能把“目录未同步”错误解释为“用户无权限”。

## 3. 目标处理流程

### 3.1 格式规范化

保留现有最小格式规则：

1. 字段必须为字符串。
2. 去除 `clusterName`、`clusterId`、`namespace` 首尾空白；不改变大小写和内部字符。
3. `clusterName` 与 `clusterId` 必须且只能提供一个。
4. 仅提供 namespace 时拒绝。
5. namespace 缺失时补为 `aios-system`。
6. 不增加 Kubernetes DNS、集群命名规则、ID 格式或本地目录匹配校验。

本文中的“原样透传”是指：完成上述通用规范化后，不做名称到 ID 的转换，不替换 selector，不查询存在性或授权；Lifecycle 请求中的字段和值与规范化后的 `SandboxSpec.placement` 一致。

### 3.2 Lifecycle 请求

名称请求：

```json
{
  "placement": {
    "clusterName": "cluster-pc1",
    "namespace": "aios-system"
  }
}
```

ID 请求：

```json
{
  "placement": {
    "clusterId": "4",
    "namespace": "aios-system"
  }
}
```

AIoP Provider 直接使用已规范化的 `spec.placement`。旧配置 placement 仍只在调用完全没有动态 placement 时作为 fallback；动态 name/ID 即使被 server 拒绝，也不得改用 fallback。

## 4. 缓存与 metadata 语义

现有复用策略保持不变：

```text
<identity/profile-key>:placement:<JSON.stringify([selector, value, namespace])>
```

metadata 保持：

```json
{
  "placementSelector": "clusterName",
  "placementCluster": "cluster-pc1",
  "placementNamespace": "aios-system"
}
```

边界说明：

- AIoP 不知道 `clusterName=cluster-pc1` 与 `clusterId=4` 是否指向同一集群，因此二者使用不同 key，不做合并。
- 同一 selector、值、namespace 复用；任一字段不同均隔离。
- metadata 记录调用方使用的 selector，不改写为 server 内部解析结果。
- 创建请求被 server 拒绝时，`SandboxManager` 不写入 ready cache；inflight 结束后后续调用可重新请求。
- 会话销毁继续依据 identity metadata 回收，不解析 placement key。

该策略可能为同一物理集群分别创建 name-key 和 id-key 沙箱，但避免 AIoP 维护不可靠的等价关系，符合职责边界。

## 5. 错误与授权透传

aios-sandbox-server 是 placement 存在性和授权的唯一裁决方：

- `400`：server 判定 placement 语义或格式不可接受。
- `401/403`：凭据或目标集群授权失败。
- `404`：目标集群、namespace、模板或相关资源不存在。
- `409/429`：状态冲突或限流。
- `5xx`：控制面内部故障。

处理要求：

- AIoP 不把 server 错误改写为本地“未知集群”错误。
- 直连 `/v1/sandbox/run-code`、`/v1/sandbox/run-command` 保持现有可信 Lifecycle 4xx 状态透传。
- Agent/聊天工具保持现有 `ToolResult.isError` 语义，并包含不泄露凭据的 Lifecycle 状态摘要。
- 任何 server 拒绝均不触发 clusterName/clusterId 互换、目录查询、fallback、其他 namespace 或更高权限模板重试。
- API Key、请求头和上游敏感响应体不得进入日志、metadata 或模型上下文。

AIoP 仍负责 profile RBAC，例如 `sandbox-diag` 的 `platform_admin` 限制；这是沙箱模板权限，不是目标集群存在性或授权判断。

## 6. 最小改动清单

| 文件/模块 | 最小改动 |
| --- | --- |
| `packages/sandbox-runtime/src/aios-e2b.ts` | 删除 `clusterDirectory` option、Map 和 `lifecyclePlacement`；`POST /sandboxes` 直接发送 `normalizedPlacement.placement` |
| `packages/sandbox-runtime/src/contracts.ts` | 删除 AIOS config 中的 `clusterDirectory` 类型 |
| `src/runtime.ts` | 删除 `parseAiosSandboxClusterDirectory`、环境变量读取、warn 日志和 Provider 参数传递 |
| `Makefile` | 删除 `AIOP_AIOS_SANDBOX_CLUSTER_DIRECTORY` 变量和部署 env 注入 |
| 公共声明/配置文档 | 删除 cluster directory 导出、环境变量和 166 兼容目录说明 |
| `tests/aios-e2b.test.ts` | 把名称映射/未知名称本地拒绝测试替换为 clusterName 原样请求测试 |
| 部署契约测试 | 删除对 Makefile cluster directory 参数的断言 |

不需要修改：

- `SandboxPlacement` 数据模型。
- placement 规范化、默认 namespace、key suffix 和 metadata。
- 设置页和旧 placement fallback 兼容。
- 数据库 schema 或 migration。
- aios-sandbox-server 之外的 Provider 行为。

## 7. 测试覆盖

### 单元与 Provider 合约

- `clusterName=cluster-pc1` 的 Lifecycle 请求体仍为 `clusterName`，不出现 `clusterId`。
- `clusterId=4` 保持 ID 请求体，不出现 `clusterName`。
- 大小写和内部字符保持，首尾空白按统一规范化规则移除。
- name/id 同传、两者缺失、namespace-only、空白字段在 HTTP 请求前拒绝。
- 动态 placement 优先于 fallback；server 拒绝动态 placement 后不使用 fallback。
- Provider options 和公共类型中不存在 `clusterDirectory`。

### 缓存与审计

- `clusterName=cluster-pc1` 和 `clusterId=4` 生成不同 key。
- 相同 name/namespace 重复调用复用同一沙箱。
- 不同 name、ID 或 namespace 不复用。
- metadata 保留原 selector/value，不出现本地映射后的 ID。
- server 4xx/5xx 后没有 ready cache 条目。

### HTTP 与错误边界

- 模拟 server 对任意 clusterName 返回 403，直连 API 返回 403，不 fallback、不再次请求。
- 模拟不存在 clusterName 返回 404，直连 API 返回 404，且请求确实到达 server。
- 模拟 server 400/409/429，验证可信 Lifecycle 4xx 沿用现有映射。
- Agent 工具收到 403/404 时返回 `isError=true`，不产生第二次创建请求。
- 错误和日志不包含 API Key 或完整敏感响应体。

### 回归

- placement 复用隔离、并发 inflight 去重、会话回收测试继续通过。
- 旧静态/数据库 placement fallback 继续可用。
- 非 AIOS Provider 只做格式校验，不改变缓存或请求。
- Make 部署命令不再设置已删除的 cluster directory 环境变量。

## 8. 验收标准

1. AIoP 代码和部署配置中不存在本地集群目录或 name-to-ID 映射。
2. 任意格式合法的 clusterName 都会到达 aios-sandbox-server。
3. AIoP 不在请求前判断集群或 namespace 是否存在、用户是否有权访问。
4. server 的拒绝不会触发 selector 转换、fallback 或重试其他目标。
5. placement 继续进入 key/metadata，跨目标沙箱不会错误复用。
6. 现有 profile RBAC、API Key 脱敏和错误边界保持不变。

## 9. 工时估算

| 工作包 | 主要角色 | 常规估算（人天） | 说明 |
| --- | --- | ---: | --- |
| 删除目录、Provider 透传和公共类型 | 后端 | 0.5 | 无数据库变更 |
| 测试、声明和部署契约更新 | 后端/测试 | 0.5 | 含相关回归，不含部署 |
| **合计** |  | **1.0** |  |

估算包含开发、自测和相关回归，不包含镜像构建、部署或 aios-sandbox-server 修改。置信度高。
