-- 0017_agent_run_event_sequence：为每个 Run 分配可断点补发的单调 durable sequence。

ALTER TABLE agent_run_events ADD COLUMN sequence BIGINT NULL AFTER run_id;

UPDATE agent_run_events AS target
JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id, run_id ORDER BY id) AS run_sequence
  FROM agent_run_events
) AS ranked ON ranked.id = target.id
SET target.sequence = ranked.run_sequence;

ALTER TABLE agent_run_events
  MODIFY COLUMN sequence BIGINT NOT NULL,
  ADD UNIQUE KEY uq_agent_run_event_sequence (tenant_id, run_id, sequence),
  ADD KEY idx_agent_run_events_resume (tenant_id, run_id, sequence);
