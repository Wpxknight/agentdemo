# AIOS Sandbox 动态集群调度开发计划

> 依据：[动态集群调度设计](../specs/2026-08-13-dynamic-aios-sandbox-placement-design.md)  
> 更新日期：2026-08-13  
> 常规估算：5.0 人天（含测试、镜像和一次远端部署）

## 阶段 1：运行时契约与复用隔离（1.0 人天）

1. 为 `SandboxSpec` 增加 provider-neutral `placement`，定义 `clusterName`、`clusterId`、`namespace`。
2. 实现唯一的 placement 规范化/校验函数：trim、name/id 二选一、namespace-only 拒绝、动态默认 `aios-system`、旧 fallback 解析。
3. 使用结构化稳定编码生成 placement cache suffix，加入现有 profile/identity key；同步写入不含凭据的 metadata。
4. 确认 placement 在 `SandboxManager.get` 和 inflight 去重前已生效；会话销毁继续依据 metadata，不解析 key。
5. 增加规范化、特殊字符无碰撞、同 placement 复用、跨 placement 隔离、并发去重和会话回收测试。

验收：相同身份/profile/placement 得到相同 key；任一 selector、value 或 namespace 不同均得到不同 key；冲突参数不进入 provider。

## 阶段 2：AIOS Provider 与旧配置兼容（1.0 人天）

1. 调整 AIOS E2B provider：构造期固定 placement 改为可选 fallback，创建时优先使用 `spec.placement`。
2. Lifecycle `POST /sandboxes` 支持且仅发送 `clusterName` 或 `clusterId` 之一；连接既有 sandboxId 的路径保持不变。
3. 无动态 placement 和 fallback 时，在 HTTP 前明确失败；动态参数错误不得回退旧 placement。
4. 静态 `sandbox.aios.placement` 改为可选 deprecated 字段，更新配置注释和公共类型投影。
5. 增加 clusterName、clusterId、默认 namespace、动态优先、fallback、无 placement、401/403 不降级测试。

验收：两种 placement 请求体均符合 aios-sandbox 契约；错误路径不发送错误目标或泄露 API Key。

## 阶段 3：工具参数与 HTTP API（1.25 人天）

1. 扩展 sandbox acquirer/spec resolver，使一次工具调用可把动态 placement 合并到选定 profile spec。
2. 给 `sandbox_ensure`、`sandbox_run_code`、`sandbox_run_command` 增加 `clusterName`、`clusterId`、`namespace` schema 和模型提示。
3. 同步扩展 AIOS 模式仍暴露的 `sbx__run_code`、`sbx__run_command`；若选择不扩展，则在 AIOS 模式停止暴露，避免模型误选。优先采用扩展方案。
4. 明确扩展 `POST /v1/sandbox/run-code`、`POST /v1/sandbox/run-command`：接收 `cluster_name`、`cluster_id`、`namespace`，校验后映射为工具参数。
5. 保持现有 `requireAuth`、profile 可见性和 acquire 时二次授权；cluster 参数不能绕过 `sandbox-diag` 的 `platform_admin` 限制。
6. 增加工具 schema、HTTP 400、snake/camel 映射、普通用户 profile 拒绝和上游 401/403 传播测试。

验收：用户目标集群能进入最终 Lifecycle 请求；name/id 冲突在工具/HTTP 边界被拒绝；无权限 profile 不因 placement 放行。

## 阶段 4：设置持久化与 Web（0.75 人天）

1. AIOS Lifecycle 新设置模型不再要求 placement；旧数据库记录仍可读取为内部 deprecated fallback。
2. 设置 GET 不返回 placement；PUT 兼容接收旧 placement 但忽略且不持久化，其他未知字段继续拒绝。
3. `sandboxSettingsToConfig` 将旧记录/静态 placement 投影为 provider fallback；新记录不生成 fallback。
4. 删除 Web 设置表单的 Cluster ID、Namespace、对应状态、类型和 payload，仅保留 Enabled、Lifecycle URL、API Key。
5. 更新设置、MySQL/Memory Store、HTTP projection、前端构建和旧记录惰性迁移测试。

验收：旧记录升级可启动；页面保存后数据库记录无 placement；公共 API 和页面均不再暴露固定集群字段。

## 阶段 5：文档、回归和远端部署（1.0 人天）

