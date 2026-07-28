-- 0023_pi_session_and_run_inbox：Pi 会话树、提交水位线与跨 Worker durable inbox。
-- 仅新增结构；旧应用可安全忽略。

CREATE TABLE IF NOT EXISTS pi_sessions (
  tenant_id         VARCHAR(64)  NOT NULL,
  session_id        VARCHAR(128) NOT NULL,
  current_leaf_id   VARCHAR(64)  NULL,
  committed_leaf_id VARCHAR(64)  NULL,
  metadata_json     JSON         NULL,
  created_at        DATETIME(3)  NOT NULL,
  updated_at        DATETIME(3)  NOT NULL,
  PRIMARY KEY (tenant_id, session_id),
  KEY idx_pi_sessions_updated (tenant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pi_session_entries (
  tenant_id  VARCHAR(64)  NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  entry_id   VARCHAR(64)  NOT NULL,
  entry_seq  BIGINT       NOT NULL,
  parent_id  VARCHAR(64)  NULL,
  entry_type VARCHAR(32)  NOT NULL,
  entry_json JSON         NOT NULL,
  created_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (tenant_id, session_id, entry_id),
  UNIQUE KEY uq_pi_session_entry_seq (tenant_id, session_id, entry_seq),
  KEY idx_pi_session_entry_parent (tenant_id, session_id, parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_run_inbox_messages (
  tenant_id       VARCHAR(64)  NOT NULL,
  run_id          VARCHAR(128) NOT NULL,
  message_id      VARCHAR(64)  NOT NULL,
  sequence        BIGINT       NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  mode            VARCHAR(16)  NOT NULL,
  message_json    JSON         NOT NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'pending',
  claim_owner     VARCHAR(128) NULL,
  claim_token     VARCHAR(64)  NULL,
  claim_expires_at DATETIME(3) NULL,
  created_at      DATETIME(3)  NOT NULL,
  consumed_at     DATETIME(3)  NULL,
  PRIMARY KEY (tenant_id, run_id, message_id),
  UNIQUE KEY uq_agent_run_inbox_idempotency (tenant_id, run_id, idempotency_key),
  UNIQUE KEY uq_agent_run_inbox_sequence (tenant_id, run_id, sequence),
  KEY idx_agent_run_inbox_status (tenant_id, run_id, status, sequence),
  KEY idx_agent_run_inbox_expiry (tenant_id, status, claim_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE agent_turn_commits
  ADD COLUMN pi_session_id VARCHAR(128) NULL AFTER turn_no,
  ADD COLUMN pi_leaf_id VARCHAR(64) NULL AFTER pi_session_id,
  ADD COLUMN pi_entry_seq BIGINT NULL AFTER pi_leaf_id,
  ADD KEY idx_agent_turn_pi_session (tenant_id, pi_session_id, pi_entry_seq);
