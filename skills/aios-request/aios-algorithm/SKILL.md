---
name: "aios-algorithm"
description: "统一模型训练技能，支持平台封装的算法镜像快捷训练（YOLO、LSTM、ResNet50、PaddleSeg、RNA-Seq、SVD、线性回归等），也支持 IDE 交互式算法（时序预测、CNN 手写数字识别等），以及用户自定义框架的通用训练。当用户提到启动/训练/执行模型训练、算法训练、IDE 启动时调用。"
---

# 统一模型训练技能

## 依赖

- `aios-base` skill（提供认证、上下文、基础查询能力）
- 两个 skill 必须位于同一父目录下（互为兄弟目录）

## 核心原则

- 所有平台操作通过脚本执行，禁止手写 `curl`
- 执行本地 Python 脚本时使用 `python`（不要用 `python3`，Windows 不支持）
- `next_step` 是内部控制信号，不转述给用户
- 用户输入/选择场景必须使用 `AskUserQuestion`
- 对话消息只允许：**最终业务结果** 或 **配置摘要**
- 禁止流程播报（"我先检查"、"接下来"等）

---

## 能力范围

- **算法训练**（task_type: train）：检测平台已封装的算法模板（如 YOLO、LSTM、ResNet50、PaddleSeg、RNA-Seq、SVD、线性回归），支持快捷模式和自定义模式，通过命令行一键训练
- **IDE 交互式算法**（task_type: ide）：创建 Jupyter IDE 实例（如时序预测、CNN 手写数字识别），用户在平台 IDE 中交互式操作
- **通用训练**：用户自定义 AI 训练框架、镜像、数据集、启动命令等，创建平台训练任务
- 所有训练算法统一支持三种数据来源：从数据集选择、从文件路径选择、使用镜像自带数据

**不支持**：
- 训练任务的运行状态监控（使用 aios-user-api 相关功能）

---

## 标准流程

### 阶段 1：前置检查

复用 aios-base 的标准流程：

1. `python ../aios-base/scripts/check_prerequisites.py`
2. 按 `next_step` 走认证流程（`setup_auth`）
3. 按 `next_step` 走上下文选择（`resolve_context`）
4. 完成后进入**训练模式选择**

---

### 阶段 2：训练模式选择

读取 `references/algorithm_registry.yaml`，将用户输入中的关键词与各算法的 `keywords` 和 `name` 匹配。

**匹配逻辑**：
- 唯一匹配某个算法 → 自动选定，进入**算法版本选择**（阶段 3）
- 多匹配或无匹配 → `AskUserQuestion` 列出所有选项

```
question: 请选择训练方式
header: "训练方式"
options:
  - <算法 1 名称>（快捷训练）
  - <算法 2 名称>（IDE 交互）
  - 通用训练（自定义框架和镜像）
  - 取消本次请求
```

- 用户选择某个算法 → 检查该算法的 `task_type`：
  - `task_type: "train"` → 进入**算法版本选择**（阶段 3），走完整的训练配置流程
  - `task_type: "ide"` → 直接进入 **IDE 任务快速创建**（阶段 B），创建后展示 IDE 使用说明
- 用户选择"通用训练" → 直接进入**通用训练配置引导**（阶段 A）
- 若用户要求不支持的算法 → 回复：`该算法暂未封装`，列出可用算法，并将"通用训练"作为替代选项

---

## ─── 算法训练流程 ───

### 阶段 3：版本选择

读取用户选定算法的配置文件（如 `references/yolo.yaml`），获取 `versions` 下的版本列表。

- 单版本 → 自动选定，进入模式选择
- 多版本 → `AskUserQuestion` 列出版本

```
question: 请选择算法版本
header: "版本选择"
options:
  - <版本 1 名称>
  - <版本 2 名称>
  - 取消本次请求
```

---

### 阶段 4：模式选择

检查 algorithm_registry.yaml 中该算法的 `has_quick_mode`：

- `has_quick_mode: true` → 显示快捷/自定义两种模式
- `has_quick_mode: false` → 仅显示自定义模式

```
question: 请选择训练配置方式
header: "配置模式"
options:
  - 快捷配置（自动推荐参数，一次确认发布）
  - 自定义配置（逐步引导填写参数）
  - 取消本次请求
```

---

### 阶段 5：数据来源选择（所有算法统一流程）

