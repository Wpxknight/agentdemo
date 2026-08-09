# 本地代码审查修复与 Staging 安全部署设计

## 1. 目标

修复当前工作树中经独立审查和复核确认的七项问题，并通过单一 Make 命令安全地将版本部署到 staging 集群：

1. fresh staging 部署必须精确保留并恢复数据库中的 LLM 和 Sandbox 设置以及 Kubernetes 配置；
2. Skill 导入前后端响应契约保持一致；
3. 任务软删除后，已经物化的 Fire 仍能完成生命周期；
4. bound Fire 检查必须占用 Scheduler 单轮 batch；
5. active/waiting bound Fire 必须公平推迟，避免后续 Fire 永久饥饿；
6. 定时任务详情展示真实时区；
7. Playwright 和 shell 临时产物统一存放在 `dist`。

本次修改不处理复核后确认属于既有问题或当前不可触发的问题，也不进行无关重构。

## 2. 不可突破的安全边界

### 2.1 数据库范围

所有读取、备份、清理、初始化、恢复和验证操作严格限定为 MariaDB 中名称精确等于 `aiop` 的数据库。

脚本必须遵守以下规则：

- 不执行数据库枚举；
- 不读取、修改、创建、删除、导出或重建任何其他数据库；
- 不删除或修改数据库实例、数据库用户和权限；
- 所有 SQL 明确使用 `aiop` 作为目标数据库；
- 在任何写操作或破坏性操作前校验目标数据库名；
- 目标不等于 `aiop` 时失败关闭；
- 不允许通过环境变量将目标覆盖为其他数据库。

### 2.2 集群范围

staging 目标 namespace 为 `aios-system`。脚本必须使用项目现有 kubeconfig/namespace 参数，并在 destructive phase 前验证实际目标。目标不一致时停止。

### 2.3 敏感信息

数据库凭据、模型密钥、Sandbox 密钥、Secret 正文和加密 envelope 不得出现在代码、Makefile 参数、命令行、日志、测试报告或设计文档中。

备份目录权限为 `0700`，敏感文件权限为 `0600`。日志只输出记录数、键名集合和 SHA-256 等非敏感摘要。

## 3. 总体流程

`make deploy-aiop-staging-fresh` 是唯一对外入口，执行以下阶段：

1. 验证 staging namespace、kubeconfig 和数据库目标；
2. 在 `dist/aiop-staging-backup/<run>/` 创建受保护的运行目录；
3. 从 `aiop` 数据库备份必须保留的设置记录；
4. 备份 Kubernetes ConfigMap 和 Secret 的完整 `.data`；
5. 校验备份完整性并记录非敏感摘要；
6. 构建并发布镜像；
7. 再次验证 namespace 和数据库目标；
8. 仅清理并重新初始化 `aiop` 数据库的业务 schema；
9. 导入 baseline；
10. 恢复数据库设置；
11. 精确验证恢复后的数据库记录；
12. 部署 workload，但不使用静态 manifest 覆盖现场 ConfigMap 或 Secret；
13. 验证 Kubernetes 配置未变化；
14. 等待 rollout 并执行健康检查和 Scheduler 验证。

备份、目标校验、恢复或验证任一步骤失败，都必须阻止后续 destructive/deploy phase 或使部署明确失败。

## 4. Staging 设置备份与恢复

### 4.1 数据库备份范围

从 `aiop.tenant_settings` 备份：

- `llm.default`；
- `sandbox.default`。

从 `aiop.setting_secrets` 备份与 Sandbox 设置相关的记录，至少包括：

- `sandbox.default.api_key`。

备份保留恢复所需的原始字段值，包括原始 JSON 与加密 envelope，不解密、不打印正文。

### 4.2 备份格式

使用可被 MariaDB 客户端可靠恢复的 SQL 或制表数据格式。备份文件至少包含：

- 数据记录；
- 预期记录数；
- 按 tenant 和 setting key 计算的摘要；
- 文件 SHA-256；
- 生成时使用的固定数据库名 `aiop`。

若设置记录不存在，空集合也是有效状态，但必须被明确记录并在恢复后验证仍为空。

### 4.3 数据库重建

重建阶段只针对 `aiop`：

