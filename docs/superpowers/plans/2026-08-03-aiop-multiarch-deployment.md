# AIOP 多架构构建与集群部署开发计划

**目标：** 将默认数据库名改为 `aiop`，增加 `make pipeline` 双架构镜像发布能力，并将明确版本部署到 `10.241.0.166` 集群。

**状态：** 待用户确认设计后执行。

## Task 1：补充发布与部署契约测试

**文件：**

- 修改：`tests/frontend.test.ts` 或新增等价部署契约测试
- 修改：`Makefile`

- [ ] 断言默认镜像前缀为 `deploy.bocloud.k8s:40443/aios`。
- [ ] 断言 `pipeline` 使用 `linux/amd64,linux/arm64`、`--push` 和 SHA tag。
- [ ] 断言生产部署不引用 `deploy/dev-k8s/mysql.yaml`。
- [ ] 断言生产 Service 使用 NodePort `30084`。

验收：契约测试先失败，完成 Task 2、3 后通过。

## Task 2：实现 `make pipeline`

**文件：**

- 修改：`Makefile`

- [ ] 增加 `IMAGE_PREFIX`、`PLATFORMS`、backend/web 完整镜像变量。
- [ ] 增加构建前 Node 校验、backend 测试和 web build。
- [ ] 使用 `docker buildx build --platform ... --push` 分别发布 backend/web。
- [ ] 增加远端 manifest 平台检查，任一镜像或架构缺失时失败。
- [ ] 保留现有 `image` 本地单架构行为，避免影响开发流程。

验证：

```bash
make verify-node
npm run typecheck
npm --prefix web run build
make -n pipeline
```

## Task 3：统一默认数据库名并新增目标部署清单

**文件：**

- 修改：`deploy/dev-k8s/aiop-secret.example.yaml`
- 修改：`deploy/dev-k8s/mysql.yaml`
- 修改：`deploy/k8s/secret.example.yaml`
- 新增：`deploy/aiop/configmap.yaml`
- 新增：`deploy/aiop/deployment.yaml`
- 新增：`deploy/aiop/pvc-skills.yaml`
- 新增：`deploy/aiop/service-nodeport.yaml`
- 新增：`deploy/aiop/README.md`
- 修改：`Makefile`

- [ ] 将示例和开发 MySQL 默认库名由 `ai_ops` 改为 `aiop`。
- [ ] 所有 AIOP 资源部署到现有 `aios-system` namespace，资源名使用 `aiop-*` 前缀。
- [ ] 新增 NodePort `30084` 清单。
- [ ] Deployment 使用 backend/web 双容器、现有探针和资源基线。
- [ ] 使用 `nfs-csi` 创建 `aiop-skills` RWX PVC，持久化产品技能目录。
- [ ] Deployment 只通过 `aiop-secrets` 引用数据库凭据，不保存明文。
- [ ] 增加 `make deploy-aiop` 和 `make rollback-aiop`，默认使用指定 kubeconfig。
- [ ] 部署命令使用明确 `IMAGE_TAG` 注入清单，并等待 rollout。

验证：

```bash
kubectl --kubeconfig /home/lb/.kube/config-10.241.0.166 apply --dry-run=server -f deploy/aiop/configmap.yaml
kubectl --kubeconfig /home/lb/.kube/config-10.241.0.166 apply --dry-run=server -f deploy/aiop/service-nodeport.yaml
kubectl --kubeconfig /home/lb/.kube/config-10.241.0.166 apply --dry-run=server -f deploy/aiop/deployment.yaml
```

## Task 4：构建并推送双架构镜像

- [ ] 确认 Git 工作区和待发布 commit/tag，记录 `IMAGE_TAG`。
- [ ] 确认 buildx builder 支持 amd64/arm64，仓库登录有效。
- [ ] 执行 `IMAGE_TAG=<sha> make pipeline`。
- [ ] 用 `docker manifest inspect --insecure` 验证两个镜像均含 amd64/arm64。

失败处理：不部署；保留构建日志，修复后使用同一 commit 的新 tag 或重新发布。

## Task 5：安全预检并按需创建数据库

- [ ] 使用临时 `mysql:8.4` 客户端通过环境变量读取密码，禁止在参数和日志中回显。
- [ ] 只读查询 MySQL 版本、`aiop` schema 是否存在、表数量、字符集。
- [ ] 若 `aiop` 不存在，仅执行 `CREATE DATABASE aiop CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`；若服务端不支持该排序规则，先报告并选择兼容 utf8mb4 排序规则。
- [ ] 若 `aiop` 已存在且有表，立即停止并向用户报告，不执行部署。
- [ ] 若为空库，记录预检结果到 `dist/`，不记录密码。

禁止：`DROP`、`TRUNCATE`、批量数据修改、全局权限变更。

## Task 6：创建 Secret 并部署

- [ ] 使用 stdin 和 `kubectl -n aios-system create secret --dry-run=client -o yaml | kubectl apply -f -` 创建 `aiop-secrets`，不生成明文文件。
- [ ] 执行 `IMAGE_TAG=<sha> make deploy-aiop`。
- [ ] 验证 Deployment、Pod、Service、Endpoints 和 Event。
- [ ] 验证 `/healthz`、`/readyz` 及 `http://10.241.0.166:30084/`。
- [ ] 确认 backend 使用 MySQL 而非 MemoryStore，确认 baseline migration 完成。
- [ ] 将非敏感部署证据写入 `dist/aiop-deployment-verification.md`。

## Task 7：回滚验证与交付

- [ ] 若存在上一 revision，执行 `make rollback-aiop` 并确认恢复；随后重新部署目标 SHA。
- [ ] 首次部署无历史 revision 时，仅验证回滚命令 dry-run/前置条件，不删除数据库。
- [ ] 运行项目相关测试和 YAML/Makefile 契约测试。
- [ ] 汇报修改文件、镜像 digest、访问地址、数据库状态和未解决风险。

最终验收：

```bash
npm test
npm --prefix web run build
docker manifest inspect --insecure deploy.bocloud.k8s:40443/aios/aiop:<sha>
docker manifest inspect --insecure deploy.bocloud.k8s:40443/aios/aiop-web:<sha>
kubectl --kubeconfig /home/lb/.kube/config-10.241.0.166 -n aios-system rollout status deployment/aiop-server --timeout=180s
curl --fail --max-time 10 http://10.241.0.166:30084/healthz
```
