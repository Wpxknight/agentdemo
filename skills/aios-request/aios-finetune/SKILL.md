---
name: "aios-finetune"
description: "管理大模型微调任务，包括创建微调任务、配置训练参数、启动/终止/删除微调任务、查询任务列表和详情。当用户需要进行大模型微调操作时调用。"
---

# 大模型微调技能

## 执行规则

所有平台操作都通过 `scripts/` 及 `../aios-base/scripts/` 目录下的 Python 脚本执行，不要手写 `curl`。

以本 `SKILL.md` 所在目录为工作目录执行所有脚本，调用方式统一写成：
`python scripts/<脚本名>.py` 或 `python ../aios-base/scripts/<脚本名>.py`

## 能力边界

**本 skill 只能执行"脚本速查"表中列出的操作，不在表中的一律拒绝。**

禁止行为：
- 不要为用户不支持的操作自行编写脚本或代码
- 不要调用 `scripts/` 目录及 `../aios-base/scripts/` 以外的任何工具或命令
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

### 可协商输入型

适用于用户可以自行填写、但 agent 也能辅助生成默认值的信息（任务名称等非强约束字段）。

规则：
- `question` 字段说明当前需要的信息及其用途
- options 至少提供两种选择：
  - `由我输入`（Other）：用户自行填写
  - `使用默认值：<agent 生成的合法默认值>`：agent 自动生成并展示，用户确认即用
- **必须额外提供"取消"选项**（label: `取消本次请求`）
- agent 生成默认值时必须符合对应字段的命名约束（见下方"命名约束"）

### 选择型

适用于从已有候选列表中选择（模型、任务、资源等）。

规则：
- `question` 字段说明当前需要选择的内容
- options 列出所有候选项，label 使用名称（而非 ID）
- **必须额外提供"取消"选项**（label: `取消本次请求`）
- 若只有一个候选项（`auto_select: true`），直接使用，不弹窗

## 命名约束

微调任务名称须符合 **RFC 1123 subdomain** 规范：
- 只允许：小写字母、数字、`-`、`.`
- 必须以字母或数字开头和结尾
- **禁止使用下划线 `_`**

agent 自动生成或处理用户输入的任务名时：
- 将所有 `_` 替换为 `-`
- 将大写字母转为小写
- 去掉首尾非字母数字字符

## 标准流程

1. 用户发出平台操作指令后，agent 静默执行：

```
python ../aios-base/scripts/check_prerequisites.py
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
   python ../aios-base/scripts/setup_auth.py --username <账号> --password <密码>
   ```

4. 读取返回 JSON 的 `next_step`，直接进入下一步，不要输出"认证成功"。

## 上下文选择流程

当 `next_step` 为 `resolve_context` 时：

1. 静默执行 `python ../aios-base/scripts/get_tenant_list.py`
2. 处理租户：
   - `auto_select: true`：直接使用 `selected.tenant_id`
   - 多个租户：调用 `AskUserQuestion`（选择型），question 为 `请选择租户`，列出所有 `tenant_name`，含"取消"选项
3. 用户取消则终止；确定租户后静默执行 `python ../aios-base/scripts/get_project_list.py --tenant-id "<租户ID>"`
4. 处理项目：
   - `auto_select: true`：直接使用 `selected.project_id`
   - 多个项目：调用 `AskUserQuestion`（选择型），question 为 `请选择项目`，列出所有 `project_name`，含"取消"选项
5. 用户取消则终止；确定后静默执行：

```
python ../aios-base/scripts/setup_context.py --tenant-id "<租户ID>" --project-id "<项目ID>" --tenant-name "<租户名称>" --project-name "<项目名称>"
```

6. 返回 `next_step: run_business_script` 后，直接执行业务脚本。

## 创建微调任务流程

微调任务采用**两阶段创建**模式：先创建任务（基本信息+资源），再配置训练参数，最后启动。

### 阶段一：创建任务（基本信息 + 资源配置）

当用户请求创建微调任务时，按以下顺序收集参数：

#### 1. 任务名称（可协商输入型）

使用 `AskUserQuestion`，提供 agent 生成的合法默认值（格式：`finetune-<时间戳>`）和"由我输入"选项。

#### 2. 选择大模型（选择型）

静默执行 `python scripts/get_finetune_models.py`，将返回的模型列表以 `模型名称 (版本)` 格式展示给用户选择。

**重要：`AskUserQuestion` 每个 question 最多 4 个 options。** 当模型数量超过 3 个时（需保留 1 个"取消"选项位），按以下规则处理：
- 将模型列表在对话中**以编号列表形式完整输出**（如 `1. Qwen3.5-35B (V1.0)`、`2. Qwen2.5-7B (V1.0)` ...）
- 然后使用**精确输入型** `AskUserQuestion`，让用户输入对应编号或模型名称
- question: `请输入您要使用的模型编号或名称`，header: `选择模型`
- options: `输入模型编号`（Other）、`取消本次请求`

#### 3. 选择资源组（选择型）

