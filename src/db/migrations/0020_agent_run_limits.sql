-- 0020_agent_run_limits：持久化 Run 预算，确保跨进程恢复继续执行相同限制。

ALTER TABLE agent_turn_snapshots
  ADD COLUMN limits_json JSON NULL AFTER policy_version;
