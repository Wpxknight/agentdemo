# Sandbox Default Placement Design

## Goal

在平台“沙箱设置”的 AIOS Lifecycle 模式中配置默认集群 ID 和默认命名空间。默认值分别为 `1` 和 `aios-system`。聊天工具创建或复用沙箱时，用户显式提供的 placement 字段优先，未提供的字段由平台默认配置补齐。

## Resolution Rules

placement 按字段合并，而不是整对象替换：

| 用户输入 | 最终集群 | 最终命名空间 |
|---|---|---|
| 未指定 | 配置的默认 clusterId | 配置的默认 namespace |
| 仅 clusterId/clusterName | 用户指定集群 | 配置的默认 namespace |
| 仅 namespace | 配置的默认 clusterId/clusterName | 用户指定 namespace |
| 同时指定集群和 namespace | 用户指定集群 | 用户指定 namespace |

用户同时提供 `clusterId` 与 `clusterName` 时，以 `clusterId` 为准并忽略 `clusterName`。用户输入永远不修改平台默认设置，只影响本次沙箱选择及其缓存键。

## Settings Contract

1. `GET /v1/settings/sandbox` 在 AIOS Lifecycle 设置中返回：
   - `default_cluster_id`
   - `default_namespace`
2. `POST /v1/settings/sandbox` 接受并持久化上述字段。
3. 新配置表单默认填入 `1`、`aios-system`。
4. 历史 AIOS Lifecycle 配置没有 placement 时，读取/规范化后使用相同默认值，不需要数据库迁移。
5. 默认 placement 不参与 API Key 凭据目标计算，修改默认集群或命名空间不要求重新输入 Key。

## Runtime Changes

1. 保留并持久化 AIOS Lifecycle `placement`，不再在设置保存时剥离。
2. `normalizeSandboxPlacement(input, fallback)` 改为字段级合并：用户集群覆盖默认集群，用户 namespace 覆盖默认 namespace。
3. 浏览器、代码、命令和 profile 沙箱统一通过 resolver 使用相同合并逻辑。
4. HTTP 直接调用沙箱/浏览器接口允许只传 namespace；最终由运行时补齐默认集群。

## Safety and Compatibility

- 只影响 AIOS Lifecycle placement；标准 E2B、OpenSandbox 和 Local 模式不变。
- 最终 placement 仍保证只有一个有效集群选择器且 namespace 非空；双选择器输入统一收敛为 `clusterId`。
- placement 继续进入沙箱缓存键，避免不同集群或 namespace 误复用同一沙箱。
- 已创建沙箱不迁移；新建或因 placement 不同而创建的沙箱使用新规则。

## Verification

- 设置 schema、HTTP API、持久化和前端表单测试。
- placement 四种覆盖组合及双选择器时 `clusterId` 优先测试。
- runtime/profile/browser 沙箱获取测试，确认用户输入优先、默认字段补齐。
- TypeScript、前端构建、全量测试。
- 使用 Make 构建镜像并部署 166，线上验证设置读写和 Pod 状态。
