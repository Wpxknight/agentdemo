-- 0013_agent_run_bindings：锁定单次 run 的 kernel 与 graph version，避免恢复时漂移。

CREATE TABLE IF NOT EXISTS agent_runs (
  tenant_id    VARCHAR(64)  NOT NULL,
  run_id       VARCHAR(128) NOT NULL,
  user_id      VARCHAR(128) NOT NULL,
  session_id   VARCHAR(128) NOT NULL,
  kernel       VARCHAR(32)  NOT NULL,
  graph_name   VARCHAR(64)  NOT NULL,
  graph_version VARCHAR(64) NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, run_id),
  KEY idx_agent_runs_session (tenant_id, user_id, session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