所有算法统一支持三种数据来源。读取算法 YAML 中 `dataset_mount` 的配置：

```
question: 请选择训练数据来源
header: "数据来源"
options:
  - 从数据集选择
  - 从文件路径选择
  - 使用镜像自带数据
  - 取消本次请求
```

**注意**：若 `dataset_mount.allow_builtin` 为 `false`，则不显示"使用镜像自带数据"选项。

选择数据来源后，若用户选择"从数据集选择"或"从文件路径选择"，**必须先展示数据集格式要求**：

1. 读取 `references/dataset_format_guide.yaml` 中对应算法的条目
2. 向用户展示该算法的 `description` 和 `tree`（文件树结构）
3. 如果有 `notes`，也一并列出关键注意事项
4. 然后再列出数据集/文件目录供用户选择

展示格式示例：

```
【数据集格式要求】
YOLO 目标检测 — 需要 COCO JSON 格式的目标检测数据集

your_dataset/
├── _annotations.coco.json        # COCO 格式标注文件（必需，文件名固定）
└── train/                        # 训练图片目录（必需）
    ├── image001.jpg
    └── ...
```

> 注意：IDE 交互式算法（task_type: "ide"）不支持自定义数据，无需展示格式要求。

#### 5a. 从数据集选择

列出当前项目下所有数据集供用户选择，用户自行判断是否符合要求。

1. 执行 `python scripts/detect_datasets.py --algo-config <config_file> --algo-version <version_id>`
2. 默认列出所有数据集（`list_all` 策略）
3. **唯一例外**：YOLO 使用 `coco_json` 策略，自动检测数据集格式，只返回包含 COCO 标注文件的数据集
4. `no_dataset_found: true` → 提示"未检测到可用数据集"，终止
5. 有数据集 → 列出供用户选择
6. 候选项 ≤ 3 个 → `AskUserQuestion` 直接列出；候选项 > 3 个 → 先输出编号列表，再用精确输入型让用户输入编号

#### 5b. 从文件路径选择

列出当前用户文件目录供用户选择，用户自行判断是否符合要求。

1. 执行 `python ../aios-base/scripts/get_file_list.py`
2. `AskUserQuestion` 列出目录名称供选择，同时提供"手动输入路径"选项（Other）
3. 用户选择目录 → 直接使用该目录的绝对路径作为 `--dataset-host-path`，不做子目录浏览
4. 用户选择手动输入 → 用户输入完整平台路径（如 `/opt/bcc/storage2/users/poc02-8/mydata`）

#### 5c. 使用镜像自带数据

不传 `--dataset-host-path`，脚本自动使用 `builtin_data_path` 渲染命令。

---

### 阶段 6：共享逻辑（两种模式共用）

以下规则在快捷和自定义模式中行为一致。

#### 用户交互顺序规范

两种模式下，需要用户输入的信息**必须按以下固定顺序逐项收集**，不得跳步或乱序：

| 步骤 | 收集内容 | 快捷模式 | 自定义模式 |
|------|---------|---------|-----------|
| ① | 算法选择 | AskUserQuestion | AskUserQuestion |
| ② | 版本选择 | AskUserQuestion（多版本时） | AskUserQuestion（多版本时） |
| ③ | 模式选择 | AskUserQuestion | AskUserQuestion |
| ④ | 数据来源 | AskUserQuestion | AskUserQuestion |
| ⑤ | 具体数据集/文件 | AskUserQuestion | AskUserQuestion |
| ⑥ | 任务名称 | AskUserQuestion | AskUserQuestion |
| ⑦ | 资源选择 | 自动（唯一匹配时）；AskUserQuestion（多匹配时） | AskUserQuestion（始终展示） |
| ⑧ | 训练参数 | 不询问（使用默认值，展示在摘要中） | AskUserQuestion |
| ⑨ | 输出目录 | 自动创建 | AskUserQuestion |
| ⑩ | 自动停止 | 不询问（默认不停止） | AskUserQuestion |
| ⑪ | 确认发布 | AskUserQuestion | AskUserQuestion |

**并行优化**：步骤 ④⑤ 执行数据相关脚本时，可同时执行 `get_project_detail.py`（为步骤 ⑦ 资源选择准备数据），但**用户交互顺序不变**。

#### 任务名称

格式：`<版本 task_prefix>-<yyyymmdd>-<4位随机数>`（RFC 1123）

