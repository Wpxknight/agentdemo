-- 0019_langgraph_checkpoints_read_only：停止新 LangGraph Run 后冻结历史 checkpoint。
-- 历史数据继续供审计与回滚窗口查询；最终清表必须在备份验证和保留期结束后另行执行。

DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_insert;
CREATE TRIGGER trg_langgraph_checkpoints_read_only_insert
BEFORE INSERT ON langgraph_checkpoints FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'langgraph checkpoints are read only';

DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_update;
CREATE TRIGGER trg_langgraph_checkpoints_read_only_update
BEFORE UPDATE ON langgraph_checkpoints FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'langgraph checkpoints are read only';

DROP TRIGGER IF EXISTS trg_langgraph_checkpoints_read_only_delete;
CREATE TRIGGER trg_langgraph_checkpoints_read_only_delete
BEFORE DELETE ON langgraph_checkpoints FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'langgraph checkpoints are read only';

DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_insert;
CREATE TRIGGER trg_langgraph_checkpoint_writes_read_only_insert
BEFORE INSERT ON langgraph_checkpoint_writes FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'langgraph checkpoint writes are read only';

DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_update;
CREATE TRIGGER trg_langgraph_checkpoint_writes_read_only_update
BEFORE UPDATE ON langgraph_checkpoint_writes FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'langgraph checkpoint writes are read only';

DROP TRIGGER IF EXISTS trg_langgraph_checkpoint_writes_read_only_delete;
CREATE TRIGGER trg_langgraph_checkpoint_writes_read_only_delete
BEFORE DELETE ON langgraph_checkpoint_writes FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'langgraph checkpoint writes are read only';
