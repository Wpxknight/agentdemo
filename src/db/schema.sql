-- aiop 持久化迁移（MySQL 8.0+）。幂等：IF NOT EXISTS。
-- 后续阶段在此追加 scheduled_tasks/task_runs（S6）、tenants/users 与各表 tenant_id（S7）。

CREATE TABLE IF NOT EXISTS messages (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  session_id  VARCHAR(128) NOT NULL,
  role        VARCHAR(16)  NOT NULL,
  content     JSON         NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_messages_session (session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  kind        VARCHAR(16)  NOT NULL,
  action      VARCHAR(32)  NOT NULL,
  session_id  VARCHAR(128) NULL,
  cluster     VARCHAR(128) NULL,
  tool        VARCHAR(64)  NULL,
  detail      JSON         NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_session (session_id, id),
  KEY idx_audit_kind (kind, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
