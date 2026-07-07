---
name: "aios-train"
description: "通用模型训练技能，支持用户自定义 AI 训练框架、镜像、数据集、启动命令等，创建平台模型训练任务。当用户需要发起非特定框架的通用模型训练时调用。"
---

# 通用模型训练技能

## 依赖

- `aios-base` skill（提供认证、上下文、基础查询能力）
- 两个 skill 必须位于同一父目录下（互为兄弟目录）

## 核心原则

- 所有平台操作通过脚本执行，禁止手写 `curl`
- `next_step` 是内部控制信号，不转述给用户
- 用户输入/选择场景必须使用 `AskUserQuestion`
- 对话消息只允许：**最终业务结果** 或 **配置摘要**
- 禁止流程播报（"我先检查"、"接下来"等）

---

## 标准流程

### 阶段 1：前置检查

复用 aios-base 的标准流程：

1. `python ../aios-base/scripts/check_prerequisites.py`
2. 按 `next_step` 走认证流程（`setup_auth`）
3. 按 `next_step` 走上下文选择（`resolve_context`）
4. 完成后进入**配置引导**

---

## 阶段 2：配置引导

### 1. 任务名称（可协商）

格式：`train-<YYYYMMDD>-<4位随机数>`

示例：`train-20260420-3718`

```
question: 请确认训练任务名称
options:
  - 使用默认名称：<自动生成的名称>
  - 由我输入（Other）
  - 取消本次请求
```

### 2. AI 训练框架

1. 静默执行：`python ../aios-base/scripts/get_train_frameworks.py`
2. 从返回的 `data` 数组中提取所有框架名称，额外加上 "Standard" 选项
3. `AskUserQuestion` 列出所有框架供用户选择

```
question: 请选择训练框架
options:
  - Standard（单机训练，无分布式框架）
  - <API 返回的各框架名称，如 PyTorch、TensorFlow 等>
  - 取消本次请求
```

记录用户选择的框架名称，后续用于：
- 若选 **Standard** → 无预制镜像，用户必须通过自定义或第三方镜像提供
- 若选 **其他框架** → 可直接使用该框架的预制镜像，也可选择自定义/第三方镜像

### 3. 镜像选择

```
question: 请选择镜像来源
options:
  - 预制镜像（使用当前框架的推荐镜像）
  - 自定义镜像（从平台镜像仓库选择）
  - 第三方镜像（输入外部镜像地址）
  - 取消本次请求
```

**注意**：若用户在步骤 2 选择了 "Standard"，则不显示"预制镜像"选项，直接进入自定义或第三方镜像选择。

#### 3a. 预制镜像

1. 使用步骤 2 已获取的训练框架 API 数据
2. 根据用户选择的框架名称，从 `data` 数组中找到对应框架
3. 若该框架只有 1 个镜像 → 自动选定，直接使用
4. 若有多个镜像 → `AskUserQuestion` 列出，展示格式：`<labels 中关键信息>`（如 version、cuda、python）
5. 用户选择后，取对应的 `image` 字段作为镜像地址

#### 3b. 自定义镜像

1. 静默执行：`python ../aios-base/scripts/get_image_registries.py`
2. 若只有一个仓库 → 自动选定；多个 → `AskUserQuestion` 列出仓库名称
3. 静默执行：`python ../aios-base/scripts/get_images.py --registry-id <仓库ID>`
4. `AskUserQuestion` 列出镜像列表（显示 `name:tag`，实际取 `image_path`）
5. 若镜像列表为空 → 提示"当前仓库无可用镜像"，回到镜像来源选择

#### 3c. 第三方镜像

```
question: 请输入第三方镜像地址（如 docker.io/xxx/yyy:tag）
options:
  - 输入镜像地址（Other）
  - 取消本次请求
```

用户直接输入完整镜像地址。

### 4. 数据选择

```
question: 请选择训练数据来源
options:
  - 选择数据集
  - 选择文件目录
  - 同时选择数据集和文件目录
  - 跳过（无需挂载数据）
  - 取消本次请求
```

#### 4a. 选择数据集

1. 静默执行：`python ../aios-base/scripts/get_dataset_list.py`
2. `AskUserQuestion` 列出数据集名称（`data` 数组中的 `name`）
3. 用户选择后，取对应的 `path` 作为 `hostPath`
4. **容器路径自动分配**：`/home/user/dataset`
5. 若用户选择多数据集：容器路径递增为 `/home/user/dataset/<数据集名称>`

#### 4b. 选择文件目录

1. 静默执行：`python ../aios-base/scripts/get_file_list.py`
2. `AskUserQuestion` 列出目录名称
3. 用户选择后，取对应的 `path` 作为 `hostPath`
4. **容器路径自动分配**：`/home/user/data`
5. 若需要进入子目录 → 再次执行 `python ../aios-base/scripts/get_file_list.py --path <相对路径>`

#### 4c. 同时选择

依次执行 4a 和 4b 的流程。

**重要**：数据选择完成后，向用户展示挂载映射关系，便于用户编写启动命令时引用正确的容器路径。

示例：
```
数据挂载映射：
  数据集 "my-dataset" → 容器路径 /home/user/dataset
  文件目录 "my-code" → 容器路径 /home/user/data
```

### 5. 启动命令

```
question: 请输入训练启动命令
options:
  - 输入启动命令（Other）
  - 取消本次请求
```

