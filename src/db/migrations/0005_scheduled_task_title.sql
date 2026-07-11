-- 定时任务标题：列表页展示用的简短名称（描述 task 仍是下发给 agent 的完整指令）
ALTER TABLE scheduled_tasks ADD COLUMN title VARCHAR(200) NOT NULL DEFAULT '' AFTER session_id;
