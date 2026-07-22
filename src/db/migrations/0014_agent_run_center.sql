-- 0014_agent_run_center：运行中心生命周期、节点时间线与多副本租约。

ALTER TABLE agent_runs
  ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'succeeded' AFTER graph_version,
  ADD COLUMN current_node VARCHAR(64) NULL AFTER status,
  ADD COLUMN step_count INT NOT NULL DEFAULT 0 AFTER current_node,
  ADD COLUMN input_tokens INT NOT NULL DEFAULT 0 AFTER step_count,
  ADD COLUMN output_tokens INT NOT NULL DEFAULT 0 AFTER input_tokens,
  ADD COLUMN cache_read_tokens INT NOT NULL DEFAULT 0 AFTER output_tokens,
  ADD COLUMN cache_creation_tokens INT NOT NULL DEFAULT 0 AFTER cache_read_tokens,
  ADD COLUMN error_message TEXT NULL AFTER cache_creation_tokens,
  ADD COLUMN started_at DATETIME(3) NULL AFTER error_message,
  ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER started_at,
  ADD COLUMN completed_at DATETIME(3) NULL AFTER updated_at,
  ADD COLUMN cancel_requested_at DATETIME(3) NULL AFTER completed_at,
  ADD COLUMN lease_owner VARCHAR(128) NULL AFTER cancel_requested_at,
  ADD COLUMN lease_token BIGINT NOT NULL DEFAULT 0 AFTER lease_owner,
  ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER lease_token,
  ADD KEY idx_agent_runs_status (tenant_id, status, updated_at),
  ADD KEY idx_agent_runs_lease (lease_expires_at);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id   VARCHAR(64)  NOT NULL,
  run_id      VARCHAR(128) NOT NULL,
  event_type  VARCHAR(64)  NOT NULL,
  node_name   VARCHAR(64)  NULL,
  status      VARCHAR(32)  NULL,
  detail      JSON         NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_agent_run_events_run (tenant_id, run_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
