---
name: "aios-infer"
description: "执行模型训推平台的推理任务管理操作，包括创建推理任务、终止任务、删除任务、查询任务实例详情等。当用户需要创建、启停或管理平台上的推理任务时调用。注意：查询项目列表、查看项目配额等基础查询操作由 aios-base 处理。"
---

# 模型训推平台管理技能

## 执行规则

所有平台操作通过 `scripts/` 及 `../aios-base/scripts/` 下的 Python 脚本执行，**禁止手写 `curl`**。以本 `SKILL.md` 所在目录为工作目录。

**能力边界**：只能执行"脚本速查"表中的操作，不在表中的一律拒绝，不要自行编写脚本或调用目录外的工具。

## 核心原则

- **脚本驱动，消息最少化**：`next_step` 是内部控制信号，不转述给用户
- **所有用户交互必须使用 `AskUserQuestion`**，禁止在对话里用文字追问
- **用户可见消息只有最终业务结果**，禁止流程播报（"我先检查"、"认证成功"、"接下来"等）

## AskUserQuestion 交互规范

所有用户交互分为三类，**每类都必须提供 `取消本次请求` 选项**：

| 类型 | 适用场景 | options 构成 |
|------|---------|-------------|
| **精确输入型** | 账号密码等必须准确的信息 | `输入XXX`（Other）+ `取消本次请求` |
| **可协商输入型** | 任务名等有默认值的字段 | `使用默认值：<值>` + `由我输入`（Other）+ `取消本次请求` |
| **选择型** | 从候选列表中选择 | 列出所有候选项（label 用名称不用 ID）+ `取消本次请求` |

选择型规则：只有一个候选项（`auto_select: true`）→ 自动选定不弹窗。

## 命名约束

推理任务名称须符合 **RFC 1123 subdomain**：只允许小写字母、数字、`-`、`.`，必须以字母或数字开头结尾，**禁止下划线 `_`**。

自动处理规则：`_` → `-`，大写 → 小写，去掉首尾非字母数字字符。示例：`my_task_1` → `my-task-1`

## 标准流程

1. 静默执行 `python ../aios-base/scripts/check_prerequisites.py`
2. 按 `next_step` 走认证（`setup_auth`）或上下文（`resolve_context`）流程

### 认证流程

1. 若 `token.json` 已存在 → 直接进入下一步
2. 若不存在 → 一次 `AskUserQuestion` 同时问账号（精确输入型）和密码（精确输入型）
3. 填写后静默执行 `python ../aios-base/scripts/setup_auth.py --username <账号> --password <密码>`

### 上下文选择流程

1. 静默执行 `python ../aios-base/scripts/get_tenant_list.py`，单项自动选定，多项用户选择
2. 静默执行 `python ../aios-base/scripts/get_project_list.py --tenant-id "<租户ID>"`，同上
3. 静默执行 `python ../aios-base/scripts/setup_context.py --tenant-id "<ID>" --project-id "<ID>" --tenant-name "<名>" --project-name "<名>"`

## 脚本速查

| 用户意图 | 脚本命令 |
|---------|---------|
| 前置检查 | `python ../aios-base/scripts/check_prerequisites.py` |
| 认证（浏览器Token） | `python ../aios-base/scripts/setup_auth_browser.py --token-data '<JSON>'` |
| 认证（账号密码） | `python ../aios-base/scripts/setup_auth.py --username <账号> --password <密码>` |
| 查询租户列表 | `python ../aios-base/scripts/get_tenant_list.py` |
| 查询项目列表 | `python ../aios-base/scripts/get_project_list.py --tenant-id <租户ID>` |
| 上下文初始化 | `python ../aios-base/scripts/setup_context.py --tenant-id <ID> --project-id <ID>` |
| 查询模型列表（全量） | `python scripts/get_model_list.py [--all]` |
| 按名称查询模型详情 | `python scripts/get_model_list.py --model-name <名称>` |
| 查询推理框架及配置 | `python scripts/get_infer_frameworks.py` |
| 查询已完成训练任务列表 | `python scripts/get_train_task_list.py` |
| 查询训练任务详情 | `python scripts/get_train_task_detail.py --task-id <ID>` |
| 查询项目详情（含资源组/规格） | `python ../aios-base/scripts/get_project_detail.py` |
| 查询镜像仓库列表 | `python ../aios-base/scripts/get_image_registries.py` |
| 查询仓库镜像列表 | `python ../aios-base/scripts/get_images.py --registry-id <ID>` |
| 查询文件目录列表 | `python ../aios-base/scripts/get_file_list.py [--path <路径>]` |
| 查询平台数据集列表 | `python ../aios-base/scripts/get_dataset_list.py` |
| 创建推理任务 | `python scripts/create_infer_task.py`（参数见下方流程） |
| 查询推理任务列表 | `python scripts/get_infer_task_list.py` |
| 终止推理任务 | `python scripts/terminate_infer_task.py --task-id <ID>` |
| 删除推理任务 | `python scripts/delete_infer_task.py --task-name <名称>` |
| 查询任务实例列表 | `python scripts/get_task_instances.py --task-id <ID> --namespace <NS>` |
| 查询任务实例详情 | `python scripts/get_task_instance_detail.py --task-id <ID>` |

