-- 0010_setting_secrets：平台设置凭据独立加密存储。
-- tenant_settings.config 只保存非敏感设置；payload 是 AES-256-GCM 不透明密文。

CREATE TABLE IF NOT EXISTS setting_secrets (
  tenant_id   VARCHAR(64)  NOT NULL,
  setting_key VARCHAR(64)  NOT NULL,
  payload     TEXT         NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
