---
name: "aios-report"
description: "平台数据统计与报表分析 Skill，为管理员提供资源利用率、任务统计、用户活跃度排行、GPU 使用趋势等多维度数据分析。当用户需要查看资源消耗排行、任务分布统计、健康状态报表、用户活跃度分析、导出报表等统计类问题时调用。注意：基础的列表查询操作（如列出项目、查看任务列表）不属于本 skill，请使用 aios-infer skill 或 aios-finetune skill。"
---

# 平台报表生成技能

## 依赖

- `aios-base` skill（提供认证模块：`auth.py`、`config.py`、`api_utils.py`）
- 两个 skill 必须位于同一父目录下（互为兄弟目录）

## 能力边界

**本 skill 只能执行"脚本速查"表中列出的操作，不在表中的一律拒绝。**

禁止行为：
- 不要为用户不支持的操作自行编写脚本或代码
- 不要调用 `scripts/` 目录及 `../aios-base/scripts/` 以外的任何工具或命令
- 不要尝试推断、拼凑或变通实现表中不存在的功能

当用户请求不支持的操作时，只需告知：
`该操作暂不支持，当前可用功能请参考：<列出脚本速查表中的操作名称>`

## 核心原则

- 所有平台操作通过脚本执行，禁止手写 `curl`
- `next_step` 是内部控制信号，不转述给用户
- 用户输入/选择场景必须使用 `AskUserQuestion`
- 对话消息只允许：**最终业务结果**（报表数据、分析结论、导出路径）
- 禁止流程播报（"我先检查"、"认证成功"、"接下来"等）

## 定位说明

- **管理员专属**：报表 API 为管理员端接口，需验证管理员权限后才能使用
- **不需要租户/项目上下文**：报表 API 以管理员身份全局查询（modelId=0，projectId 为空）
- **共享认证**：与 `aios-base` 共用 `token.json`

---

## 标准流程

1. 用户发出报表查询指令后，agent 静默执行：

```
python scripts/check_report_permissions.py
```

2. 读取返回 JSON 中的 `next_step`：
   - `setup_auth` → 进入认证流程（复用 aios-base 的认证）
   - `forbidden` → 当前用户不是管理员，直接告知：`当前账号不是管理员，报表功能仅限管理员使用。`，终止流程
   - `run_business_script` → 是管理员，直接执行业务脚本

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

4. 认证完成后重新执行 `python scripts/check_report_permissions.py` 验证管理员权限。认证脚本 `setup_auth.py` 位于 `../aios-base/scripts/` 目录。

---

## 脚本速查

### 前置检查

| 用户意图 | 脚本命令 |
|---------|---------|
| 权限验证 | `python scripts/check_report_permissions.py` |

### 基础查询

| 用户意图 | 脚本命令 |
|---------|---------|
| 集群列表 | `python scripts/get_cluster_list.py` |
| 节点列表（健康状态） | `python scripts/get_node_list.py` |
| 加速卡列表（卡片级详情） | `python scripts/get_accel_card_list.py [--cluster-name <集群名>] [--all]` |
| 资源规格（整卡/切分） | `python scripts/get_admin_resource_specs.py` |
| 项目列表 | `python scripts/get_admin_project_list.py [--page <页码>] [--page-size <条数>]` |
| 项目详情（成员+配额） | `python scripts/get_admin_project_detail.py --project-id <项目ID>` |
| 资源报表 | `python scripts/get_resource_report.py [--resource-type <类型>] [--cluster-name <集群名>] [--user-name <用户名>] [--page <页码>] [--page-size <条数>] [--all]` |
| 任务报表 | `python scripts/get_task_report.py [--task-type <类型>] [--task-status <状态>] [--cluster-name <集群名>] [--user-name <用户名>] [--start-time <开始时间>] [--end-time <结束时间>] [--project-id <项目ID>] [--page <页码>] [--page-size <条数>] [--all]` |
| 资源利用率趋势 | `python scripts/get_resource_trend.py [--days <天数>]` |
| 资源度量列表 | `python scripts/get_resource_measure.py [--days <天数>] [--page <页码>] [--page-size <条数>] [--all]` |
| 平台总览 | `python scripts/get_platform_overview.py [--cluster-name <集群名>]` |

### 数据分析

| 用户意图 | 脚本命令 |
|---------|---------|
| 综合分析 | `python scripts/analyze_report.py --analysis <分析类型> [筛选参数...]` |

分析类型：
- `top-consumers`：任务资源消耗排行
- `user-resource-stats`：用户资源统计
- `gpu-split-stats`：加速卡切分统计
- `health-report`：健康状态报表
- `task-status-dist`：任务状态分布
- `user-ranking`：活跃度排行
- `idle-detection`：空闲资源检测
- `project-overview`：项目资源概览

### 报表导出

| 用户意图 | 脚本命令 |
|---------|---------|
| 导出 Excel | `python scripts/export_xlsx.py --analysis <分析类型> --output <文件路径> [筛选参数...]` |

---

## 参数说明

### 资源类型（--resource-type）

| 中文名 | 参数值 |
|--------|--------|
| 加速卡 | `GPU` |
| CPU | `CPU` |
| 显存 | `GPU_Memory` |
| 内存 | `Memory` |

### 任务类型（--task-type）

| 中文名 | 参数值 |
|--------|--------|
| 训练任务 | `train` |
| 推理任务 | `infer` |
| 模型评估 | `evaluate` |
| 模型转换 | `model_convert` |
| 算法开发 | `algorithm_dev` |
| 模型压缩 | `model_compress` |
| 大模型微调 | `model_optimization` |
| AutoML | `automl` |
| 数据标注 | `annotation` |
| 仿真训练 | `simulation` |

### 任务状态（--task-status）

| 中文名 | 参数值 |
|--------|--------|
| 未开始 | `Suspend` |
| 排队中 | `Pending` |
| 运行中 | `Running` |
| 异常 | `Failed` |
| 终止 | `Terminated` |
| 已完成 | `Completed` |
| 运行成功 | `Succeeded` |

### 时间参数

- `--start-time` / `--end-time`：格式 `YYYY-MM-DD HH:MM:SS`，如 `2026-04-01 00:00:00`
- `--days <N>`：最近 N 天（自动计算起止时间，默认 7 天）

---

## 错误处理

| 错误信息 | 原因 | 解决方式 |
|---------|------|---------|
| 未找到有效 token | 未认证或 token 已过期 | 静默执行认证流程 |
| 当前账号不是管理员 | 非管理员账号 | 告知用户报表功能仅限管理员 |
| 报表接口返回错误 | 权限不足或参数错误 | 检查参数格式，确认管理员权限 |
| 网络连接失败 | 平台不可达 | 告知用户检查网络或平台状态 |
