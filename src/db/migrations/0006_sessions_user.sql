-- 0006_sessions_user：会话/消息按用户隔离（AIOS 集成 P1，见 docs/DESIGN-aios-integration.md §2.3）。
-- 存量数据 user_id 置空串（视为"遗留公共会话"，默认对所有人不可见）；
-- 如需找回，运维可手动执行：UPDATE sessions SET user_id='<目标用户id>' WHERE user_id='';（messages 同理）。

ALTER TABLE sessions ADD COLUMN user_id VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN user_id VARCHAR(64) NOT NULL DEFAULT '';

-- 主键改为 (tenant_id, user_id, session_id)：不同用户的同名 sessionId 互不冲突，
-- 用户 A 无法通过传入 B 的 sessionId 触碰 B 的会话行（写入只会落到自己名下）。
ALTER TABLE sessions DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, user_id, session_id);

CREATE INDEX idx_sessions_tenant_user ON sessions (tenant_id, user_id, updated_at);
CREATE INDEX idx_messages_session_user ON messages (tenant_id, user_id, session_id, id);
