-- 0016_agent_tool_ledger_v2：跨 Attempt 稳定逻辑调用、幂等与外部副作用恢复事实。

ALTER TABLE agent_tool_executions
  ADD COLUMN attempt_id VARCHAR(64) NULL AFTER run_id,
  ADD COLUMN turn_no INT NULL AFTER attempt_id,
  ADD COLUMN logical_call_id VARCHAR(128) NULL AFTER tool_call_id,
  ADD COLUMN idempotency_key VARCHAR(255) NULL AFTER logical_call_id,
  ADD COLUMN capability VARCHAR(32) NOT NULL DEFAULT 'non_idempotent_write' AFTER idempotency_key,
  ADD COLUMN external_correlation_id VARCHAR(255) NULL AFTER capability,
  ADD COLUMN result_digest CHAR(64) NULL AFTER external_correlation_id,
  ADD COLUMN approved_interaction_id VARCHAR(64) NULL AFTER result_digest;

UPDATE agent_tool_executions
SET logical_call_id = tool_call_id,
    idempotency_key = CONCAT(tenant_id, ':', run_id, ':', tool_call_id)
WHERE logical_call_id IS NULL OR idempotency_key IS NULL;

ALTER TABLE agent_tool_executions
  MODIFY COLUMN logical_call_id VARCHAR(128) NOT NULL,
  MODIFY COLUMN idempotency_key VARCHAR(255) NOT NULL,
  ADD UNIQUE KEY uq_agent_tool_logical_call (tenant_id, run_id, logical_call_id),
  ADD KEY idx_agent_tool_external_correlation (tenant_id, external_correlation_id);