- 清理 `aiop` 中现有业务表；
- 不执行 `DROP DATABASE`；
- 不创建或切换到其他数据库；
- 导入 `src/db/migrations/0001_baseline.sql`；
- 验证 baseline 表集合已建立。

重建脚本不再要求操作员预先手工清空数据库，但必须在清理前确认受保护备份已经完成且通过校验。

### 4.4 恢复和验证

baseline 完成后恢复备份记录。验证必须比较：

- tenant 标识；
- setting key；
- 设置 JSON 原文或规范化后的等价哈希；
- Secret key；
- 加密 envelope 原文哈希；
- 记录数和键集合。

任一字段不一致都视为部署失败。验证日志不得包含敏感正文。

### 4.5 Kubernetes 设置保护

备份 `aiop-config` ConfigMap 和 `aiop-secrets` Secret 的完整 `.data`，而不是只备份单个 key。

staging fresh 部署不 apply 仓库中的静态 ConfigMap。它只验证资源存在并部署新的 workload/image。部署前后比较完整 `.data` 的哈希；不同则失败，并报告资源类型和摘要，不输出值。

通用部署命令是否继续 apply ConfigMap 保持现状，本次只收紧 staging fresh 工作流。

## 5. Skill 导入契约

后端和 API 文档已经稳定使用：

```json
{
  "product": {},
  "pendingReview": true
}
```

因此只修复前端：

- `SkillsImportBody` 使用 `product` 和 `pendingReview`；
- 导入成功后读取 `body.product.name`；
- 对 pending review 的产品显示“已上传，等待管理员审核”；
- 不强制选择尚未出现在可用工具列表中的产品；
- 保留刷新行为，但不假设刷新后产品立即可用。

不修改后端返回格式。

## 6. Scheduler Fire 生命周期

### 6.1 软删除任务后的 pending Fire

`scheduled_tasks.deleted_at IS NULL` 只用于选择可继续物化新 Cron Fire 的任务。

领取已经存在的 `scheduler_fires(state=pending)` 时：

- 直接从 `scheduler_fires` 查询；
- 不 join `scheduled_tasks`；
- 不依据任务当前删除状态过滤；
- 保留 retry time、fire time、limit 和事务锁条件；
- 不引入 `SKIP LOCKED`，继续兼容 MariaDB 10.2。

这样，软删除会停止未来物化，但不会破坏已经快照化的 Fire 生命周期。

### 6.2 bound Fire batch 计算

Scheduler 单轮 batch 是旧 Fire 和新 Fire 的共享上限。

实现中区分：

- `boundConsumed`：本轮从 `listBound` 取得并实际检查的候选数量，用于计算剩余 batch；
- 现有推进/恢复计数：继续用于 `tick()` 返回值和现有指标语义。

新 Fire 容量计算为：

```text
remaining = max(0, limit - boundConsumed)
```

即使 bound Fire 最终是 active、waiting 或 CAS 竞争失败，它也已经消耗了本轮观察容量，不得释放为额外的新 Fire dispatch 容量。

### 6.3 active/waiting bound Fire 公平性

当 bound Run inspection 返回 active 或 waiting 时，调用现有 exact-token-fenced `deferBound`：

- Fire 保持 `bound`；
- 保持原 `runId` 和 claim token；
- 不增加普通 dispatch attempts；
- 将 `leaseExpiresAt` 和 `retryAt` 推进到下一观察时间；
- 不调用 `releaseFire`，避免重复创建 Run。

这会让较早的长运行任务暂时退出下一轮候选集合，使后续可恢复 Fire 获得检查机会。

观察延迟复用 Scheduler 现有 retry/backoff 配置，不新增公共配置项。

## 7. 前端时区展示

任务详情的“执行计划”摘要使用：

```text
selectedTask.timezone || 'UTC'
```

与页面标题、创建和编辑表单保持一致。不修改 API 或后端模型。

## 8. 临时文件和运行产物

### 8.1 Shell 临时文件

所有新建临时文件和目录位于 `dist` 下：

- staging 部署临时验证文件位于本次受保护备份目录；
- release smoke 临时目录位于 `dist/test-tmp`；
- 使用 `umask 077`；
- 通过 trap 清理不需保留的明文临时内容；
- 尽可能比较 base64 或 hash，避免将 Secret 解码到临时文件。

