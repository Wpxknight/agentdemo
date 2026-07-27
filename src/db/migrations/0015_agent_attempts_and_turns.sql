-- 0015_agent_attempts_and_turns：Kernel 无关的 Attempt、Turn 快照与原子提交事实。

ALTER TABLE agent_runs
  ADD COLUMN kernel_version VARCHAR(64) NOT NULL DEFAULT 'legacy-v1' AFTER kernel,
  ADD COLUMN runtime_version VARCHAR(64) NOT NULL DEFAULT 'compat-v1' AFTER graph_version,
  ADD COLUMN waiting_reason VARCHAR(32) NULL AFTER status;

ALTER TABLE agent_interactions
  ADD COLUMN attempt_id VARCHAR(64) NULL AFTER run_id,
  ADD COLUMN turn_no INT NULL AFTER attempt_id,
  ADD KEY idx_agent_interactions_turn (tenant_id, run_id, attempt_id, turn_no);

CREATE TABLE IF NOT EXISTS agent_run_attempts (
  tenant_id      VARCHAR(64)  NOT NULL,
  run_id         VARCHAR(128) NOT NULL,
  attempt_id     VARCHAR(64)  NOT NULL,
  worker_id      VARCHAR(128) NOT NULL,
  lease_token    BIGINT       NOT NULL,
  kernel         VARCHAR(32)  NOT NULL,
  kernel_version VARCHAR(64)  NOT NULL,
  status         VARCHAR(32)  NOT NULL,
  error_code     VARCHAR(64)  NULL,
  error_message  TEXT         NULL,
  started_at     DATETIME(3)  NOT NULL,
  completed_at   DATETIME(3)  NULL,
  PRIMARY KEY (tenant_id, run_id, attempt_id),
  KEY idx_agent_run_attempt_status (tenant_id, status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_turn_snapshots (
  tenant_id          VARCHAR(64)  NOT NULL,
  run_id             VARCHAR(128) NOT NULL,
  attempt_id         VARCHAR(64)  NOT NULL,
  turn_no            INT          NOT NULL,
  session_version    BIGINT       NOT NULL,
  parent_commit_id   VARCHAR(64)  NULL,
  identity_json      JSON         NOT NULL,
  model_binding_json JSON         NOT NULL,
  prompt_version     VARCHAR(128) NOT NULL,
  skill_set_version  VARCHAR(128) NULL,
  tool_set_version   VARCHAR(128) NOT NULL,
  policy_version     VARCHAR(128) NOT NULL,
  messages_json      JSON         NOT NULL,
  deadline_at        DATETIME(3)  NULL,
  created_at         DATETIME(3)  NOT NULL,
  PRIMARY KEY (tenant_id, run_id, attempt_id, turn_no),
  KEY idx_agent_turn_snapshot_run (tenant_id, run_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_turn_commits (
  tenant_id          VARCHAR(64)  NOT NULL,
  run_id             VARCHAR(128) NOT NULL,
  attempt_id         VARCHAR(64)  NOT NULL,
  turn_no            INT          NOT NULL,
  commit_id          VARCHAR(64)  NOT NULL,
  transcript_version BIGINT       NOT NULL,
  stop_reason        VARCHAR(64)  NULL,
  usage_json         JSON         NOT NULL,
  messages_json      JSON         NOT NULL,
  event_sequence_end BIGINT       NOT NULL,
  committed_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (tenant_id, run_id, attempt_id, turn_no),
  UNIQUE KEY uq_agent_turn_commit_id (commit_id),
  KEY idx_agent_turn_commit_run (tenant_id, run_id, transcript_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
