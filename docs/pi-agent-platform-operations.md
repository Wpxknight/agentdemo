# Pi Agent Platform 操作说明

本文是 Pi-first runtime 的 staging 构建、部署、备份恢复演练、验收和回滚手册。准备代码或文档时不得把下列步骤写成已执行；真实结果由环境操作者记录到 `/home/opt/develop/aicoding/aiop/dist/runtime-refactor-migration-rehearsal.md`，该文件不提交。

## 1. 安全边界

- staging namespace 固定为 `aiop-dev`。
- 只使用 `deploy/dev-k8s/` manifests；不要应用生产 manifests。
- Secret `aiop-dev-secrets` 必须由批准的 Secret 管理流程预先创建。
- 只允许用 `kubectl -n aiop-dev get secret aiop-dev-secrets -o name` 验证资源存在；禁止读取 YAML、describe、decode 或打印 data/stringData。
- 当前 MySQL PVC 是 `ReadWriteOnce`；不要引入共享 RWX 存储假设。
- 所有镜像、部署和回滚通过根目录 `Makefile`。

## 2. 本地质量门禁

```bash
make verify-node
npm run typecheck
npm test
make test-agent-platform
npm --prefix web run build
git diff --check
```

源边界测试：

```bash
npx vitest run tests/runtime-refactor-rollout.test.ts tests/pi-platform-manifest.test.ts tests/pi-delivery-baseline.test.ts
```

## 3. 不可变镜像

`IMAGE_TAG` 默认取当前 Git short SHA：

- backend：`aiop:<short-sha>`
- web：`aiop-web:<short-sha>`

构建入口：

```bash
make image
```

该 target 构建两个镜像，并在 backend 镜像内执行 `@aiop/pi-runtime` workspace import smoke 和 Node 版本 smoke。不要使用 `:dev` 或 `:latest` 作为本次演练证据。

如需显式复现同一 tag：

```bash
IMAGE_TAG="$(git rev-parse --short HEAD)" make image
```

## 4. 数据库备份准备

迁移 `src/db/migrations/0022_pi_only_runtime.sql` 不可逆。部署前必须完成逻辑备份、校验和、临时数据库恢复与兼容抽样。

以下命令从 MySQL 容器内部使用已有环境变量，不在宿主 shell 参数或输出中暴露密码：

```bash
REHEARSAL_DIR=/home/opt/develop/aicoding/aiop/dist
BACKUP_ID="runtime-refactor-$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${REHEARSAL_DIR}/${BACKUP_ID}.sql"
mkdir -p "${REHEARSAL_DIR}"

kubectl -n aiop-dev exec deployment/mysql -- sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --routines --triggers "$MYSQL_DATABASE"' \
  > "${BACKUP_FILE}"
test -s "${BACKUP_FILE}"
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"
```

不要把 SQL dump、checksum 文件或 evidence 加入 Git。

## 5. 恢复演练

恢复到隔离数据库，不覆盖 staging 当前库：

```bash
RESTORE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kubectl -n aiop-dev exec deployment/mysql -- sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e "DROP DATABASE IF EXISTS ai_ops_runtime_refactor_rehearsal; CREATE DATABASE ai_ops_runtime_refactor_rehearsal CHARACTER SET utf8mb4"'
kubectl -n aiop-dev exec -i deployment/mysql -- sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot ai_ops_runtime_refactor_rehearsal' \
  < "${BACKUP_FILE}"
RESTORE_FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

抽样只查询非敏感计数和状态，不查询用户 Credential、setting secret 或 Tool 参数正文：

```bash
kubectl -n aiop-dev exec deployment/mysql -- sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -N -uroot ai_ops_runtime_refactor_rehearsal -e "SELECT COUNT(*) FROM agent_runs; SELECT COUNT(*) FROM agent_interactions WHERE status = '\''pending'\''; SELECT COUNT(*) FROM agent_tool_executions WHERE status = '\''recovery_required'\'';"'
```

演练后可删除隔离数据库：

```bash
kubectl -n aiop-dev exec deployment/mysql -- sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e "DROP DATABASE IF EXISTS ai_ops_runtime_refactor_rehearsal"'
```

## 6. Evidence 文件

环境操作者创建 `/home/opt/develop/aicoding/aiop/dist/runtime-refactor-migration-rehearsal.md`，至少记录：

```markdown
# Runtime Refactor Migration Rehearsal

