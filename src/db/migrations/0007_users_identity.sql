-- 0007_users_identity：用户来源标记 + 软删除状态 + 展示名（AIOS 集成 P1/§8）。
-- status：active | disabled（软删除/封禁，行永不硬删——sessions/skills/scheduled_tasks 外键锚定）。
-- auth_provider：local | oidc | aios（登录来源；JIT 建号时写入）。

ALTER TABLE users
  ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active',
  ADD COLUMN auth_provider VARCHAR(16) NOT NULL DEFAULT 'local',
  ADD COLUMN display_name VARCHAR(128) NULL;

-- 存量 OIDC 用户回填来源标记（password_hash 哨兵值 'oidc'）。
UPDATE users SET auth_provider = 'oidc' WHERE password_hash = 'oidc';
