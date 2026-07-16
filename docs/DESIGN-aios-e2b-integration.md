# AIOP 接入 AIOS Sandbox Lifecycle

> 状态：设置页与数据库托管配置
>
> 范围：AIOP 通过 AIOS 的 E2B-compatible Lifecycle API 创建和使用沙箱。标准 E2B 路径继续可用；新增部署不再依赖启动时的 AIOS 静态密钥。

---

## 1. 目标与配置权威

Sandbox 连接是平台级运行设置，而不是 Pod 启动配置。管理员在 **Settings → Sandbox** 保存后，AIOP 以平台租户 `default` 持久化并热应用配置；切换后新调用进入新 generation，已经取得旧 generation 的调用和 handle 按原 provider 完成并继续回收。

| 配置来源 | 新部署 | 作用 |
| --- | --- | --- |
| Settings 页面 / `POST /v1/settings/sandbox` | 权威来源 | 保存启用状态、显式 backend mode、endpoint、placement 和默认 API key；适用于后续新调用。 |
| 数据库 | 权威存储 | 分开保存非敏感连接设置和加密默认 key；启动与重启恢复时优先读取。 |
| `AIOP_SETTINGS_SECRET` | 必需的部署 Secret | 保护数据库中保存的敏感设置字段；不得与 JWT 密钥复用。 |
| `config.jsonc` | 首次 bootstrap | 仅在数据库尚无 Sandbox 设置记录时转换并保存一次；之后页面/数据库配置优先。 |
| `AIOS_SANDBOX_KEY` / startup `sandbox.aios` | 旧版迁移输入 | 新部署不使用；完成页面迁移后必须从环境和部署清单移除。 |

backend mode 必须显式选择 `standard_e2b`、`aios_lifecycle`、`opensandbox` 或 `local`，不得通过 `domain`、主机名或环境变量猜测。标准 E2B 始终使用官方 SDK；只有 `aios_lifecycle` 才发送 AIOS Lifecycle 请求、固定模板和 structured placement。不要把 endpoint、placement、template 或 key 写入 ConfigMap、`.env` 或 Git。

## 2. 管理员配置流程

1. 通过受控的 Secret 管理系统为 AIOP 注入独立且强随机的 `AIOP_SETTINGS_SECRET`。
2. 部署 AIOP 和 MySQL。默认开发 ConfigMap 保持 `sandbox.enabled: false`，不会因空白配置而创建沙箱。
3. 以拥有 `tenant:manage` 权限的管理员登录，打开 **Settings → Sandbox**。
4. 选择 `AIOS Lifecycle`，填写 Lifecycle endpoint、placement cluster ID/namespace 和默认 API key，然后保存；AIOS runtime profile 固定为 `code-interpreter`，页面不允许提升或覆盖 runtime role。
5. 使用 `scripts/verify-aios-e2b.ts` 通过生产 Runtime/Manager 路径验证已保存的配置。

设置页返回状态和必要的非敏感连接信息，GET 只返回 `api_key_set`，绝不返回完整值或密文。API key 更新使用显式 `retain` / `replace` / `clear`：省略新值只能保留同一 credential target 的既有 key；mode 或 endpoint 改变时不得静默复用不可见 key；清除必须是显式动作。客户端、日志、审计事件、测试快照和验证脚本均不得显示完整 key 或请求认证头。

`AIOP_SETTINGS_SECRET` 只由服务进程读取。不得把它放入 ConfigMap、镜像层、命令行参数、shell history、日志、issue、补丁或版本库。轮换该密钥前必须按平台的设置加密迁移/恢复流程执行；未经验证的替换可能导致无法读取既有加密设置。

## 3. Lifecycle 契约映射

AIOS adapter 实现既有 `SandboxProvider` 与 `SandboxHandle` 契约，不改变公共 sandbox 类型。

| AIOP 操作 | Lifecycle API | 语义 |
| --- | --- | --- |
| `create` | `POST /sandboxes` | 发送设置页保存的模板、环境变量、metadata、placement 和以秒表示的 timeout。 |
| `connect` | `POST /sandboxes/:id/connect` | 按需续期 timeout，再检查沙箱可用。 |
| readiness | `POST /sandboxes/:id/commands`，执行 `true` | 创建或连接后确认命令可执行；创建中 `409` 有界重试。 |
| `runCommand` | `POST /sandboxes/:id/commands` | HTTP 200 的非零 `exitCode` 是命令结果，而不是传输错误。 |
| `runCode` | `POST /sandboxes/:id/commands` | 使用 base64 传递代码，按语言调用 `python3`、`node`、`bash` 或 `sh`。 |
| `readFile` | `POST /sandboxes/:id/filesystem/read` | 解码 API 返回的 base64 内容为 `Uint8Array`。 |
| `setTimeout` | `POST /sandboxes/:id/timeout` | 将毫秒转换为 `Math.max(1, Math.ceil(ms / 1000))` 秒。 |
| `kill` | `DELETE /sandboxes/:id` | 接受 `204`；重复清理时将“已不存在”视为成功。 |

