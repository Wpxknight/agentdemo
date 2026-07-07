---
name: "aios-base"
description: "模型训推平台的基础操作，包括登录认证、切换租户/项目上下文、查询项目列表、查看项目配额与资源、查询数据集、查询文件目录、查询加速卡、查询资源规格等。当用户需要登录平台、切换项目、查询基础平台信息时调用。"
---

# 模型训推平台基础操作

## 执行规则

所有平台操作都通过 `scripts/` 目录下的 Python 脚本执行，不要手写 `curl`。

以本 `SKILL.md` 所在目录为工作目录执行所有脚本，调用方式统一写成：
`python scripts/<脚本名>.py`

## 能力边界

**本 skill 只能执行"脚本速查"表中列出的操作，不在表中的一律拒绝。**

禁止行为：
- 不要为用户不支持的操作自行编写脚本或代码
- 不要调用 `scripts/` 目录以外的任何工具或命令
- 不要尝试推断、拼凑或变通实现表中不存在的功能

当用户请求不支持的操作时，只需告知：
`该操作暂不支持，当前可用功能请参考：<列出脚本速查表中的操作名称>`

## 核心原则

这套 skill 采用"脚本驱动，外显消息最少化"的方式执行。

agent 必须把脚本返回的 `next_step` 当作内部控制信号，只根据它决定下一步动作，不要把内部状态转述给用户。

**所有需要用户输入或选择的场景，必须使用 `AskUserQuestion` 工具**，禁止在对话消息里用文字提问。

用户可见的对话消息只允许一种：**最终业务结果**，直接输出脚本结果或其摘要，不要加任何前缀说明。

禁止输出的表达包括但不限于：`我先检查`、`认证成功`、`现在获取`、`上下文设置完成`、`接下来`、`我先...`、`现在我...` 等一切流程播报。

## AskUserQuestion 交互规范

所有用户交互统一通过 `AskUserQuestion` 工具完成，分为以下两类：

### 精确输入型

适用于必须由用户准确提供、不可替代的信息（账号、密码等）。

规则：
- `question` 字段直接说明需要填写的内容，例如：`请在下方输入您的平台账号` / `请在下方输入您的平台密码`
- options 提供两项：
  - 第一项 label 为具体引导语（如 `输入账号`），description 为空，作为 Other 触发用户输入框
  - 第二项 label 为 `取消本次请求`，用户选择后终止当前流程，不再继续执行
- 不要使用"其他（请输入）"等模糊表述，label 必须清晰描述用户即将做的操作

示例场景：账号、密码

### 选择型

适用于从已有候选列表中选择（租户、项目、模型、任务等）。

规则：
- `question` 字段说明当前需要选择的内容
- options 列出所有候选项，label 使用名称（而非 ID）
- **必须额外提供"取消"选项**（label: `取消本次请求`）
- 若只有一个候选项（`auto_select: true`），直接使用，不弹窗

## 标准流程

1. 用户发出平台操作指令后，agent 静默执行：

```
python scripts/check_prerequisites.py
```

2. 读取返回 JSON 中的 `next_step`：
   - `setup_auth` → 进入认证流程
   - `resolve_context` → 进入上下文选择流程
   - `run_business_script` → 直接执行业务脚本

## 认证流程

当 `next_step` 为 `setup_auth` 时：

1. 检查本地是否存在 `token.json` 文件（即 `TOKEN_FILE`）。若存在则直接进入下一步，不要弹窗。

2. 若 `token.json` 不存在，使用**一次** `AskUserQuestion` 同时询问账号和密码（两个 question）：
   - question 1: `请输入您的平台账号`，header: `账号`，options: `输入账号`（Other）、`取消本次请求`
   - question 2: `请输入您的平台密码`，header: `密码`，options: `输入密码`（Other）、`取消本次请求`

3. 任意一项用户选择"取消本次请求"则终止流程；两项均填写后静默执行：
   ```
   python scripts/setup_auth.py --username <账号> --password <密码>
   ```

4. 读取返回 JSON 的 `next_step`，直接进入下一步，不要输出"认证成功"。

## 上下文选择流程