示例：`yolov5-20260408-4821`

**快捷模式**：自动生成，`AskUserQuestion` 让用户确认或自定义输入。

**自定义模式**：自动生成，`AskUserQuestion` 让用户确认或自定义输入。

```
question: 请确认任务名称
header: "任务名称"
options:
  - 使用默认值：<自动生成的名称>
  - 由我输入（Other）
  - 取消本次请求
```

#### 资源选择

读取算法 YAML 中的 `require_gpu` 字段，决定资源选择策略：

**资源组**：
- `require_gpu: true`：优先匹配关键词 `gpu`、`4090`、`nvidia`、`cuda`（不区分大小写），匹配后取 `id` 字段传给脚本
- `require_gpu: false`：匹配**不包含** GPU 关键词的资源组
- 唯一匹配 → 自动选定（快捷模式）或展示默认值让用户确认（自定义模式）
- 多匹配或无匹配 → `AskUserQuestion` 列出所有选项（用 `name` 展示，用 `id` 传参）

**资源规格**：
- `require_gpu: true`：从 `resourceSpec` 筛选 `specType == "gpu"`，取第一个自动选定
- `require_gpu: false`：从 `resourceSpec` 筛选 `specType == "cpu"`，取第一个自动选定
- 无匹配规格 → 提示后让用户选择是否继续

#### 输出目录

**快捷模式**：自动创建，格式 `<版本 task_prefix>-output-<任务名>`，无需用户确认。

**自定义模式**：`AskUserQuestion` 让用户选择。

```
question: 请选择训练输出方式
header: "输出目录"
options:
  - 自动创建新目录（推荐）
  - 从现有目录中选择
  - 取消本次请求
```

---

### 算法快捷模式流程

按用户交互顺序规范，快捷模式执行以下步骤：

**⑥ 任务名称**：自动生成后 `AskUserQuestion` 让用户确认或自定义。

**⑦ 资源选择**：自动选定资源组和规格（唯一匹配时直接选定，多匹配时 `AskUserQuestion` 让用户选择）。

**⑧ 训练参数**：不询问，从版本配置的 `params` 中读取默认值，`ask_in_quick: true` 的参数直接展示在摘要中。

**⑨ 输出目录**：自动创建，无需用户输入。

**⑩ 自动停止**：不询问，默认不自动停止。

**⑪ 展示摘要并确认**：

表格形式展示全部配置：

```markdown
任务配置确认：
- 任务名称：yolov5-20260408-4821
- 算法：YOLOv5
- 数据来源：数据集 "my-coco-dataset"
- 资源组：poc-nvidia-4090
- 资源规格：NVIDIA-RTX-4090 × 1
- 训练参数：epoch=30, batch_size=8, base_lr=0.01, num_classes=5
- 输出目录：yolov5-output-yolov5-20260408-4821
```

```
question: 确认以上配置，或选择要修改的项目
header: "确认配置"
options:
  - 确认发布
  - 修改任务名称
  - 修改数据集
  - 修改训练参数
  - 取消本次请求
```

> 注意：选项最多 4 个（含"取消本次请求"）。若需修改的项超过 2 个，将可修改项合并为"修改训练参数"一个选项。

确认后调用 `scripts/create_train_task.py`。

---

### 算法自定义模式流程

按用户交互顺序规范，自定义模式在阶段 5（数据来源）之后执行以下步骤：

#### ⑥ 任务名称

自动生成后 `AskUserQuestion` 让用户确认或自定义。

#### ⑦ 资源组与规格

使用共享逻辑的资源选择规则。自定义模式下始终展示资源信息让用户确认。

#### ⑧ 训练参数（动态，按 YAML params 定义驱动）

读取算法 YAML 中该版本的 `params` section，按以下规则与用户交互：

- `required: true` 的参数 → 无论哪种模式都必须询问
- `ask_in_custom: true` 的参数 → 自定义模式中询问
- 参数有 `options` 列表 → 用**选择型**交互，列出各选项的 `label`
- 参数无 `options` → 用**精确输入型**交互（Other 触发输入框）
- 参数有 `default` 且非必填 → 先展示默认值，用户可选"使用默认值"或"自定义"
- 参数有 `show_when` 条件 → 仅当 `show_when.param` 的值等于 `show_when.value` 时才展示该参数

