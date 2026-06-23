-- 0002_tenant_settings：租户级设置持久化。
-- LLM 设置当前使用 setting_key='llm.default'，config JSON 明文保存 apiKey。

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id   VARCHAR(64)  NOT NULL,
  setting_key VARCHAR(64)  NOT NULL,
  config      JSON         NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