静默执行 `python ../aios-base/scripts/get_project_detail.py` 获取资源组列表，以 `资源组名称` 格式展示。
**若资源组超过 3 个**，同样先在对话中列出所有选项，再用精确输入型让用户输入编号。

#### 4. 选择资源规格（选择型）

静默执行 `python ../aios-base/scripts/get_resource_specs.py` 获取规格列表，以 `规格名称 (GPU/CPU/内存)` 格式展示。
**若规格超过 3 个**，同样先在对话中列出所有选项，再用精确输入型让用户输入编号。

#### 5. 实例数量（可协商输入型）

使用 `AskUserQuestion`，默认值为 `1`。

#### 6. 共享内存（可协商输入型）

使用 `AskUserQuestion`，默认值为 `1`（GB）。

#### 7. 确认创建（选择型）

收集完所有参数后，**在对话中输出完整任务配置摘要**，然后使用 `AskUserQuestion` 询问是否创建：

摘要格式：
```
微调任务配置确认：
- 任务名称：<task-name>
- 基础模型：<model-name>
- 资源组：<resource-group>
- 资源规格：<resource-spec>
- 实例数量：<N>
- 共享内存：<N> GB
```

options: `确认创建`、`取消本次请求`

#### 8. 执行创建

用户确认后静默执行：
```
python scripts/create_finetune_task.py \
  --task-name <任务名> \
  --model-name <模型名> \
  --resource-group-id <资源组ID> \
  --resource-spec-id <规格ID> \
  --instance-count <实例数> \
  --shm-size <共享内存>
```

直接输出任务 ID，记录 `task-id` 用于后续配置阶段。

### 阶段二：配置训练参数

任务创建后，自动进入配置阶段。

#### 1. 选择微调方式（选择型）

使用 `AskUserQuestion`，options:
- `LoRA`（推荐，资源需求低）
- `全参数微调`（效果更好，需要更多资源）
- `部分参数微调`（折中方案）

#### 2. 选择数据集（选择型）

静默执行 `python ../aios-base/scripts/get_dataset_list.py`，将数据集列表展示给用户选择。

记录所选数据集的 `id`（用于 `--dataset-id` 和下一步文件查询）和 `name`（用于确认摘要展示）。

#### 3. 选择数据文件（选择型）

确定数据集后，静默执行 `python ../aios-base/scripts/get_dataset_files.py --dataset-id <数据集ID>`，列出数据集内的文件/目录。

将文件列表展示给用户选择，记录所选文件名称作为 `dataset-name`（用于 `--dataset-name`）。

**若文件超过 3 个**，同样先在对话中列出所有选项，再用精确输入型让用户输入编号。

#### 4. 核心训练参数（可协商输入型）

使用**一次** `AskUserQuestion` 同时询问以下核心参数（每个一个 question）：

| 参数 | 默认值 | question |
|------|--------|---------|
| 学习率 | 5e-05 | `请输入学习率（推荐 5e-05，LoRA 建议 1e-4 ~ 5e-4）` |
| 训练轮数 | 3 | `请输入训练轮数（推荐 3）` |
| 批处理大小 | 2 | `请输入每 GPU 批处理大小（推荐 2）` |
| 截断长度 | 1024 | `请输入最大序列截断长度（推荐 1024）` |

每个参数 options: `使用默认值：<默认值>`、`由我输入`、`取消本次请求`

**其他参数使用内置默认值，不要逐一询问。**

#### 5. LoRA 专属参数（仅 LoRA 方式，可协商输入型）

如果用户选择了 LoRA，使用**一次** `AskUserQuestion` 同时询问以下参数（每个一个 question）：

| 参数 | 默认值 | question |
|------|--------|---------|
| LoRA 秩 | 8 | `请输入 LoRA 秩（推荐 8，复杂任务建议 16+）` |
| LoRA 缩放系数 | 16 | `请输入 LoRA 缩放系数（推荐为秩的 2 倍）` |

#### 6. 确认配置（选择型）

输出参数配置摘要，然后使用 `AskUserQuestion`：

```
微调参数配置确认：
- 微调方式：<lora/全参数/部分参数>
- 数据集：<dataset-name>
- 数据文件：<file-name>
- 学习率：<value>
- 训练轮数：<value>
- 批处理大小：<value>
- 截断长度：<value>
<如为 LoRA>- LoRA 秩：<value>
<如为 LoRA>- LoRA 缩放系数：<value>
```

options: `确认配置`、`取消本次请求`

#### 7. 执行配置更新

用户确认后静默执行：
```
python scripts/update_finetune_config.py \
  --task-id <任务ID> \
  --finetuning-type <lora/full/freeze> \
  --dataset-id <数据集ID> \
  --dataset-name <数据文件名> \
  --learning-rate <值> \
  --epochs <值> \
  --batch-size <值> \
  --cutoff-len <值> \
  [--lora-rank <值>] \
  [--lora-alpha <值>]
```

### 阶段三：启动任务

配置完成后，使用 `AskUserQuestion` 询问：
- question: `微调任务配置完成，是否立即启动？`
- options: `立即启动`、`暂不启动`