```
question: 请确认训练参数（默认值如下）：
  • <param1>=<default1>
  • <param2>=<default2>
header: "训练参数"
options:
  - 使用全部默认值
  - 自定义参数（Other）
  - 取消本次请求
```

若用户选择"自定义参数"，针对每个 `ask_in_custom: true` 的参数逐一询问。

#### ⑨ 输出目录

使用共享逻辑的输出目录规则，`AskUserQuestion` 让用户选择。

#### ⑩ 自动停止

```
question: 是否设置任务自动停止？
header: "自动停止"
options:
  - 不自动停止
  - 2 小时后停止
  - 自定义时间（Other）
  - 取消本次请求
```

#### ⑩a. 构建算法参数（特殊算法处理，无用户交互）

大多数算法的 `algo_params` 直接从 `params` 定义的参数值收集即可。以下算法需要特殊处理：

**SVD（两种算法共享一个版本）**：

`command_template` 使用 `{{train_script}}` 和 `{{algo_args}}` 两个动态占位符，SKILL.md 需根据 `algorithm_type` 参数构建：

- `algorithm_type = "surprise_svd"`：
  - `train_script` = `surprise_svd_recommender.py`
  - `algo_args` = `--ratings {data_path}/ratings_small.csv --factors {factors} --epochs {epochs}`
- `algorithm_type = "traditional_svd"`：
  - `train_script` = `traditional_svd_recommender.py`
  - `algo_args` = `--ratings {data_path}/ratings_small.csv --k {k} --top-n {top_n}`

其中 `data_path` 的确定规则与阶段 5 一致：有外部数据集挂载时用 `dataset_container_path`，否则用 `builtin_data_path`。

最终 `algo_params` 包含 `train_script` 和 `algo_args` 两个键，传给 `create_train_task.py --algo-params`。

**线性回归**：无特殊处理（无 params，command_template 固定为 `cd {{work_dir}} && python3 linear.py`，传空 `algo_params '{}'` 即可）。

**ResNet50**：无特殊处理（params 已定义 epochs、batch_size、lr，command_template 直接调用 PaddleClas/tools/train.py 并通过 `-o` 传递参数）。

#### ⑪ 确认并执行

展示完整配置摘要表格，`AskUserQuestion` 确认后执行 `scripts/create_train_task.py`。。

---

## ─── 通用训练流程 ───

### 阶段 A：通用训练配置引导

当用户在阶段 2 选择"通用训练"时，进入以下流程。无快捷模式，全部为自定义引导。

#### A1. 任务名称（可协商）

格式：`train-<YYYYMMDD>-<4位随机数>`

```
question: 请确认训练任务名称
header: "任务名称"
options:
  - 使用默认名称：<自动生成的名称>
  - 由我输入（Other）
  - 取消本次请求
```

#### A2. AI 训练框架

1. 静默执行：`python ../aios-base/scripts/get_train_frameworks.py`
2. 从返回的 `data` 数组中提取所有框架名称，额外加上 "Standard" 选项
3. `AskUserQuestion` 列出所有框架供用户选择

```
question: 请选择训练框架
header: "训练框架"
options:
  - Standard（单机训练，无分布式框架）
  - <API 返回的各框架名称，如 PyTorch、TensorFlow 等>
  - 取消本次请求
```

记录用户选择的框架名称，后续用于：
- 若选 **Standard** → 无预制镜像，用户必须通过自定义或第三方镜像提供
- 若选 **其他框架** → 可直接使用该框架的预制镜像，也可选择自定义/第三方镜像

#### A3. 镜像选择

```
question: 请选择镜像来源
header: "镜像来源"
options:
  - 预制镜像（使用当前框架的推荐镜像）
  - 自定义镜像（从平台镜像仓库选择）
  - 第三方镜像（输入外部镜像地址）
  - 取消本次请求
```

**注意**：若用户在 A2 选择了 "Standard"，则不显示"预制镜像"选项，直接进入自定义或第三方镜像选择。

##### A3a. 预制镜像

1. 使用 A2 已获取的训练框架 API 数据
2. 根据用户选择的框架名称，从 `data` 数组中找到对应框架
3. 若该框架只有 1 个镜像 → 自动选定，直接使用
4. 若有多个镜像 → `AskUserQuestion` 列出，展示格式：`<labels 中关键信息>`（如 version、cuda、python）
5. 用户选择后，取对应的 `image` 字段作为镜像地址

