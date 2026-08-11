# AIOP on AIOS cluster

目标 namespace 为现有的 `aios-system`。本目录不部署 MySQL，后端连接外部
`10.241.0.166:3306/aiop`。

构建并推送双架构镜像：

```sh
make pipeline
```

部署前必须通过 stdin 创建 `aiop-secrets`，禁止把真实密码写入 YAML 或 Git。Secret 至少包含：

- `AIOP_JWT_SECRET`
- `AIOP_SETTINGS_SECRET`
- `OPENAI_API_KEY`
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_DATABASE`
- `MYSQL_USER`
- `MYSQL_PASSWORD_BASE64`
- `MYSQL_SSL`
- `MYSQL_POOL_SIZE`

部署和回滚：

```sh
make deploy-standalone DEPLOYMENT_MODE=standalone AUTH_PROVIDER=local IMAGE_TAG=<git-short-sha>
# 或：make deploy-aios-integrated DEPLOYMENT_MODE=aios-integrated IMAGE_TAG=<git-short-sha>
make rollback-aiop
```

两种部署目标都会在修改集群前执行数据库身份预检。服务启动时还会再次校验，禁止
standalone 的本地/OIDC 数字用户与 AIOS direct accountId 复用同一数据库。

`rollback-aiop` 只允许回滚到声明兼容 `positive-user-ids-v1` 数据库结构、且与当前
`aiop-config` 部署模式一致的 Revision。旧字符串用户 ID 镜像或跨模式回滚会被拒绝；
跨模式恢复必须先按对应发布流程应用匹配的 ConfigMap 并完成数据迁移/校验。

默认访问地址为 `http://10.241.0.166:30084/`。部署前应确认 NodePort 未被占用；
数据库存在且包含表时禁止自动覆盖或初始化。