选择"立即启动"后静默执行：
```
python scripts/launch_finetune_task.py --task-id <任务ID>
```

直接输出启动结果。

## 参数补全规范

| 操作 | 缺少参数 | 交互类型 | 查询脚本 |
|------|---------|---------|---------|
| 创建微调任务 | 模型名 | 选择型 | `get_finetune_models.py` |
| 创建微调任务 | 任务名 | 可协商输入型 | 无，agent 生成默认值 |
| 创建微调任务 | 资源组 | 选择型 | `get_project_detail.py` |
| 创建微调任务 | 资源规格 | 选择型 | `get_resource_specs.py` |
| 配置微调任务 | 数据集 | 选择型 | `get_dataset_list.py` |
| 配置微调任务 | 数据文件 | 选择型 | `get_dataset_files.py --dataset-id <数据集ID>` |
| 配置微调任务 | 训练参数 | 可协商输入型 | 无，使用内置默认值 |
| 终止/删除任务 | 任务 ID | 选择型 | `get_finetune_task_list.py` |
| 查询任务详情 | 任务 ID | 选择型 | `get_finetune_task_list.py` |

## 脚本速查

| 用户意图 | 脚本命令 |
|---------|---------|
| 前置检查 | `python ../aios-base/scripts/check_prerequisites.py` |
| 认证初始化（浏览器 Token） | `python ../aios-base/scripts/setup_auth_browser.py --token-data '<JSON>'` |
| 认证初始化（账号密码） | `python ../aios-base/scripts/setup_auth.py --username <账号> --password <密码>` |
| 查询租户列表 | `python ../aios-base/scripts/get_tenant_list.py` |
| 查询项目列表 | `python ../aios-base/scripts/get_project_list.py --tenant-id <租户ID>` |
| 上下文初始化 | `python ../aios-base/scripts/setup_context.py --tenant-id <租户ID> --project-id <项目ID> --tenant-name <租户名称> --project-name <项目名称>` |
| 查询微调可用模型 | `python scripts/get_finetune_models.py` |
| 查询微调任务列表 | `python scripts/get_finetune_task_list.py` |
| 查询微调任务详情 | `python scripts/get_finetune_task_detail.py --task-id <任务ID>` |
| 创建微调任务 | `python scripts/create_finetune_task.py --task-name <名称> --model-name <模型> --resource-group-id <资源组ID> --resource-spec-id <规格ID>` |
| 更新微调配置 | `python scripts/update_finetune_config.py --task-id <任务ID> --finetuning-type <方式> --dataset-id <数据集ID> --dataset-name <文件名>` |
| 查询数据集列表 | `python ../aios-base/scripts/get_dataset_list.py` |
| 查询数据文件列表 | `python ../aios-base/scripts/get_dataset_files.py --dataset-id <数据集ID>` |
| 查询项目详情（资源组） | `python ../aios-base/scripts/get_project_detail.py` |
| 查询资源规格列表 | `python ../aios-base/scripts/get_resource_specs.py` |
| 启动微调任务 | `python scripts/launch_finetune_task.py --task-id <任务ID>` |
| 终止微调任务 | `python scripts/terminate_finetune_task.py --task-id <任务ID>` |
| 删除微调任务 | `python scripts/delete_finetune_task.py --task-id <任务ID>` |

所有脚本支持 `--help` 查看完整参数说明。

## 训练参数默认值参考

以下参数在内置默认值中，agent 生成可协商输入型选项时使用：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| learningRate | 5e-05 | 学习率 |
| numTrainEpochs | 3 | 训练轮数 |
| perDeviceTrainBatchSize | 2 | 批处理大小 |
| gradientAccumulationSteps | 8 | 梯度累积步数 |
| maxGradNorm | 1.0 | 最大梯度范数 |
| cutOffLen | 1024 | 截断长度 |
| calculationType | fp16 | 计算类型（fp16/bf16/fp32） |
| lrSchedulerType | cosine | 学习率调度器 |
| maxSamples | 100000 | 最大样本数 |
| valSize | 0 | 验证集比例 |
| template | default | 提示词模板 |
| loggingSteps | 5 | 日志间隔 |
| saveSteps | 100 | 保存间隔 |
| optim | adamw_torch | 优化器 |
| loraRank | 8 | LoRA 秩（LoRA 方式） |
| loraAlpha | 16 | LoRA 缩放系数（LoRA 方式） |
| freezeTrainableLayers | 2 | 可训练层数（freeze 方式） |

## 错误处理

| 错误信息 | 原因 | 解决方式 |
|---------|------|---------|
| 未找到有效 token | 未认证或 token 已过期 | 静默执行 `check_prerequisites.py`，重新走认证流程 |
| 未配置租户/项目 | 未完成上下文配置 | 静默执行租户和项目列表脚本，单项默认，多项让用户选择 |
| 找不到名称为 'xxx' 的微调模型 | 模型名错误 | 执行 `get_finetune_models.py` 获取可用列表 |
| 任务已终止，无需再次终止 | 重复终止 | 告知用户任务已处于终止状态 |