##### A3b. 自定义镜像

1. 静默执行：`python ../aios-base/scripts/get_image_registries.py`
2. 若只有一个仓库 → 自动选定；多个 → `AskUserQuestion` 列出仓库名称
3. 静默执行：`python ../aios-base/scripts/get_images.py --registry-id <仓库ID>`
4. `AskUserQuestion` 列出镜像列表（显示 `name:tag`，实际取 `image_path`）
5. 若镜像列表为空 → 提示"当前仓库无可用镜像"，回到镜像来源选择

##### A3c. 第三方镜像

```
question: 请输入第三方镜像地址（如 docker.io/xxx/yyy:tag）
header: "镜像地址"
options:
  - 输入镜像地址（Other）
  - 取消本次请求
```

用户直接输入完整镜像地址。

#### A4. 数据选择

```
question: 请选择训练数据来源
header: "数据来源"
options:
  - 选择数据集
  - 选择文件目录
  - 跳过（无需挂载数据）
  - 取消本次请求
```

##### A4a. 选择数据集

1. 静默执行：`python ../aios-base/scripts/get_dataset_list.py`
2. `AskUserQuestion` 列出数据集名称（`data` 数组中的 `name`）
3. 用户选择后，取对应的 `path` 作为 `hostPath`
4. **容器路径自动分配**：`/home/user/dataset`
5. 若用户选择多数据集：容器路径递增为 `/home/user/dataset/<数据集名称>`

##### A4b. 选择文件目录

1. 静默执行：`python ../aios-base/scripts/get_file_list.py`
2. `AskUserQuestion` 列出目录名称，同时提供"手动输入路径"选项（Other）
3. 用户选择目录 → 取对应的 `path` 作为 `hostPath`，不做子目录浏览
4. 用户选择手动输入 → 用户输入完整平台路径
5. **容器路径自动分配**：`/home/user/data`

**重要**：数据选择完成后，向用户展示挂载映射关系，便于用户编写启动命令时引用正确的容器路径。

```
数据挂载映射：
  数据集 "my-dataset" → 容器路径 /home/user/dataset
  文件目录 "my-code" → 容器路径 /home/user/data
```

#### A5. 启动命令

```
question: 请输入训练启动命令
header: "启动命令"
options:
  - 输入启动命令（Other）
  - 取消本次请求
```

用户输入完整的训练启动命令（如 `python train.py --epochs 50 --lr 0.01`）。

**注意**：脚本会自动添加 `/bin/bash -c` 前缀，用户只需输入实际执行命令。

若用户选了数据挂载，提示中应包含挂载路径信息，方便用户在命令中引用。

#### A6. 资源选择

**资源组**：
1. 静默执行：`python ../aios-base/scripts/get_project_detail.py`
2. 优先匹配关键词：`gpu`、`4090`、`nvidia`、`cuda`（不区分大小写）
3. 唯一匹配 → 自动选定
4. 多匹配或无匹配 → `AskUserQuestion` 列出所有选项

**资源规格**：
1. 从 `resourceSpec` 筛选 `specType == "gpu"`
2. 有 GPU 规格 → 取第一个自动选定
3. 无 GPU 规格 → 提示后让用户选择是否继续

#### A7. 训练输出（可选）

```
question: 是否配置训练输出？
header: "训练输出"
options:
  - 自动生成输出目录（推荐）
  - 从现有目录中选择
  - 不配置训练输出
  - 取消本次请求
```

##### 自动生成

1. 自动生成目录名：`train-output-<任务名称>`
2. 静默执行：`python ../aios-base/scripts/create_output_dir.py --dir-name <目录名>`
3. 容器路径默认：`/home/user/output`

##### 选择已有目录

1. 静默执行：`python ../aios-base/scripts/get_file_list.py`
2. `AskUserQuestion` 列出目录，用户选择
3. 容器路径默认：`/home/user/output`

#### A8. 自动停止（可选）

```
question: 是否设置任务自动停止？
header: "自动停止"
options:
  - 不自动停止
  - 2 小时后停止
  - 自定义时间（Other）
  - 取消本次请求
```

#### A9. 确认并执行

展示完整配置摘要表格：