## 错误处理

| 错误 | 解决 |
|------|------|
| 未找到有效 token | 重新走认证流程 |
| 未配置租户/项目 | 重新走上下文选择流程 |
| 资源组/规格 ID 无效 | 运行 `get_project_detail.py` 获取正确 ID |
| modelVersion 类型错误 | 使用模型记录 ID（整数） |
| GPU 资源不足 | 等待释放或切换资源组 |
| 任务名称校验失败 | `_` 替换为 `-` |

## 创建推理任务流程

按以下顺序收集参数（步骤中标注的类型对应上方交互规范）。

### 1. 任务名称（可协商输入型）

默认值格式：`infer-<YYYYMMDD>-<4位随机数>`

### 2. 模型来源（选择型）

选项：模型仓库 / 训练任务

#### 2a. 模型仓库

1. 静默执行 `python scripts/get_model_list.py --all`，提取不重复的 `modelName` 让用户选择
2. 静默执行 `python scripts/get_model_list.py --model-name <选定的名称>`，获取详细模型数据
3. 若有多版本 → 让用户选择版本（label: `版本 <version>`）
4. 记录：`model_id`（记录的 `id`）、`model_name`、`model_path`、`model_type`（`modelTypeValue`）、`model_type_parent_id`（`modelTypeParentId`）

**重要**：`modelVersion` 使用模型记录的 `id`（不是 version 字符串），`--model-id` 同时用于 `modelId` 和 `modelVersion`。

#### 2b. 训练任务

1. 静默执行 `python scripts/get_train_task_list.py`，让用户选择（label: `<name>（<framework>）`）
2. 静默执行 `python scripts/get_train_task_detail.py --task-id <ID>`，从 `outputMount` 取 `hostPath`
3. 记录 `train_task_id` 和 `train_task_output`

### 3. 部署方式（选择型）

单机部署(`1`) / 分布式部署(`2`)。记录 `deploy_type`。

### 4. 推理框架（选择型）

1. 静默执行 `python scripts/get_infer_frameworks.py`
2. 让用户选择框架 key（description 展示镜像和端口信息）
3. 记录整个框架配置对象（`key`、`image`、`command`、`args`、`requiredArgs`、`ports`、`envs`）

`requiredArgs` 字段含义：`modelName`=模型名参数标识，`modelDir`=模型目录参数标识，`maxModelLen`=最大上下文长度（→ `--max-context-length`），`cardNumber`=卡数/并行度（→ `--tensor-parallel-scale`）。

### 4a. 框架参数配置（选择型）

选项：使用框架默认参数 / 自定义参数

**默认参数**：`custom_params` = 框架 `args` 空格拼接，`max_context_length=8192`，`tensor_parallel_scale=1`，端口取 `ports[0].containerPort`

**自定义参数**：逐项询问（仅 `requiredArgs` 对应字段非空时展示）：
- 最大上下文长度（可协商输入型，默认 8192）
- 张量并行度（可协商输入型，默认 1）
- 框架启动参数（可协商输入型，默认为框架 args 拼接结果）

### 5. 实例个数（可协商输入型）