- Git SHA:
- Image tag:
- UTC start/end:
- Backup ID and absolute file path:
- Backup SHA-256 verification: PASS/FAIL
- Restore database:
- Restore duration:
- Pre/post sample counts:
- Secret inspection performed: no
- Deployment result: PASS/FAIL/PENDING
- Acceptance matrix result: PASS/FAIL/PENDING
- Rollback result: PASS/FAIL/PENDING
- Compatibility findings:
- Operator:
```

准备阶段保持 `PENDING`；不能预填虚构的 PASS、耗时或对象数量。

## 7. Staging 部署

确认当前提交、镜像 tag 和备份 evidence 后执行：

```bash
make deploy-staging
```

该 target 按顺序：

1. apply `deploy/dev-k8s/namespace.yaml`；
2. 仅以 `-o name` 检查 `aiop-dev-secrets`；
3. apply MySQL、Dex、默认 ConfigMap、Service 和 RBAC；
4. 用本地 `kubectl set image --local -o yaml` 在一次 Deployment apply 中注入 backend/web immutable images；
5. 等待 `deployment/mysql`、`deployment/dex`、`deployment/aiop-server` Ready。

若 Secret 不存在，target 必须在创建工作负载前失败。Makefile 永远不创建或应用示例 Secret。

## 8. 部署验收矩阵

以下项目均需记录请求标识、Run ID、期望与结果，但不得记录 Token、Credential 或 Tool 敏感参数：

| 场景 | 验收点 |
| --- | --- |
| HTTP Run | 创建 Pi Run，SSE 顺序完整，终态与产品消息一致 |
| Scheduled Run | Fire 只创建/关联 Durable Run，不直接执行 Agent loop |
| Cancel | 活跃 Attempt 停止，迟到提交被 fencing 拒绝 |
| Recovery | 失租 Run 创建唯一新 Attempt，不重复终态 |
| Approval | pending Interaction 可由授权 actor 解析且只解析一次 |
| MCP Tool | tenant 可见性、Credential provider 和统一 Governance 生效 |
| AIOS Sandbox Tool | create/readiness/command/timeout/cleanup 通过，输出无 Credential |
| Run Center | Attempt、Turn、Event、Interaction、Ledger、usage/cost 可查询 |

验收前后都要检查应用健康与 readiness；具体 API 可通过 Web/HTTP 测试账号执行，凭据只从批准的 Secret/登录流程获得。

## 9. 回滚前兼容检查

执行应用回滚前记录：

- 当前和目标 backend/web image；
- schema migration 版本；
- pending `agent_run_inbox_messages` 数量；
- pending `agent_interactions` 数量；
- `recovery_required` Tool/Run 数量；
- 是否存在新版本已写、旧版本不能理解的 execution mode 或状态。

代码回滚不撤销数据库迁移。若目标版本不能安全忽略新列/表、不能保留 pending inbox/interaction，或会自动重放未知副作用，停止应用回滚并选择数据库恢复或修复版本。

## 10. Staging 回滚

兼容检查通过后：

```bash
make rollback-staging
```

该 target 对 `aiop-dev` namespace 的 `deployment/aiop-server` 执行 `rollout undo` 并等待 Ready。回滚后重新验证：

- 旧应用可读取兼容 Run、message 和 scheduler 数据；
- pending inbox 未被丢弃或错误消费；
- pending Interaction 仍保持 pending；
- `recovery_required` 调用未自动重放；
- 新旧 image 与 rollout revision 已写入 evidence。

若问题来自不可逆迁移或数据损坏，应用 `rollout undo` 不足以恢复，必须按已演练备份执行数据库恢复。

## 11. 禁止事项

- 不运行 `kubectl get secret ... -o yaml`、`kubectl describe secret` 或 base64 decode。
- 不应用 `deploy/dev-k8s/aiop-secret.example.yaml`。
- 不对 staging 使用 `deploy/k8s/` 或 namespace `aiop`。
- 不手工 patch 两个容器后分别 apply，避免 Deployment 短暂混用不同提交镜像。
- 不使用可变镜像 tag 作为部署或回滚证据。
- 不把 `/home/opt/develop/aicoding/aiop/dist/` 下的 dump/evidence 提交到 Git。
