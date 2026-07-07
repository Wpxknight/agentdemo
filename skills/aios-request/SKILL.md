---
name: aios-request
description: 当用户需要通过 API 调用操作 AIOS 平台，包括资源管理、任务提交、状态查询、微调任务、报表分析、用户引导、模型训练等接口操作时调用此技能。关键词：AIOS API、接口调用、资源管理、任务提交、状态查询、推理任务、训练任务、微调任务、YOLO 训练、LSTM 训练、算法训练、通用训练、报表分析、平台引导。
---

# AIOS 平台 API 操作

AIOS 平台通过 API 操作的能力，用于通过接口调用管理平台资源和执行操作。

## 执行流程（必须按此顺序）

1. **加载技能**：`load_skill("aios-request")`（你已完成这一步）。
2. **同步到沙箱**：`skill__sync_to_sandbox(name="aios-request")`，脚本会落到沙箱
   `/workspace/skills/aios-request/`。注意返回结果里的 skipped 清单（大文件默认不同步，
   需要时用 `paths` 参数显式指定）。
3. **读子模块文档**：按任务从下方模块索引选择模块，用
   `skill__read_file(name="aios-request", path="<模块>/SKILL.md")` 阅读；
   除 `aios-guide` 外的模块都依赖 `aios-base`，先读 `aios-base/SKILL.md`。
4. **准备环境变量**（沙箱内检查，缺失就向用户询问后 export，禁止写死进任何文件）：
   | 变量 | 必需 | 说明 |
   |---|---|---|
   | `AIOS_BASE_URL` | 是 | 平台 API 地址，如 `http://<host>:<port>/paas-web` |
   | `AIOS_CLIENT_ID` | 是 | 登录换 token 的客户端 ID |
   | `AIOS_LOGIN_URL` | 否 | 缺省取 BASE_URL 的 origin |
   | `AIOS_SYSTEM_ID` | 否 | 默认 `1` |
   | `AIOS_CLUSTER_NAME` | 否 | 涉及集群资源的脚本需要 |
   管理员可能已通过服务端配置把部分变量注入沙箱，先 `env | grep AIOS_` 检查。
5. **认证**：账号密码**只能**来自用户当轮对话（若用户已在消息里给出则直接使用，否则询问）。
   在沙箱内执行：
   `cd /workspace/skills/aios-request/aios-base/scripts && export AIOS_USERNAME='<账号>' AIOS_PASSWORD='<密码>' && python setup_auth.py`
   凭据禁止写入任何持久文件、禁止出现在最终汇报里；token 缓存在沙箱内，随沙箱销毁。
6. **执行业务脚本**：在沙箱 `/workspace/skills/aios-request/<模块>/scripts/` 下运行，
   依赖 `requests`/`cryptography`（缺失时 `pip install requests cryptography`）。

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

环境信息一律通过环境变量提供（见上方"执行流程"第 4 步的变量表），
`aios-base/scripts/config.py` 只从环境变量读取，**不写死任何平台地址或密钥**。
各业务 skill 会自动复用 aios-base 的认证和上下文能力。

模块索引中的相对链接（如 `aios-base/SKILL.md`）请用
`skill__read_file(name="aios-request", path="...")` 读取。
