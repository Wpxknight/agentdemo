# Sandbox Default Placement Implementation Plan

1. 为 AIOS Lifecycle 沙箱设置补充默认 placement 常量、规范化、持久化及公共 HTTP 字段，兼容没有 placement 的历史记录。
2. 修改 placement 合并逻辑，支持用户只指定集群、只指定 namespace 或同时指定，并按字段使用平台默认值补齐。
3. 在沙箱设置页面增加“默认集群 ID”和“默认命名空间”，默认值为 `1`、`aios-system`，接入读取与保存。
4. 更新 HTTP 参数校验及工具描述，使 namespace-only 请求可由运行时默认集群补齐，双集群选择器输入按 `clusterId` 优先收敛。
5. 增加设置、placement、runtime 和前端回归测试，运行 typecheck、前端构建及全量测试。
6. 使用 Make 构建并部署到 166，验证设置 API、运行镜像、健康状态和默认值。
