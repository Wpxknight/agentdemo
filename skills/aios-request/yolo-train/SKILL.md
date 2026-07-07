---
name: "yolo-train"
description: "使用平台封装的 YOLO 算法镜像快速发起模型训练任务。当用户提到 YOLO 训练、YOLOv5 训练时调用。"
---

# YOLO 训练任务技能

## 依赖

- `aios-base` skill（提供认证、上下文、基础查询能力）
- 两个 skill 必须位于同一父目录下（互为兄弟目录）

## 支持版本

从 `references/yolo_versions.yaml` 动态读取。当前支持：**YOLOv5**

若用户要求不支持的版本，回复：`该版本暂未支持`，并列出可用版本。

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
4. 完成后进入**模式选择**

### 阶段 2：模式选择

```
question: 请选择训练配置方式
options:
  - 快捷配置（agent 自动推荐所有参数，一次确认发布）
  - 自定义配置（逐步引导填写每项参数）
  - 取消本次请求
```

---

## 共享逻辑（两种模式共用）

以下规则在快捷和自定义模式中行为一致：

### 资源选择

**资源组**：
- 优先匹配关键词：`gpu`、`4090`、`nvidia`、`cuda`（不区分大小写）
- 唯一匹配 → 自动选定
- 多匹配或无匹配 → `AskUserQuestion` 列出所有选项

**资源规格**：
- 从 `resourceSpec` 筛选 `specType == "gpu"`
- 有 GPU 规格 → 取第一个自动选定
- 无 GPU 规格 → 提示后让用户选择是否继续

### 数据集验证

调用 `scripts/detect_yolo_datasets.py`：
- `no_dataset_found: true` → 提示"未检测到符合格式的数据集"，终止
- 有合法数据集 → 继续流程

### 任务名称生成

格式：`<版本前缀>-<yyyymmdd>-<4位随机数>`（RFC 1123）

示例：`yolov5-20260408-4821`

### 输出目录

自动创建：`<版本前缀>-output-<任务名>`

### 训练参数默认值

从 `references/yolo_versions.yaml` 的 `defaults` 节点读取。

---

## 快捷模式流程

1. **并行收集**：执行 `get_project_detail.py` + `detect_yolo_datasets.py`
2. **自动选定**：资源组、资源规格、数据集（第一个合法）
3. **使用默认值**：epoch、batch_size、base_lr（从版本配置读取）
4. **展示摘要**：表格形式展示全部配置
5. **确认或修改**：
   ```
   question: 确认以上配置，或选择要修改的项目
   options:
     - 确认发布
     - 修改任务名称
     - 修改数据集
     - 修改类别数
     - 修改训练参数
     - 修改自动停止
     - 取消本次请求
   ```
6. **执行创建**：调用脚本

---

## 自定义模式流程

### 1. 任务名称（可协商）

```
options:
  - 使用默认值：<版本前缀>-<时间戳>
  - 由我输入（Other）
  - 取消本次请求
```

### 2. 资源组与规格

使用**共享逻辑**的资源选择规则。

### 3. 数据集选择

使用**共享逻辑**的数据集验证规则，`AskUserQuestion` 列出合法数据集。

### 4. 类别数（必填）

```
question: 你的训练数据集有几个类别？
options:
  - 由我输入（Other）
  - 取消本次请求
```

### 5. 训练参数（可协商）

```
question: |
  请确认训练参数（默认值如下）：
  • epoch=<默认值>
  • batch_size=<默认值>
  • base_lr=<默认值>
options:
  - 使用全部默认值
  - 自定义参数（Other）
  - 取消本次请求
```

### 6. 输出目录

```
options:
  - 自动创建新目录（推荐）
  - 从现有目录中选择
  - 取消本次请求
```

### 7. 自动停止

```
question: 是否设置任务自动停止？
options:
  - 不自动停止
  - 1 小时后停止
  - 2 小时后停止
  - 自定义小时数（Other）
  - 取消本次请求
```

### 8. 确认并执行

展示配置摘要表格，`AskUserQuestion` 确认后执行。

---

## 脚本接口

```bash
python scripts/create_train_task.py \
  --yolo-version <版本ID> \
  --task-name <任务名> \
  --resource-group-id <ID> \
  --resource-spec-id <ID> \
  --dataset-host-path <数据集路径> \
  --output-host-path <输出路径> \
  --num-classes <N> \
  [--epoch N] [--batch-size N] [--base-lr F] \
  [--auto-stop-hours N]
```

**示例**：
```bash
python scripts/create_train_task.py \
  --yolo-version yolov5 \
  --task-name yolov5-20260408-test \
  --resource-group-id 3 \
  --resource-spec-id 123 \
  --dataset-host-path /opt/bcc/storage2/users/poc02-8/dataset \
  --output-host-path /opt/bcc/storage2/users/poc02-8/yolov5-output-test \
  --num-classes 5
```

---

## 脚本速查

| 用途 | 脚本 |
|------|------|
| 前置检查 | `../aios-base/scripts/check_prerequisites.py` |
| 查询项目详情 | `../aios-base/scripts/get_project_detail.py` |
| 检测 YOLO 数据集 | `scripts/detect_yolo_datasets.py` |
| 创建输出目录 | `../aios-base/scripts/create_output_dir.py` |
| 查询文件目录 | `../aios-base/scripts/get_file_list.py` |
| 创建训练任务 | `scripts/create_train_task.py` |

---

## 错误处理

| 错误 | 处理 |
|------|------|
| 未找到 token | 重新认证流程 |
| 未配置上下文 | 重新上下文流程 |
| 无合法数据集 | 提示上传 COCO JSON 格式数据集，终止 |
| 创建目录失败 | 提示从现有目录选择 |
| 不支持的 YOLO 版本 | 回复"该版本暂未支持" |

---

## 版本配置文件

所有版本相关的配置（镜像、路径、默认参数等）都在 `references/yolo_versions.yaml` 中管理。

添加新 YOLO 版本只需在该文件中增加一个条目，无需修改 SKILL.md 或脚本。
