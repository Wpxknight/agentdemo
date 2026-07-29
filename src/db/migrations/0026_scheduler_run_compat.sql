-- 0026_scheduler_run_compat：持久化 Run 执行模式，并为 Scheduler 兼容历史提供幂等关联键。

ALTER TABLE agent_runs
  ADD COLUMN execution_json JSON NULL AFTER limits_json;

ALTER TABLE task_runs
  ADD COLUMN fire_id VARCHAR(255) NULL AFTER task_id,
  ADD COLUMN run_id VARCHAR(128) NULL AFTER fire_id,
  ADD UNIQUE KEY uniq_task_runs_fire (fire_id);
