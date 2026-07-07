---
name: aios-request
description: 当用户需要通过 API 调用操作 AIOS 平台，包括资源管理、任务提交、状态查询、微调任务、报表分析、用户引导、模型训练等接口操作时调用此技能。关键词：AIOS API、接口调用、资源管理、任务提交、状态查询、推理任务、训练任务、微调任务、YOLO 训练、LSTM 训练、算法训练、通用训练、报表分析、平台引导。
---

# AIOS 平台 API 操作

AIOS 平台通过 API 操作的能力，用于通过接口调用管理平台资源和执行操作。

## 适用场景

- AIOS 平台 API 接口调用
- 资源创建、查询、更新、删除
- 推理任务创建与管理（含模型查询、框架查询）
- 模型训练（算法训练、通用训练、YOLO 训练、LSTM 训练）
- 大模型微调任务管理
- 平台数据统计与报表分析
- 平台功能学习与操作引导
- 批量操作与自动化脚本

## 模块索引

| 模块 | 说明 | 详细文档 |
|------|------|---------|
| [aios-base](aios-base/SKILL.md) | 基础操作层：登录认证、租户/项目上下文切换、查询项目列表、数据集、文件目录、加速卡、资源规格等 | [SKILL.md](aios-base/SKILL.md) |
| [aios-infer](aios-infer/SKILL.md) | 推理任务管理：创建推理任务（支持模型仓库/训练任务作为模型来源）、查询/终止/删除推理任务、查询任务实例详情、查询推理框架和模型列表 | [SKILL.md](aios-infer/SKILL.md) |
| [aios-finetune](aios-finetune/SKILL.md) | 大模型微调：创建微调任务、配置训练参数（LoRA/全参数/部分参数）、启动/终止/删除微调任务 | [SKILL.md](aios-finetune/SKILL.md) |
| [aios-report](aios-report/SKILL.md) | 平台报表分析（管理员）：资源利用率、任务统计、用户活跃度排行、GPU 使用趋势、报表导出等 | [SKILL.md](aios-report/SKILL.md) |
| [aios-guide](aios-guide/SKILL.md) | 平台用户引导：帮助用户了解平台功能、学习操作流程、解答使用疑问 | [SKILL.md](aios-guide/SKILL.md) |
| [aios-algorithm](aios-algorithm/SKILL.md) | 统一模型训练：平台封装算法（YOLO、LSTM、ResNet50 等）快捷训练、IDE 交互式算法、通用训练 | [SKILL.md](aios-algorithm/SKILL.md) |
| [aios-train](aios-train/SKILL.md) | 通用模型训练：用户自定义 AI 框架、镜像、数据集、启动命令创建训练任务 | [SKILL.md](aios-train/SKILL.md) |
| [yolo-train](yolo-train/SKILL.md) | YOLO 模型训练：使用平台封装的 YOLO 算法镜像快速发起 YOLOv5 训练任务，支持快捷配置和自定义配置 | [SKILL.md](yolo-train/SKILL.md) |
| [lstm-train](lstm-train/SKILL.md) | LSTM 模型训练：使用平台封装的 LSTM 算法镜像快速发起语言模型训练任务 | [SKILL.md](lstm-train/SKILL.md) |

## 模块依赖关系

```
aios-base（基础层：认证、上下文、通用查询）
  ├── aios-infer（推理任务管理）
  ├── aios-finetune（大模型微调）
  ├── aios-report（平台报表分析）
  ├── aios-algorithm（统一模型训练，包含 YOLO/LSTM/通用训练能力）
  ├── aios-train（通用模型训练）
  ├── yolo-train（YOLO 模型训练）
  └── lstm-train（LSTM 模型训练）

aios-guide（独立：平台用户引导，不依赖 aios-base）
```

## 使用前准备

使用 API 操作类 skill 前，需在 `aios-base/scripts/config.py` 中配置以下信息：

- `BASE_URL` — 平台 API 地址
- `LOGIN_URL` — 平台登录地址
- `CLIENT_ID` — 客户端 ID

各业务 skill 会自动复用 aios-base 的认证和上下文能力。