```markdown
任务配置确认：
- 任务名称：train-20260420-3718
- 训练框架：PyTorch
- 镜像：pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel
- 启动命令：python train.py --epochs 50
- 数据集挂载：宿主机路径 → 容器路径 /home/user/dataset
- 文件挂载：宿主机路径 → 容器路径 /home/user/data
- 训练输出：宿主机路径 → 容器路径 /home/user/output
- 资源组：poc-nvidia-4090
- 资源规格：NVIDIA-RTX-4090 × 1
- 自动停止：不自动停止
```

```
question: 确认以上配置？
header: "确认发布"
options:
  - 确认发布
  - 取消本次请求
```

确认后执行 `scripts/create_generic_train_task.py`。

---

## ─── IDE 交互式算法流程 ───

### 阶段 B：IDE 任务快速创建

当用户在阶段 2 选择 `task_type: "ide"` 的算法时，进入此流程。这类算法在平台 Jupyter IDE 中交互式操作，无需配置训练参数。

#### B1. 任务名称（可协商）

格式：`<版本 task_prefix>-<yyyymmdd>-<4位随机数>`（RFC 1123）

```
question: 请确认任务名称
header: "任务名称"
options:
  - 使用默认值：<自动生成的名称>
  - 由我输入（Other）
  - 取消本次请求
```

#### B2. 资源选择

使用**共享逻辑**（阶段 6）的资源选择规则。

#### B3. 自动停止（可选）

```
question: 是否设置任务自动停止？
header: "自动停止"
options:
  - 不自动停止
  - 2 小时后停止
  - 自定义时间（Other）
  - 取消本次请求
```

#### B4. 确认并创建

展示配置摘要：

```markdown
任务配置确认：
- 任务名称：tsf-20260427-3847
- 算法：时序预测（IDE 交互式）
- 资源组：poc-nvidia-4090
- 自动停止：不自动停止
```

```
question: 确认以上配置？
header: "确认发布"
options:
  - 确认发布
  - 取消本次请求
```

确认后执行 `scripts/create_ide_task.py`。

#### B5. 创建成功 — 展示 IDE 使用说明

任务创建成功后，读取算法 YAML 中的 `ide_usage` 字段，向用户展示 IDE 操作指南：

```markdown
IDE 任务已创建成功！

使用方法：
1. 进入平台【算法开发】→【任务管理】，找到刚创建的任务，等待状态变为"运行中"
2. 点击【打开】进入 Jupyter IDE
3. 双击打开 "时间序列数据分析与特征提取.ipynb"
4. 依次运行前 5 个单元格的代码
5. 后续单元格可按需求运行：
   - 想对每月客流量进行可视化 → 运行"抽取月份信息"单元格
   - 想查看节假日和非节假日客流量区别 → 运行"节假日信息"单元格
```

---

## 脚本接口

### 算法训练任务

```bash
python scripts/create_train_task.py \
  --algo-config <算法配置文件路径> \
  --algo-version <版本ID> \
  --task-name <任务名> \
  --resource-group-id <资源组ID> \
  --resource-spec-id <规格ID> \
  --output-host-path <输出路径> \
  --algo-params '<算法参数JSON>' \
  [--dataset-host-path <数据集路径>] \
  [--auto-stop-hours N]
```

**algo-params 格式**：算法特定参数的 JSON 对象，键名对应 `command_template` 中的 `{{占位符}}`。

示例（YOLO，挂载数据集）：
```bash
python scripts/create_train_task.py \
  --algo-config references/yolo.yaml \
  --algo-version yolov5 \
  --task-name yolov5-20260408-test \
  --resource-group-id ae6a4e72-096e-413f-8c54-b4bea61d2456 \
  --resource-spec-id 58 \
  --output-host-path /opt/bcc/storage2/users/poc02-8/yolov5-output-test \
  --algo-params '{"epoch":30,"batch_size":8,"base_lr":0.01,"num_classes":5}' \
  --dataset-host-path /opt/bcc/storage2/users/poc02-8/dataset
```

示例（LSTM，使用镜像自带数据）：
```bash
python scripts/create_train_task.py \
  --algo-config references/lstm.yaml \
  --algo-version paddle_lstm \
  --task-name lstm-20260421-test \
  --resource-group-id ae6a4e72-096e-413f-8c54-b4bea61d2456 \
  --resource-spec-id 58 \
  --output-host-path /opt/bcc/storage2/users/poc02-8/lstm-output-test \
  --algo-params '{"model_type":"small","rnn_model":"basic_lstm"}'
```

### IDE 任务

