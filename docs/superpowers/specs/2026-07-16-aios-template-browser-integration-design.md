# AIOS 动态模板目录与 Browser 集成设计

> 日期：2026-07-16
>
> 范围：同时修改 AIOP 和 `aios-sandbox-server`。AIOP 展示 AIOS 返回的全部授权模板，并通过 AIOS Lifecycle 支持 browser 模板的预览、导航、点击、输入、当前 URL 和截图能力。

## 1. 目标

1. AIOP 不再为 `aios_lifecycle` 固定生成 `code-interpreter` Profile，而是从 AIOS E2B 兼容接口动态获取所有启用模板。
2. 普通用户可查看和使用 `sandbox-reader` 模板；`sandbox-diag` 模板仅 `platform_admin` 可见、可用。
3. `envType=browser` 的模板接入 AIOP 现有浏览器预览与操作接口，不公开 AIOS Key、CDP、noVNC 或 Kubernetes 端点。
4. 模板目录、Provider、Profile resolver 和 Desktop resolver 归属于同一个 Runtime generation，设置切换和目录刷新不产生跨 generation 错配。
5. 标准 E2B SDK 和非 AIOS Sandbox 后端保持兼容。

## 2. 非目标

- 不把 AIOS 原生管理平台 Token 保存到 AIOP Sandbox 设置。
- 不在 AIOP 中直接调用 AIOS 原生 `/api/v1/sandbox/templates` 或实例管理接口。
- 不直接嵌入 AIOS noVNC，不对外开放 CDP 9222。
- 不允许客户端通过 metadata、ServiceAccount、RBAC、securityContext、hostNetwork、hostPID 或 hostPath 覆盖模板权限。
- 不把 `sandbox-diag` 开放给普通用户或租户管理员。
- 不为模板目录增加新的数据库表；目录由 AIOS 管理，AIOP 只维护当前内存快照。

## 3. AIOS E2B 模板接口扩展

AIOS 保留 `GET /templates` 的现有标准 E2B 顶层字段，并为每条启用模板增加可选的 `aios` 扩展对象：

```json
{
  "templateID": "browser-template-id",
  "names": ["browser"],
  "aliases": ["browser", "browser-template-id"],
  "buildStatus": "ready",
  "aios": {
    "description": "浏览器沙箱",
    "envType": "browser",
    "runtimeRole": "sandbox-reader",
    "image": "aiop/opensandbox-browser:dev",
    "defaultTimeoutHours": 2
  }
}
```

扩展字段规则：

- `envType` 仅为 `code` 或 `browser`。
- `runtimeRole` 仅为 `sandbox-reader` 或 `sandbox-diag`；空值按 AIOS 既有规则规范化为 `sandbox-reader`。
- `templateID` 是 AIOP 创建请求使用的稳定唯一选择器。
- `description`、`image` 和 `defaultTimeoutHours` 仅用于展示、能力推导或默认超时；调用方不能覆盖 Runtime Role。
- `GET /templates` 继续只返回 `status=1` 的模板。
- 新字段为可选字段，标准 E2B 客户端会忽略它们；现有标准字段及响应顶层数组形状不变。

AIOS 的 E2B create 继续按模板名后模板 ID 解析。本集成由 AIOP 发送 `templateID`，避免重名模板歧义。

## 4. AIOP 模板目录客户端

新增独立的 `AiosTemplateCatalog`，与 Lifecycle Provider 共享 AIOS 请求安全规则：

- 使用页面保存并解密的同一个 Sandbox Key。
- 请求 `${lifecycleUrl}/templates`。
- 使用 `X-API-KEY`，禁止跟随 redirect。
- 使用有界请求超时。
- 非 2xx、网络错误和 JSON 校验错误转换为不含 Key、认证头或敏感响应体的错误。
- 校验 `templateID`、`names`、`buildStatus` 和 `aios` 元数据。
- 仅接受 `buildStatus=ready` 且含有效 AIOS 扩展的模板；格式错误条目被忽略并记录脱敏告警。
- 以 `templateID` 去重，按展示名和 `templateID` 稳定排序。
- 计算不包含 Key 的目录指纹，用于判断目录刷新是否需要生成新 generation。

目录查询是运行配置准备的一部分。设置保存时如果目录查询失败，候选 generation 必须释放，设置不得持久化，现有 generation 保持不变。

启动恢复时，如果已保存的 AIOS 设置无法查询目录：

- AIOP 服务仍可启动；
- Sandbox Runtime 不启用；
- 设置状态返回 `catalog_unavailable`；
- 不回退到固定或猜测的模板；
- 管理员修复连接或刷新成功后再安装 generation。

## 5. Profile 模型

`SandboxProfile` 增加明确的模板与权限元数据，避免继续把 `image` 同时当作模板选择器：

```ts
interface SandboxProfile {
  id: string;
  name: string;
  template?: string;
  description: string;
  envType: 'code' | 'browser';
  runtimeRole: 'sandbox-reader' | 'sandbox-diag';
  image?: string;
  desktop: boolean;
  privileged: boolean;
  capabilities: string[];
  // existing optional fields remain
}
```

