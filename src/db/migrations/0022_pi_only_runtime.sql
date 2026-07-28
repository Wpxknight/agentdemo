-- 0022_pi_only_runtime：删除已退役 Kernel 数据和 LangGraph checkpoint 存储。
-- 该迁移不可逆；执行前必须完成数据库备份。

CREATE TEMPORARY TABLE retired_agent_runs (
  tenant_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(128) NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
);

INSERT INTO retired_agent_runs (tenant_id, run_id)
SELECT tenant_id, run_id FROM agent_runs WHERE kernel <> 'pi';

DELETE target FROM task_agent_runs AS target
JOIN retired_agent_runs AS retired USING (tenant_id, run_id);
DELETE target FROM agent_run_events AS target
JOIN retired_agent_runs AS retired USING (tenant_id, run_id);
DELETE target FROM agent_tool_executions AS target
JOIN retired_agent_runs AS retired USING (tenant_id, run_id);
DELETE target FROM agent_interactions AS target
JOIN retired_agent_runs AS retired USING (tenant_id, run_id);
DELETE target FROM agent_turn_commits AS target
JOIN retired_agent_runs AS retired USING (tenant_id, run_id);
DELETE target FROM agent_turn_snapshots AS target
JOIN retired_agent_runs AS retired USING (tenant_id, run_id);
DELETE target FROM agent_run_attempts AS target
JOIN retired_agent_runs AS retired USING (tenant_id, run_id);
DELETE target FROM agent_runs AS target
JOIN retired_agent_runs AS retired USING (tenant_id, run_id);

DROP TEMPORARY TABLE retired_agent_runs;

DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_insert;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_update;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_delete;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_insert;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_update;
DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_delete;

DROP TABLE IF EXISTS langgraph_checkpoint_writes;
DROP TABLE IF EXISTS langgraph_checkpoints;

ALTER TABLE agent_runs
  MODIFY COLUMN kernel VARCHAR(32) NOT NULL DEFAULT 'pi',
  MODIFY COLUMN kernel_version VARCHAR(64) NOT NULL DEFAULT '0.82.1';
