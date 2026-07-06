# 部署清单（k8s）

HTTP 服务 Pod 内包含两个容器：

- `aiop-web`：Nginx 前端容器，监听 `8080`，对外承接 Service 流量。
- `aiop`：后端 API/SSE 容器，监听 `8081`，仅供同 Pod 内前端通过 `127.0.0.1:8081` 访问；同时通过
  `AIOP_EMBED_SCHEDULER=true` 内嵌定时任务调度器。

`deployment-server.yaml` 同时承载 HTTP + SSE 服务和调度器。调度器靠 DB 原子领取到点任务，避免重复执行。

## 构建镜像

```sh
docker build -t aiop:latest .
docker build -f web/Dockerfile -t aiop-web:latest .
```

## 顺序

```sh
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml          # config.jsonc（按需改）
kubectl apply -f secret.example.yaml     # 改成真实值后 apply（勿提交真实密钥）
kubectl apply -f deployment-server.yaml
kubectl apply -f service.yaml
# 运维目标集群的 kubectl ServiceAccount + RBAC（按需）：
kubectl apply -f ops-rbac.example.yaml
```

从旧版本升级时，先清理曾经单独部署的调度器：

```sh
kubectl -n aiop delete deployment aiop-scheduler --ignore-not-found
```

## 引导首个平台管理员

```sh
kubectl -n aiop exec deploy/aiop-server -c aiop -- npm run start seed-admin default admin '强口令'
```

## 密钥

- `AIOP_JWT_SECRET`：会话 JWT 签名密钥，必须强随机。
- `MYSQL_PASSWORD_BASE64`：MySQL 口令的 base64（`echo -n 'pw' | base64`）。注意 base64 是编码非加密，仅避免明文直读；真正的机密保护靠 k8s Secret / 外部 KMS。
- `E2B_API_KEY` / `OIDC_CLIENT_SECRET`：按需。