兼容规则：

- 本地、标准 E2B 和 OpenSandbox 的已有配置 Profile 自动使用 `id=name`。
- 非 AIOS Profile 默认 `envType=browser`（当 `desktop=true`）或 `code`，默认 `runtimeRole=sandbox-reader`。
- 公共 DTO 增加 `id`、`template`、`envType`、`runtimeRole`，不删除现有字段。
- `sandboxSpecForProfile()` 使用 `profile.template ?? profile.image` 作为创建模板；AIOS Profile 始终设置 `templateID`。

AIOS 能力映射：

- `code`：`python`、`node`、`shell`。
- `browser`：`browser`、`screenshot`、`navigate`、`click`、`type`，并保留 `shell` 命令能力。
- `sandbox-diag`：增加 `diagnostics` 能力和 `privileged=true` 展示标记，但不生成任何权限覆盖字段。

Profile ID 使用 `templateID`。名称只用于展示，重复名称不会覆盖 Profile。

## 6. 可见性与授权

模板可见性由后端基于请求身份计算：

- `sandbox-reader`：`platform_admin`、`tenant_admin`、`user` 均可见、可用。
- `sandbox-diag`：仅 `platform_admin` 可见、可用。

保护分为三层：

1. `GET /v1/sandboxes` 根据 `RequestContext.role` 过滤返回的 Profile。
2. `SandboxRuntimeController.acquire(ctx, profileId)` 在 Profile 解析后强制检查 Runtime Role。
3. `AiosE2bProvider` 只允许当前 generation 目录快照中的 `templateID`。

前端隐藏不是授权边界。直接调用运行代码、运行命令或 Profile ensure 接口也必须经过相同检查。

默认 Profile 选择：

- 代码调用优先名称为 `code-interpreter` 的 `code` Profile；否则选择稳定排序后的第一个可授权 `code` Profile。
- Browser 调用优先名称为 `browser` 的 `browser` Profile；否则选择稳定排序后的第一个可授权 `browser` Profile。
- 如果当前身份没有合适 Profile，返回明确的“没有可用模板”错误，不回退到无关模板。

## 7. Runtime generation 与目录刷新

每个 generation 原子拥有：

- AIOS 模板目录快照；
- 由快照构造的 Profile；
- 允许模板 ID 集合；
- `AiosE2bProvider`；
- Sandbox spec resolver；
- Browser Desktop resolver；
- SandboxManager 和清理状态。

设置保存流程仍为：

```text
query catalog → prepare generation → persist settings → commit generation
```

后台目录刷新：

- 仅 `aios_lifecycle` 启用时运行。
- 默认每 60 秒查询一次；定时器必须 `unref`，并在模式切换和 Runtime dispose 时清理。
- 查询失败时保留当前成功快照和 generation，记录脱敏告警，不切换到空目录。
- 指纹不变时不创建 generation。
- 指纹变化时串行进入与设置更新相同的 prepare/commit 队列，避免目录刷新与管理员设置更新竞态。
- 新调用使用新快照；已经固定旧 generation 的调用和 handle 继续完成并按旧 generation 回收。

提供平台管理员接口：

```text
POST /v1/settings/sandbox/refresh-templates
```

该接口立即查询当前 AIOS 设置并在目录变化时切换 generation；返回非敏感的刷新状态和可见模板数量。

模板从目录移除后，新 generation 不允许新建该模板。旧 generation 中已有沙箱不被强制删除，继续按 session、idle 或 shutdown 规则回收。

## 8. Browser Desktop 实现

AIOS browser 模板仍通过 Lifecycle 创建：

```text
POST /sandboxes
{
  "template": "<browser-template-id>",
  "placement": { ... }
}
```

AIOP 新增或复用命令驱动的 Desktop Provider：

- Desktop resolver 选择当前身份可授权的 browser Profile。
- Desktop Provider 通过同一个 generation 的 SandboxManager 获取 browser SandboxHandle。
- 所有浏览器动作通过 Lifecycle `/commands` 在沙箱内访问 `127.0.0.1:9222`。
- 优先复用 browser 镜像已经启动的 Chrome/CDP；如果 9222 未就绪，则使用现有 Chrome/Xvfb 启动逻辑。
- 实现 `launch`、`currentUrl`、`leftClick`、`write` 和 `screenshot`。
- `startStream` 继续返回 AIOP 自身的 screenshot-view URL，不返回 AIOS 原生 endpoint。

继续复用现有 AIOP HTTP 表面：

```text
POST /v1/browser/stream
POST /v1/browser/navigate
POST /v1/browser/click
POST /v1/browser/type
POST /v1/browser/screenshot
POST /v1/browser/url
GET  /v1/browser/stream-view
```

`stream-view` 每两秒调用已认证的 AIOP screenshot 接口并刷新 iframe 图像。AIOS Key、noVNC 地址、CDP 地址和 Kubernetes Service 信息不进入浏览器、页面状态或 API 响应。

