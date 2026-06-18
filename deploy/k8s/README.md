# 部署清单（k8s）

无状态后端，可水平扩展。两类工作负载共用同一镜像，入口参数不同：

- `deployment-server.yaml` — HTTP + SSE 服务（多副本）
- `deployment-scheduler.yaml` — 调度器（**单副本足够**；多副本也安全，靠 DB `FOR UPDATE SKIP LOCKED` 去重）

## 顺序

```sh
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml          # config.jsonc（按需改）
kubectl apply -f secret.example.yaml     # 改成真实值后 apply（勿提交真实密钥）
kubectl apply -f deployment-server.yaml
kubectl apply -f service.yaml
kubectl apply -f deployment-scheduler.yaml
# 运维目标集群的 kubectl ServiceAccount + RBAC（按需）：
kubectl apply -f ops-rbac.example.yaml
```

## 引导首个平台管理员

```sh
kubectl -n aiop exec deploy/aiop-server -- npm run start seed-admin default admin '强口令'
```

## 密钥

- `AIOP_JWT_SECRET`：会话 JWT 签名密钥，必须强随机。
- `MYSQL_PASSWORD_BASE64`：MySQL 口令的 base64（`echo -n 'pw' | base64`）。注意 base64 是编码非加密，仅避免明文直读；真正的机密保护靠 k8s Secret / 外部 KMS。
- `E2B_API_KEY` / `OIDC_CLIENT_SECRET`：按需。
