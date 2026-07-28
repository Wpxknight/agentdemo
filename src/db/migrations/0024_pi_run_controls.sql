-- 0024_pi_run_controls：Durable Pi Run limits、cost 与 append cutoff。
-- 独立于已发布的 0023，确保已记录 0023 的数据库仍能获得新增控制列。

ALTER TABLE agent_runs
  ADD COLUMN cost_usd DECIMAL(18,8) NULL AFTER cache_creation_tokens,
  ADD COLUMN limits_json JSON NULL AFTER cost_usd,
  ADD COLUMN append_closed_at DATETIME(3) NULL AFTER lease_expires_at,
  ADD KEY idx_agent_runs_session_status (tenant_id, session_id, status);
