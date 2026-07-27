-- 0018_scheduler_agent_run_links：Scheduler 只创建 Run，通过独立关系表记录任务关联。

CREATE TABLE IF NOT EXISTS task_agent_runs (
  tenant_id VARCHAR(64) NOT NULL,
  task_id BIGINT NOT NULL,
  run_id VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (tenant_id, task_id, run_id),
  KEY idx_task_agent_runs_run (tenant_id, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
