-- 0008_user_credentials：用户下游平台凭据缓存（AIOS 集成 P3，§3.2）。
-- payload 为 AES-256-GCM 加密后的 JSON（密钥由服务端 AIOP_JWT_SECRET 派生），永不明文落库。
-- 与 users 表分离：短期凭据，随登录刷新/过期清除，不属于用户档案。

CREATE TABLE IF NOT EXISTS user_credentials (
  tenant_id  VARCHAR(64)  NOT NULL,
  user_id    VARCHAR(64)  NOT NULL,
  provider   VARCHAR(32)  NOT NULL,
  payload    TEXT         NOT NULL,
  expires_at TIMESTAMP    NULL,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