用户输入完整的训练启动命令（如 `python train.py --epochs 50 --lr 0.01`）。

**注意**：脚本会自动添加 `/bin/bash -c` 前缀，用户只需输入实际执行命令。

若用户选了数据挂载，提示中应包含挂载路径信息，方便用户在命令中引用。

### 6. 资源选择

#### 资源组

1. 静默执行：`python ../aios-base/scripts/get_project_detail.py`
2. 优先匹配关键词：`gpu`、`4090`、`nvidia`、`cuda`（不区分大小写）
3. 唯一匹配 → 自动选定
4. 多匹配或无匹配 → `AskUserQuestion` 列出所有选项

#### 资源规格

1. 从 `resourceSpec` 筛选 `specType == "gpu"`
2. 有 GPU 规格 → 取第一个自动选定
3. 无 GPU 规格 → 提示后让用户选择是否继续

### 7. 训练输出（可选）

```
question: 是否配置训练输出？
options:
  - 自动生成输出目录（推荐）
  - 从现有目录中选择
  - 不配置训练输出
  - 取消本次请求
```

#### 自动生成

1. 自动生成目录名：`train-output-<任务名称>`
2. 静默执行：`python ../aios-base/scripts/create_output_dir.py --dir-name <目录名>`
3. 容器路径默认：`/home/user/output`

#### 选择已有目录

1. 静默执行：`python ../aios-base/scripts/get_file_list.py`
2. `AskUserQuestion` 列出目录，用户选择
3. 容器路径默认：`/home/user/output`

### 8. 自动停止（可选）

```
question: 是否设置任务自动停止？
options:
  - 不自动停止
  - 1 小时后停止
  - 2 小时后停止
  - 自定义小时数（Other）
  - 取消本次请求
```

### 9. 确认并执行

展示完整配置摘要表格：

| 配置项 | 值 |
|-------|-----|
| 任务名称 | ... |
| 训练框架 | ... |
| 镜像 | ... |
| 启动命令 | ... |
| 数据集挂载 | 宿主机路径 → 容器路径 |
| 文件挂载 | 宿主机路径 → 容器路径 |
| 训练输出 | 宿主机路径 → 容器路径 |
| 资源组 | ... |
| 资源规格 | ... |
| 自动停止 | ... |

```
question: 确认以上配置？
options:
  - 确认发布
  - 取消本次请求
```

确认后执行：

```bash
python scripts/create_train_task.py \
  --task-name <任务名> \
  --resource-group-id <资源组ID> \
  --resource-spec-id <规格ID> \
  --image <镜像地址> \
  --command <启动命令> \
  [--dataset-mounts '<JSON>'] \
  [--file-mounts '<JSON>'] \
  [--output-container-path <容器路径>] \
  [--output-host-path <平台路径>] \
  [--auto-stop-hours <小时数>]
```

**示例**：

```bash
python scripts/create_train_task.py \
  --task-name train-20260420-3718 \
  --resource-group-id 3 \
  --resource-spec-id 123 \
  --image "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel" \
  --command "python train.py --epochs 50" \
  --dataset-mounts '[{"containerPath":"/home/user/dataset","hostPath":"/opt/bcc/storage2/users/poc/dataset"}]' \
  --output-container-path /home/user/output \
  --output-host-path /opt/bcc/storage2/users/poc/train-output-test
```

---

## 脚本速查

| 用途 | 脚本 |
|------|------|
| 前置检查 | `../aios-base/scripts/check_prerequisites.py` |
| 查询项目详情 | `../aios-base/scripts/get_project_detail.py` |
| 查询镜像仓库列表 | `../aios-base/scripts/get_image_registries.py` |
| 查询仓库镜像列表 | `../aios-base/scripts/get_images.py --registry-id <ID>` |
| 查询训练框架及预制镜像 | `../aios-base/scripts/get_train_frameworks.py` |
| 查询数据集列表 | `../aios-base/scripts/get_dataset_list.py` |
| 查询文件目录列表 | `../aios-base/scripts/get_file_list.py [--path <路径>]` |
| 创建输出目录 | `../aios-base/scripts/create_output_dir.py --dir-name <目录名>` |
| 创建训练任务 | `scripts/create_train_task.py` |

---

## 错误处理

| 错误 | 处理 |
|------|------|
| 未找到 token | 重新认证流程 |
| 未配置上下文 | 重新上下文流程 |
| 无可用镜像仓库 | 提示选择其他镜像来源 |
| 仓库无可用镜像 | 提示选择其他镜像来源或仓库 |
| 创建目录失败 | 提示从现有目录选择或不配置输出 |
| 任务创建失败 | 展示错误信息，提示检查配置 |

---

## 预制镜像说明

预制镜像通过平台 API 动态获取（`get_train_frameworks.py`），无需本地维护镜像列表。

**Standard** 框架代表单机训练（无分布式框架），不提供预制镜像，用户需自行提供镜像地址。

---

## 与 yolo-train 的关系

本 skill（aios-train）与 yolo-train 是**平级独立**关系：

- 共享 `aios-base` 基础层（认证、上下文、资源查询、镜像查询等）
- yolo-train 面向 YOLO 训练场景，自动配置镜像和命令
- 本 skill 面向通用训练场景，用户自主选择框架、镜像、数据和命令
- 两者互不依赖，可独立使用