Desktop 生命周期继续遵循 generation pin、session epoch、rejected Promise eviction、late-result kill 和 hard shutdown 规则。

## 9. 页面行为

Sandbox 页的“沙箱模板”展示后端为当前身份返回的全部 Profile：

- 显示名称、描述、模板 ID、镜像、环境类型、Runtime Role 和能力。
- Browser 模板显示“浏览器”标记。
- `sandbox-diag` 仅平台管理员能收到，并显示醒目的“特权诊断”标记。
- 普通用户不会看到 `netdig` 等诊断模板，也不能通过手工 API 参数使用。

设置页显示目录状态：

- `active`：目录已加载；
- `catalog_unavailable`：当前设置无法加载目录；
- `refreshing`：管理员触发刷新中；
- 最近一次成功刷新时间和模板数量，不显示 Key 或目录请求头。

本阶段不增加 noVNC 切换按钮；现有浏览器预览、刷新截图和 Agent browser 工具保持原交互。

## 10. 错误处理与安全

- 完整 API Key 不进入日志、错误、公共 DTO、测试快照、设计文档或前端状态。
- 模板和 Lifecycle 请求禁止 redirect。
- 目录响应设置大小上限，避免异常服务返回无限响应。
- 模板描述和名称作为纯文本渲染，不能注入 HTML。
- AIOS 扩展字段缺失或非法的模板不进入可用目录。
- browser 模板缺少 Chrome、Node、Xvfb 或 CDP 时返回可读错误，并由正常会话清理回收沙箱。
- `sandbox-diag` 的授权判断只信任 AIOP 服务端验证后的 `RequestContext.role`。
- AIOP 不向 Generic Key 请求发送 AIOS resource group 字段；structured placement 继续必填。
- 目录刷新不得改变 credential target，也不得静默复用另一个 endpoint 的 Key。

## 11. 测试与验证

### AIOS 单元与契约测试

1. `GET /templates` 仍返回顶层数组和全部既有标准字段。
2. `aios` 扩展准确映射 `description/envType/runtimeRole/image/defaultTimeoutHours`。
3. 只返回启用模板；空 Runtime Role 规范化为 `sandbox-reader`。
4. 标准 E2B create/list 测试不回退。

### AIOP 单元与并发测试

1. Catalog 解析、去重、排序、超时、redirect 拒绝、响应大小和错误脱敏。
2. 三个 AIOS 模板转换为三个 Profile。
3. 普通用户只看到 reader 模板；平台管理员看到 reader 和 diag 模板。
4. 普通用户直接指定 diag Profile 时后端拒绝，Provider 不收到 create。
5. Provider 拒绝目录快照外模板。
6. browser Profile 创建时发送正确 `templateID` 和 structured placement。
7. browser Desktop 通过同一 manager handle 完成 navigate/click/type/currentUrl/screenshot。
8. 目录刷新与设置更新并发时不产生 provider/profile 错配。
9. 目录刷新失败保留旧 generation；目录变化只提交一次新 generation。
10. 重启加载目录失败时 Runtime 状态为 `catalog_unavailable`，AIOP 仍可启动。
11. 标准 E2B SDK 参数形状及非 AIOS后端 Profile 兼容测试继续通过。

### 前端测试

1. 模板计数和卡片反映 API 返回数量。
2. Browser 和特权诊断标记正确。
3. 普通用户响应中没有诊断模板。
4. 现有浏览器预览加载和截图刷新流程继续工作。

### 运行时验证

1. AIOS 管理目录有 `browser`、`netdig`、`code-interpreter` 时，AIOP 平台管理员看到三项，普通用户看到两项 reader 模板。
2. `code-interpreter` 完成代码、命令和文件操作。
3. `browser` 完成创建、预览、导航、点击、输入、当前 URL 和截图。
4. 普通用户尝试 `netdig` 被 AIOP 拒绝；平台管理员可以创建并使用。
5. 新增、禁用或删除 AIOS 模板后，手动/定时刷新使 AIOP 目录一致。
6. 设置切换、Pod 重启和目录临时不可用不泄漏 Key、不遗留临时 Sandbox。

## 12. 关键实现位置

AIOS：

- `internal/e2b/dto.go`
- `internal/e2b/template.go`
- `internal/e2b/template_test.go`
- `internal/e2b/controller_test.go`

AIOP：

- 新增 `src/sandbox/aios-template-catalog.ts`
- `src/sandbox/aios-e2b.ts`
- `src/sandbox/profiles.ts`
- `src/sandbox/settings.ts`
- `src/sandbox/runtime-controller.ts`
- `src/sandbox/opensandbox-desktop.ts`（抽取可复用 command-driven Desktop handle）
- `src/runtime.ts`
- `src/server/http.ts`
- `web/src/App.tsx`
- `web/src/types.ts`
- 对应 Sandbox、Runtime、HTTP、Frontend 和 AIOS adapter 测试