1. 更新 Sandbox creation contract、配置参考、HTTP API 参考、`.env.example` 和相关设计文档，区分 API Key 与内部缓存 key。
2. 更新 fixtures、快照和公共声明文件；执行 sandbox runtime、settings、HTTP、frontend、auth 相关测试及 typecheck。
3. 使用 Make 命令完成构建和部署，不直接拼装镜像/部署命令：

```bash
make test-runtime-refactor
make image
make deploy-aios-integrated DEPLOYMENT_MODE=aios-integrated AUTH_PROVIDER=aios
```

实际发布参数沿用项目远端环境约定；部署前使用现有备份 Make 目标备份 Sandbox 设置，确保旧版本回滚可恢复 placement。

4. 远端验证 clusterName、clusterId、默认 `aios-system`、同会话跨集群隔离、设置页字段删除。
5. 用无权限或不存在的集群验证控制面拒绝；确认 AIoP 不 fallback、不换目标重试。若平台 API Key 可无条件跨全部集群创建，停止上线并转为权限整改。
6. 检查日志和审计，不得出现 API Key；记录部署镜像、rollout 和 smoke test 结果。

验收：完整回归通过，远端允许/拒绝路径均符合设计，部署可通过现有 Make 回滚目标恢复。

## 测试矩阵

| 层级 | 必测项 |
| --- | --- |
| 规范化 | trim、大小写保留、默认 namespace、冲突、空选择器、namespace-only、特殊字符 |
| Provider 合约 | clusterName、clusterId、动态优先、旧 fallback、无 placement、请求体单选择器 |
| 缓存生命周期 | 同 placement 复用、跨集群/namespace 隔离、并发 inflight、disposeSession 全回收 |
| 工具 | 三个 profile 工具和兼容 `sbx__run_*` schema、参数进入 spec、模型描述 |
| HTTP | snake_case 映射、400 参数错误、认证、profile RBAC、上游 401/403 不降级 |
| 设置/升级 | GET 隐藏、PUT 忽略旧字段、旧记录加载、新保存移除、静态 fallback |
| Web | 字段删除、payload 删除、模式切换、API Key retain/replace/clear 不受影响 |
| 远端 | name/ID 创建、默认 namespace、实际落点、权限拒绝、日志脱敏、回滚备份 |

## 实施边界

- 不实现自然语言正则提取器；由模型依据工具 schema 提取集群名称或 ID。
- 不建立会话级“当前集群”持久化状态。
- 不绕过或模拟 AIOS Sandbox 的集群授权、模板权限和 Kubernetes RBAC。
- 不迁移、重建或移动已运行沙箱。
- 不新增数据库表或 migration；旧设置采用兼容读取和下一次保存惰性迁移。
- 不把 profile 的 `namespace` 当作 Lifecycle placement namespace。
- 非本次 placement-aware 工具在无 fallback 时允许明确失败，不静默选择集群；后续按实际需求扩展。

## 风险门禁与回滚

1. **权限门禁**：远端必须证明未授权目标被 AIOS 控制面拒绝；否则不能仅依赖模型提示上线。
2. **复用门禁**：同会话 pc1/pc2 必须产生不同 sandboxId，重复 pc1 必须复用。
3. **兼容门禁**：旧数据库记录加载和新记录保存都必须有自动化测试。
4. **回滚门禁**：新版本保存会去掉 placement，部署前必须备份 `sandbox.default`；回滚旧版本时恢复旧记录。
5. **降级原则**：动态参数冲突、401/403、目标不存在均不允许自动使用旧 fallback。

## 复估节点

阶段 2 完成并对远端 aios-sandbox 做一次 clusterName/clusterId/403 合约探测后复估剩余工作。若需要新增用户级集群授权查询或 allowlist，不纳入本计划，应先补充安全设计。

## 166 兼容说明

AIoP 不维护集群名称目录，也不执行 `clusterName` 与 `clusterId` 互转。格式规范化后的 selector、值和默认 namespace 原样发送给 Lifecycle；目标存在性、名称解析和授权由 `aios-sandbox-server` 唯一裁决。动态 placement 被拒绝时禁止使用旧配置 fallback 或重试其他 selector，Sandbox key 与 metadata 保留调用方原始 selector。
