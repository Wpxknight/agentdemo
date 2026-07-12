-- 0009_users_home_dir：用户绑定的主机主目录（宿主机绝对路径）。
-- 绑定后启动会话沙箱时默认以 hostPath 卷挂载进沙箱（挂载点见 config.sandbox.userHomeMountPath）。

ALTER TABLE users
  ADD COLUMN home_dir VARCHAR(512) NULL;