```bash
python scripts/create_ide_task.py \
  --algo-config <算法配置文件路径> \
  --algo-version <版本ID> \
  --task-name <任务名> \
  --resource-group-id <资源组ID> \
  --resource-spec-id <规格ID> \
  [--auto-stop-hours N]
```

示例：
```bash
python scripts/create_ide_task.py \
  --algo-config references/tsf.yaml \
  --algo-version tsf \
  --task-name tsf-20260427-test \
  --resource-group-id ae6a4e72-096e-413f-8c54-b4bea61d2456 \
  --resource-spec-id 76
```

### 通用训练任务

```bash
python scripts/create_generic_train_task.py \
  --task-name <任务名> \
  --resource-group-id <资源组ID> \
  --resource-spec-id <规格ID> \
  --image <镜像地址> \
  --command <启动命令> \
  [--dataset-mounts '<JSON>'] \
  [--file-mounts '<JSON>'] \
  [--output-container-path <容器路径>] \
  [--output-host-path <平台路径>] \
  [--auto-stop-hours N]
```

示例：
```bash
python scripts/create_generic_train_task.py \
  --task-name train-20260420-3718 \
  --resource-group-id 3 \
  --resource-spec-id 123 \
  --image "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel" \
  --command "python train.py --epochs 50" \
  --dataset-mounts '[{"containerPath":"/home/user/dataset","hostPath":"/opt/bcc/storage2/users/poc/dataset"}]' \
  --output-container-path /home/user/output \
  --output-host-path /opt/bcc/storage2/users/poc/output
```

---

## 脚本速查

| 用途 | 脚本 |
|------|------|
| 前置检查 | `../aios-base/scripts/check_prerequisites.py` |
| 查询项目详情 | `../aios-base/scripts/get_project_detail.py` |
| 列出已注册算法 | `scripts/list_algorithms.py` |
| 检测数据集（算法训练） | `scripts/detect_datasets.py --algo-config <config> --algo-version <version>` |
| 查询训练框架及预制镜像 | `../aios-base/scripts/get_train_frameworks.py` |
| 查询镜像仓库列表 | `../aios-base/scripts/get_image_registries.py` |
| 查询仓库镜像列表 | `../aios-base/scripts/get_images.py --registry-id <ID>` |
| 查询数据集列表（通用训练） | `../aios-base/scripts/get_dataset_list.py` |
| 查询文件目录列表 | `../aios-base/scripts/get_file_list.py` |
| 创建输出目录 | `../aios-base/scripts/create_output_dir.py` |
| 创建算法训练任务 | `scripts/create_train_task.py` |
| 创建 IDE 任务 | `scripts/create_ide_task.py` |
| 创建通用训练任务 | `scripts/create_generic_train_task.py` |

---

## 错误处理

| 错误信息 | 原因 | 解决方式 |
|---------|------|---------|
| 未找到有效 token | 未认证或 token 已过期 | 静默执行 check_prerequisites.py |
| 未配置租户/项目 | 上下文未设置 | 静默执行上下文选择流程 |
| 未知的版本 | 版本 ID 不存在 | 提示可用版本列表 |
| 未检测到可用数据集 | 无合规数据集或项目无数据集 | 提示上传数据集或选择其他来源 |
| 创建目录失败 | 平台路径错误 | 提示从现有目录选择 |
| 创建任务失败 | API 错误 | 展示错误信息，建议检查资源配置 |

---

## 版本配置文件

所有算法配置位于 `references/` 目录下：

- `algorithm_registry.yaml` — 算法注册表（索引）
- `yolo.yaml` — YOLO 算法配置
- `lstm.yaml` — LSTM 算法配置
- `resnet50.yaml` — ResNet50 算法配置
- `paddleseg.yaml` — PaddleSeg 算法配置
- `rnaseq.yaml` — RNA-Seq 转录组分析配置
- `tsf.yaml` — 时序预测配置（IDE 交互式）
- `cnn_mnist.yaml` — CNN 手写数字识别配置（IDE 交互式）
- `svd.yaml` — SVD 奇异值分解配置
- `linear_regression.yaml` — 线性回归配置

**新增算法**只需：
1. 创建 `references/<algo_id>.yaml` 配置文件（参考现有 yaml 结构）
2. 在 `algorithm_registry.yaml` 中添加注册条目

无需修改 SKILL.md 或任何 Python 脚本。