### 8.2 Playwright MCP

Playwright MCP 输出目录设置为 `dist/playwright-mcp`。现有根目录 `.playwright-mcp` 内容作为临时产物迁移或清理，不纳入提交。

同时在 `.gitignore` 和 `.dockerignore` 中加入 `.playwright-mcp/`，防止客户端配置失效时污染工作树或 Docker build context。

## 9. 错误处理

### 9.1 失败关闭

以下情况禁止进行数据库清理：

- namespace 不匹配；
- 数据库名不是精确的 `aiop`；
- 无法读取必须保留的设置；
- 备份文件或摘要校验失败；
- Kubernetes 配置无法完整备份；
- 数据库凭据或连接不可用。

### 9.2 重建后的失败

数据库完成重建后，若恢复或验证失败：

- 命令必须非零退出；
- 不继续 rollout；
- 保留受保护备份目录用于人工恢复；
- 输出非敏感的失败阶段和摘要；
- 不声明部署成功。

Kubernetes 配置变化也必须作为部署阻断项处理。

## 10. 测试策略

### 10.1 Scheduler runtime

增加以下回归测试：

- task 软删除后，已经物化的 pending Fire 仍可 claim；
- 已删除 task 不再物化新的 Cron Fire；
- 一个 active/waiting bound Fire 会占用 batch，不能额外领取同等数量的新 Fire；
- 多个 bound Fire 与 pending Fire 的总处理量不超过 limit；
- active/waiting inspection 调用 fenced `deferBound`；
- defer 不改变 run binding、不增加 dispatch attempts；
- 旧 active/waiting Fire 被推迟后，后续 recoverable Fire 能在下一轮被检查；
- MySQL 查询继续不使用 `SKIP LOCKED`。

### 10.2 HTTP/Frontend

增加或调整测试：

- 前端 Skill import 类型和消费逻辑使用 `product`；
- pending review 成功文案正确；
- 不选择尚不可用的 Skill；
- 任务详情使用真实 timezone；
- 后端 `{product,pendingReview}` 契约测试保持通过。

### 10.3 部署脚本

通过脚本契约测试或受控 mock 验证：

- 数据库目标只能是 `aiop`；
- 不出现数据库枚举或其他数据库操作；
- 无有效备份时不会执行清理；
- 只导出指定 setting keys；
- 空设置集合可备份和恢复；
- 所有临时文件位于 `dist`；
- ConfigMap/Secret 比较覆盖完整 `.data`；
- staging fresh 路径不 apply 静态 ConfigMap；
- 错误日志不包含 Secret 正文。

### 10.4 完整验证

依次执行：

1. Scheduler runtime 定向测试；
2. HTTP 和 frontend 定向测试；
3. 项目完整测试；
4. 前端和服务端构建；
5. shell 语法和部署契约检查；
6. staging fresh Make 部署；
7. rollout、健康检查、设置摘要复核和 Scheduler 平台验证。

## 11. 预计修改范围

核心文件：

- `Makefile`
- `scripts/backup-aiop-k8s-settings.sh`
- `scripts/rebuild-aiop-staging-db.sh`
- `scripts/deploy-aiop-staging-fresh.sh`
- `.gitignore`
- `.dockerignore`
- `.test-scripts/release-health/chat_skills_auth_smoke.sh`
- `packages/scheduler-runtime/src/mysql.ts`
- `packages/scheduler-runtime/src/runner.ts`
- `web/src/types.ts`
- `web/src/App.tsx`
- `tests/scheduler-runtime/scheduler-runtime.test.ts`
- `tests/frontend.test.ts`
- 必要的部署脚本契约测试和相关文档

不修改数据库 schema，不改变 Skill HTTP 后端契约，不进行无关架构重构。

## 12. 完成标准

当且仅当满足以下条件，任务可视为完成：

- 七项确认问题均有回归测试或可重复契约验证；
- 完整测试和构建通过；
- staging 部署仅操作 `aiop` 数据库；
- LLM 和 Sandbox 数据库设置恢复后与部署前完全一致；
- Kubernetes ConfigMap/Secret 完整数据未变化；
- rollout 和健康检查通过；
- Scheduler 在远端环境正常工作；
- 日志和报告未暴露任何敏感值。
