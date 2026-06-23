-- 0003_messages_tenant_history_index：优化租户历史会话列表查询。
-- MysqlStore.listSessions 按 tenant_id 过滤并按 id 倒序读取最近消息；
-- 旧索引 idx_messages_session(tenant_id, session_id, id) 不能服务该排序。

SET @idx_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'messages'
    AND index_name = 'idx_messages_tenant_id'
);

SET @ddl := IF(
  @idx_exists = 0,
  'CREATE INDEX idx_messages_tenant_id ON messages (tenant_id, id)',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
