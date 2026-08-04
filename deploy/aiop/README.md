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
make deploy-aiop IMAGE_TAG=<git-short-sha>
make rollback-aiop
```

默认访问地址为 `http://10.241.0.166:30084/`。部署前应确认 NodePort 未被占用；
数据库存在且包含表时禁止自动覆盖或初始化。