当 `next_step` 为 `resolve_context` 时：

1. 静默执行 `python scripts/get_tenant_list.py`
2. 处理租户：
   - `auto_select: true`：直接使用 `selected.tenant_id`
   - 多个租户：调用 `AskUserQuestion`（选择型），question 为 `请选择租户`，列出所有 `tenant_name`，含"取消"选项
3. 用户取消则终止；确定租户后静默执行 `python scripts/get_project_list.py --tenant-id "<租户ID>"`
4. 处理项目：
   - `auto_select: true`：直接使用 `selected.project_id`
   - 多个项目：调用 `AskUserQuestion`（选择型），question 为 `请选择项目`，列出所有 `project_name`，含"取消"选项
5. 用户取消则终止；确定后静默执行：

```
python scripts/setup_context.py --tenant-id "<租户ID>" --project-id "<项目ID>" --tenant-name "<租户名称>" --project-name "<项目名称>"
```

6. 返回 `next_step: run_business_script` 后，直接执行业务脚本。

## 脚本速查

| 用户意图 | 脚本命令 |
|---------|---------|
| 前置检查 | `python scripts/check_prerequisites.py` |
| 认证初始化（浏览器 Token） | `python scripts/setup_auth_browser.py --token-data '<JSON>'` |
| 认证初始化（账号密码） | `python scripts/setup_auth.py --username <账号> --password <密码>` |
| 查询租户列表 | `python scripts/get_tenant_list.py` |
| 查询项目列表 | `python scripts/get_project_list.py --tenant-id <租户ID>` |
| 上下文初始化 | `python scripts/setup_context.py --tenant-id <租户ID> --project-id <项目ID>` |
| 查询项目详情 | `python scripts/get_project_detail.py` |
| 查询数据集列表 | `python scripts/get_dataset_list.py` |
| 查询文件目录列表 | `python scripts/get_file_list.py [--path <路径>]` |
| 查询加速卡列表 | `python scripts/get_accel_list.py` |
| 查询资源规格 | `python scripts/get_resource_specs.py` |
| 查询资源组详情 | `python scripts/get_resource_group_detail.py` |
| 创建文件目录 | `python scripts/create_output_dir.py --dir-name <目录名>` |
| 查询镜像仓库列表 | `python scripts/get_image_registries.py` |
| 查询仓库镜像列表 | `python scripts/get_images.py --registry-id <仓库ID> [--name <名称过滤>]` |
| 查询训练框架及预制镜像 | `python scripts/get_train_frameworks.py` |

所有脚本支持 `--help` 查看完整参数说明。

## 错误处理

| 错误信息 | 原因 | 解决方式 |
|---------|------|---------|
| 未找到有效 token | 未认证或 token 已过期 | 静默执行 `check_prerequisites.py`，重新走认证流程 |
| 未配置租户/项目 | 未完成上下文配置 | 静默执行租户和项目列表脚本，单项默认，多项让用户选择 |
| 规格关联记录不存在 | 资源组 ID 或规格 ID 错误 | 先运行 `python scripts/get_project_detail.py` 获取正确 ID |

## 与其他 skill 的关系

本 skill 是模型训推平台的公共基础层，提供认证、上下文、通用查询等能力。以下业务 skill 依赖本 skill：

- **aios-infer** — 推理任务管理（创建/查询/终止推理任务、训练任务）
- **aios-finetune** — 大模型微调（创建/配置/启动微调任务）
- **aios-report** — 平台报表分析（管理员资源统计、任务报表、趋势分析）
- **aios-train** — 通用模型训练（支持自定义框架、镜像、数据集、启动命令）
- **yolo-train** — YOLO 模型训练（使用平台封装的 YOLO 算法镜像）

各业务 skill 在执行前会自动复用本 skill 的认证和上下文流程。当用户直接请求登录、切换项目、查询基础信息时，由本 skill 直接处理。

## 缓存文件

- `token.json` — 用户认证 token（由 auth 模块读写）
- `context.json` — 租户/项目上下文（由 context 模块读写）

> 缓存文件统一存放在本 skill 根目录下，其他业务 skill 通过本 skill 的脚本间接访问。