模板和 placement 决定 AIOS runtime role。请求的 metadata、namespace 或 service account 不得覆盖设置页已保存的权限边界。

## 4. 错误、超时与输出

- 创建后 readiness 失败时，AIOP best-effort 调用 `DELETE` 清理新建沙箱，再返回失败。
- Lifecycle 命令的 HTTP `408` 表示命令超时。adapter 解析可用的部分 stdout、stderr 和 exit code，并返回 timeout error。
- 非 `2xx`、网络错误和响应解析错误转换为脱敏异常。错误、日志、审计事件和测试快照不得包含 `X-API-KEY`、完整 key 或完整敏感请求头。
- 携带认证头的 Lifecycle 请求禁止跟随 HTTP redirect，避免凭据转发到其他端点。
- Lifecycle API 不是实时流式 API。adapter 收到完整响应后，分别对非空 stdout 和 stderr 回调一次；调用方不得把它解释为实时输出。
- `runCode` 是命令 fallback，不承诺 Jupyter kernel、跨 cell 状态、富媒体或 notebook 语义。

## 5. Runtime generation 与并发不变量

设置更新使用串行的 prepare → persist → commit 流程，并在 shutdown 时先关闭更新入口、等待已经进入队列的更新，再销毁 Runtime。候选 generation 在持久化或 commit 失败时必须释放已准备的 WarmPool 等资源，不能替换当前工具和 resolver。

每个 generation 原子拥有 manager/provider、profiles、spec resolver、Desktop resolver 和清理状态：

- 调用开始时固定 generation；异步 profile/spec 解析完成后仍使用同一 generation 的 provider。切换后的新调用只进入新 generation。
- 普通切换是 soft drain，不强杀已有 handle。旧 generation 继续 session/idle sweep，直到 operations、active、inflight、cleanup 和 Desktop cache 全部为空后才释放资源。
- 会话删除和进程关闭是 hard cleanup。匹配的 in-flight Sandbox/Desktop create 即使晚完成，也必须自毁且不得重新进入 cache。
- rejected Desktop create 不缓存，后续调用可重试；tenant/user/session identity epoch 防止删除后的同名会话被晚结果复活。
- `SandboxManager.sweep()` 合并重叠调用，并在所有 kill 完成前报告 cleanup activity，避免 generation 资源过早释放。
- WarmPool drain 先关闭入口并清理 ready handles，只有界等待正在执行的 refill；超时后返回，晚到 handle 仍由 refill 的 closed 检查销毁。
- 凭据污染标记绑定到实际 acquire 的 generation/spec，不跨 generation 按 key 猜测。

## 6. 部署与验证

部署前，确认 `AIOP_SETTINGS_SECRET` 已通过 Secret 注入，并且其值独立于 `AIOP_JWT_SECRET`。不要通过 `kubectl get secret ... -o yaml`、`kubectl describe secret` 或 base64 解码来检查或打印任何 Secret。

保存 AIOS 设置后，在 AIOP Pod 内运行：

```sh
kubectl -n aiop-dev exec deploy/aiop-server -c aiop -- npx tsx scripts/verify-aios-e2b.ts
```

该脚本：

1. 加载生效的 Runtime 设置，并拒绝未启用、非 E2B 或无 AIOS Lifecycle 配置的环境；
2. 创建沙箱并确认 readiness；
3. 验证 command、Python code fallback、写入/读取文件和 timeout；
4. 无论成功或失败，都在 `finally` 中销毁创建的沙箱；
5. 仅输出步骤状态和 sandbox ID，绝不输出 credential 或认证头。

标准 E2B mock 回归也必须运行，确保 AIOS 设置不会改变官方 E2B create/connect 参数形状，也不会向标准路径发送 AIOS placement。

## 7. Bootstrap 兼容与迁移

早期部署可能使用 `config.jsonc` 中的 `sandbox.aios`、`${AIOS_SANDBOX_KEY}` 和固定 placement。当前启动配置仅在数据库尚无 Sandbox 设置记录时作为一次性 bootstrap 保存；数据库已有记录后，Settings/DB 始终优先，页面更新不需要重启。

迁移步骤：

1. 在 Settings 页面保存与旧部署等价的 AIOS Lifecycle 配置，并由授权管理员验证。
2. 运行 smoke script，确认新建沙箱使用已保存设置并能完成清理。
3. 从 ConfigMap、Secret 和环境清单移除 `sandbox.aios`、`sandbox.apiKey: "${AIOS_SANDBOX_KEY}"` 及 `AIOS_SANDBOX_KEY`。
4. 重启 AIOP，确认数据库设置恢复，页面修改继续影响后续新建沙箱。

新部署不得新增 `AIOS_SANDBOX_KEY`。不要将 AIOS key 复用于标准 `E2B_API_KEY`，也不要把标准 E2B key 发送给 AIOS Lifecycle。

## 8. 后续工作

用户级凭据、Data Plane/Jupyter、Desktop/browser、更多模板和跨集群控制面发现需要独立设计。它们不能通过放宽设置权限、模板 runtime role 或凭据边界实现。
