-- aiop 持久化迁移（MySQL 8.0+）。幂等：IF NOT EXISTS。
-- 多租户：业务表均带 tenant_id；tenants/users 见文末（S7）。

CREATE TABLE IF NOT EXISTS messages (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id   VARCHAR(64)  NOT NULL,
  session_id  VARCHAR(128) NOT NULL,
  role        VARCHAR(16)  NOT NULL,
  content     JSON         NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_messages_session (tenant_id, session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id   VARCHAR(64)  NULL,
  kind        VARCHAR(16)  NOT NULL,
  action      VARCHAR(32)  NOT NULL,
  session_id  VARCHAR(128) NULL,
  cluster     VARCHAR(128) NULL,
  tool        VARCHAR(64)  NULL,
  detail      JSON         NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_session (tenant_id, session_id, id),
  KEY idx_audit_kind (tenant_id, kind, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  tenant_id    VARCHAR(64)  NOT NULL,
  user_id      VARCHAR(64)  NOT NULL,
  session_id   VARCHAR(128) NOT NULL,
  cron         VARCHAR(128) NOT NULL,
  task         TEXT         NOT NULL,
  pre_approved TINYINT(1)   NOT NULL DEFAULT 0,
  enabled      TINYINT(1)   NOT NULL DEFAULT 1,
  next_run_at  TIMESTAMP    NOT NULL,
  last_run_at  TIMESTAMP    NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_due (enabled, next_run_at),
  KEY idx_tenant (tenant_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_runs (
  id          BIGINT      NOT NULL AUTO_INCREMENT,
  task_id     BIGINT      NOT NULL,
  status      VARCHAR(16) NOT NULL,
  detail      TEXT        NULL,
  steps       INT         NULL,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_runs_task (task_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenants (
  id          VARCHAR(64)  NOT NULL,
  name        VARCHAR(128) NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(64)  NOT NULL,
  tenant_id     VARCHAR(64)  NOT NULL,
  username      VARCHAR(128) NOT NULL,
  role          VARCHAR(32)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user (tenant_id, username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