默认 1，用户输入必须为正整数。

### 6. 自定义镜像（选择型，可选）

选项：使用框架默认镜像 / 自定义镜像（从仓库选择）/ 第三方镜像（输入地址）

- **框架默认镜像**：`image_source=1`，`image=None`
- **自定义镜像**：依次执行 `get_image_registries.py` → 选仓库 → `get_images.py --registry-id <ID>` → 选镜像（label: `<name>:<tag>`，取 `image_path`）。`image_source=2`
- **第三方镜像**：精确输入型输入完整地址。`image_source=3`

### 7. 启动命令 + 端口号（条件型）

**框架默认镜像**（`image_source=1`）：跳过启动命令（框架自动处理），端口号可协商输入型（默认取框架 `ports[0].containerPort`）

**自定义/第三方镜像**（`image_source=2/3`）：启动命令为精确输入型（默认示例：`/bin/bash -C python3 -m flask --app infer run --host=0.0.0.0 --port=8080`），端口号为精确输入型（默认 8080）

多端口用英文逗号分隔。

### 8. 数据挂载（选择型）

选项：选择数据目录 / 跳过

选择数据目录时：执行 `get_file_list.py` → 用户选目录 → 精确输入型输入容器挂载路径（默认 `/mnt/data`）。记录 `{"containerPath": "<容器路径>", "hostPath": "<宿主机路径>"}`。可进入子目录（`--path <相对路径>`）。

### 9. 资源配置（选择型）

1. 静默执行 `python ../aios-base/scripts/get_project_detail.py`
2. 从 `resourceGroup` 选资源组（单项自动选定），记录 `resource_group_id`
3. 从 `resourceSpec` 选资源规格，记录 `resource_spec_id`（取 `quotaId`），**同时记录是否有加速卡**（`specType == "gpu"`）

### 10. 调度策略（条件型）

**仅当 `deploy_type == 2`（分布式）且资源规格无加速卡时**才显示，否则默认本地调度跳过此步。

选项：本地调度 / 远程调度。选择远程时额外选择远程资源组和远程资源规格。

### 11. 自动停止 + RDMA（选择型）

**自动停止**：不自动停止 / 1小时 / 2小时 / 自定义小时数（Other）。记录 `auto_stop` 和 `auto_stop_hours`。

**RDMA**：不启用 / 启用。记录 `rdma`。

### 12. 确认并执行

展示配置摘要后，选择型确认发布。

摘要包含：任务名称、模型来源及详情、部署方式、推理框架（含镜像简述）、框架参数（最大上下文/并行度/自定义参数）、实例个数、镜像、启动命令、端口、数据挂载、资源组/规格、调度策略、自动停止、RDMA。

确认后执行 `create_infer_task.py`：

```bash
python scripts/create_infer_task.py \
  --task-name <名称> \
  --model-source <1|2> \
  --model-id <模型ID> \
  --model-name <名称> --model-path <路径> \
  --model-type <类型> --model-type-parent-id <父ID> \
  --train-task-id <ID> --train-task-output <路径> \
  --deploy-type <1|2> \
  --framework <框架key> \
  --replicas <N> \
  --image-source <1|2|3> \
  --image <镜像> \
  --command <命令> \
  --ports <端口> \
  --data-mounts '<JSON>' \
  --resource-group-id <ID> --resource-spec-id <ID> \
  --schedule-strategy <local|remote> \
  --remote-resource-group-id <ID> --remote-resource-spec-id <ID> \
  --auto-stop <true|false> --auto-stop-hours <N> \
  --rdma <true|false> \
  --max-context-length <N> --tensor-parallel-scale <N> \
  --custom-params '<参数>'
```

**参数规则**：
- `--model-source 1`：传 `--model-*`，不传 `--train-task-*`
- `--model-source 2`：传 `--train-task-*`，不传 `--model-*`
- `--image-source 1`：不传 `--image` 和 `--command`
- 远程调度：额外传 `--remote-resource-group-id` 和 `--remote-resource-spec-id`
- `--auto-stop false`：不传 `--auto-stop-hours`
- `--data-mounts` 格式：`[{"containerPath":"/mnt/data","hostPath":"/opt/data"}]`

