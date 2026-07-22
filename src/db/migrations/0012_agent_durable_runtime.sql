-- 0012_agent_durable_runtime：持久化人机交互与工具执行事实。

CREATE TABLE IF NOT EXISTS agent_interactions (
  id            VARCHAR(64)  NOT NULL,
  tenant_id     VARCHAR(64)  NOT NULL,
  user_id       VARCHAR(128) NOT NULL,
  session_id    VARCHAR(128) NOT NULL,
  run_id        VARCHAR(128) NOT NULL,
  kind          VARCHAR(32)  NOT NULL,
  tool_call_id  VARCHAR(128) NULL,
  payload       JSON         NOT NULL,
  status        VARCHAR(32)  NOT NULL,
  resolution    JSON         NULL,
  resolved_by   VARCHAR(128) NULL,
  expires_at    TIMESTAMP    NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at   TIMESTAMP    NULL,
  PRIMARY KEY (tenant_id, id),
  KEY idx_agent_interactions_pending (tenant_id, status, expires_at),
  KEY idx_agent_interactions_run (tenant_id, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_tool_executions (
  tenant_id     VARCHAR(64)  NOT NULL,
  run_id        VARCHAR(128) NOT NULL,
  session_id    VARCHAR(128) NOT NULL,
  tool_call_id  VARCHAR(128) NOT NULL,
  tool_name     VARCHAR(255) NOT NULL,
  args_digest   CHAR(64)     NOT NULL,
  status        VARCHAR(32)  NOT NULL,
  result        JSON         NULL,
  started_at    TIMESTAMP    NOT NULL,
  completed_at  TIMESTAMP    NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, run_id, tool_call_id),
  KEY idx_agent_tool_recovery (tenant_id, status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
