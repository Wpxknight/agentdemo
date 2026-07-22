-- 0011_langgraph_checkpoints：LangGraph 单次 run 执行快照与 pending writes。

CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
  tenant_id            VARCHAR(64)  NOT NULL,
  thread_id            VARCHAR(128) NOT NULL,
  checkpoint_ns        VARCHAR(255) NOT NULL DEFAULT '',
  checkpoint_id        VARCHAR(128) NOT NULL,
  parent_checkpoint_id VARCHAR(128) NULL,
  checkpoint_type      VARCHAR(32)  NOT NULL,
  checkpoint_data      LONGBLOB     NOT NULL,
  metadata_type        VARCHAR(32)  NOT NULL,
  metadata_data        LONGBLOB     NOT NULL,
  run_id               VARCHAR(128) NOT NULL,
  graph_name           VARCHAR(64)  NOT NULL,
  graph_version        VARCHAR(64)  NOT NULL,
  expires_at           TIMESTAMP    NULL,
  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, thread_id, checkpoint_ns, checkpoint_id),
  KEY idx_lg_checkpoint_tenant_run (tenant_id, run_id),
  KEY idx_lg_checkpoint_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
  tenant_id       VARCHAR(64)  NOT NULL,
  thread_id       VARCHAR(128) NOT NULL,
  checkpoint_ns   VARCHAR(255) NOT NULL DEFAULT '',
  checkpoint_id   VARCHAR(128) NOT NULL,
  task_id         VARCHAR(128) NOT NULL,
  write_index     INT          NOT NULL,
  channel         VARCHAR(255) NOT NULL,
  value_type      VARCHAR(32)  NOT NULL,
  value_data      LONGBLOB     NOT NULL,
  PRIMARY KEY (tenant_id, thread_id, checkpoint_ns, checkpoint_id, task_id, write_index),
  KEY idx_lg_writes_tenant (tenant_id, thread_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
