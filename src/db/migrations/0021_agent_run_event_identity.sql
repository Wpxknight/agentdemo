-- 0021_agent_run_event_identity：为 Durable Runtime 事件持久化完整观测身份。

ALTER TABLE agent_run_events
  ADD COLUMN attempt_id VARCHAR(128) NULL AFTER sequence,
  ADD COLUMN turn_no INT NULL AFTER attempt_id,
  ADD COLUMN kernel VARCHAR(32) NULL AFTER turn_no,
  ADD COLUMN kernel_version VARCHAR(64) NULL AFTER kernel,
  ADD COLUMN correlation_id VARCHAR(128) NULL AFTER kernel_version,
  ADD KEY idx_agent_run_event_attempt (tenant_id, run_id, attempt_id, turn_no),
  ADD KEY idx_agent_run_event_correlation (tenant_id, correlation_id);
