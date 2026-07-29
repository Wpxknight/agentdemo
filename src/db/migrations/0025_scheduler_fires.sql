-- 0025_scheduler_fires：持久化每次调度触发、Worker 租约和产品 Run 关联，支持崩溃补偿。

CREATE TABLE IF NOT EXISTS scheduler_fires (
  fire_id          VARCHAR(255) NOT NULL,
  task_id          BIGINT       NOT NULL,
  tenant_id        VARCHAR(64)  NOT NULL,
  actor_id         VARCHAR(128) NOT NULL,
  session_id       VARCHAR(128) NOT NULL,
  fire_time        DATETIME(3)  NOT NULL,
  input_json       JSON         NOT NULL,
  state            VARCHAR(16)  NOT NULL,
  attempts         INT          NOT NULL DEFAULT 0,
  run_id           VARCHAR(128) NULL,
  claim_token      VARCHAR(64)  NULL,
  claim_owner      VARCHAR(128) NULL,
  lease_expires_at DATETIME(3)  NULL,
  retry_at         DATETIME(3)  NULL,
  last_error       TEXT         NULL,
  created_at       DATETIME(3)  NOT NULL,
  updated_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (fire_id),
  KEY idx_scheduler_fires_claim (state, retry_at, fire_time),
  KEY idx_scheduler_fires_lease (state, lease_expires_at),
  KEY idx_scheduler_fires_task (tenant_id, task_id, fire_time),
  KEY idx_scheduler_fires_run (tenant_id, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
