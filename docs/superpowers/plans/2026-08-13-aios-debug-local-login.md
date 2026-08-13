# AIOS integrated 本地调试登录开发计划

1. 在 Runtime 中增加默认关闭且组合受限的 `AIOP_AIOS_DEBUG_LOCAL_LOGIN`，保留 AIOS 主 Provider，并按受信 JWT `provider` 唯一路由 Bearer 认证。
2. 开放匿名认证 capabilities；开关开启时允许 active local 用户使用 `/auth/login`，写安全 warn 与审计，用户管理能力保持关闭。
3. Web 由服务端 capabilities 决定是否显示“测试环境调试登录”，AIOS Host Adapter 复用现有登录 API 和 token 存储边界。
4. 提供 Secret/stdin 驱动的 Make 密码重置目标，只更新 `auth_provider=local` 用户，不输出密码或哈希。
5. 补齐默认关闭、错误凭据、来源隔离、JWT 唯一路由、关闭即失效、capabilities/UI 与部署契约测试；构建镜像并通过 Make 部署 166。
