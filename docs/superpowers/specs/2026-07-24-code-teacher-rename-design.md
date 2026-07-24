# Code Teacher Skill 重命名设计

## 目标

将个人 Codex skill 从 `teaching-code` 完整重命名为 `code-teacher`，确保目录名、frontmatter、UI 元数据、内部声明、测试及项目文档引用一致。

## 方案

- 将 `/home/lb/.codex/skills/teaching-code` 移动为 `/home/lb/.codex/skills/code-teacher`。
- 将 `SKILL.md` 的 `name` 改为 `code-teacher`，标题改为 `Code Teacher`。
- 将 `agents/openai.yaml` 的默认调用改为 `$code-teacher`。
- 更新第三方声明以及 AIoP 设计、计划文档中的旧名称和旧路径。
- 不保留旧目录、symlink 或兼容 wrapper，避免重复发现和调用歧义。
- 保留当前教学数据、URL、端口和访问 key；使用新 skill 路径重启服务。

## 验收标准

- `quick_validate.py` 校验新目录成功。
- skill 自带测试全部通过。
- 新目录存在且旧目录不存在。
- 仓库和新 skill 内不再存在有效的 `teaching-code` 调用或旧路径引用。
- 当前教学 URL 可读取全部 17 节内容。
