-- 0004_sessions：显式会话表，支持空会话立即出现在历史列表。
-- 历史消息会话从 messages 回填，后续写入由 Store.touchSession 维护。

CREATE TABLE IF NOT EXISTS sessions (
  tenant_id   VARCHAR(64)  NOT NULL,
  session_id  VARCHAR(128) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, session_id),
  KEY idx_sessions_updated (tenant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO sessions (tenant_id, session_id, title, created_at, updated_at)
SELECT
  grouped.tenant_id,
  grouped.session_id,
  -- LEFT(…,255)：title 列是 VARCHAR(255)，首条消息全文可能远超；严格模式下不截断会让整个迁移失败。
  LEFT(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(first_msg.content, '$.text')), ''), grouped.session_id), 255) AS title,
  grouped.created_at,
  grouped.updated_at
FROM (
  SELECT tenant_id, session_id, MIN(id) AS first_id, MIN(created_at) AS created_at, MAX(created_at) AS updated_at
  FROM messages
  GROUP BY tenant_id, session_id
) grouped
JOIN messages first_msg ON first_msg.id = grouped.first_id;
