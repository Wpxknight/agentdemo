"""
更新微调任务配置（第二阶段：训练参数 + 数据集挂载）

用法：
  python scripts/update_finetune_config.py --task-id <任务ID> --finetuning-type lora --dataset-id <数据集ID>
  python scripts/update_finetune_config.py --task-id <任务ID> --finetuning-type full --learning-rate 1e-4 --epochs 5
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, api_put
from auth import get_auth_headers
from config import BASE_URL
from finetune_defaults import build_parameter_configuration, build_parameter_info


def main():
    parser = argparse.ArgumentParser(
        description="更新微调任务配置（训练参数 + 数据集挂载）",
    )
    # 必填参数
    parser.add_argument("--task-id", required=True, help="微调任务 ID")
    parser.add_argument("--finetuning-type", choices=["lora", "full", "freeze"], default="lora", help="微调方式（默认 lora）")
    # 数据集
    parser.add_argument("--dataset-id", default=None, help="数据集 ID（挂载到训练环境）")
    parser.add_argument("--dataset-name", default="", help="数据集名称")
    # DeepSpeed 配置
    parser.add_argument("--deepspeed-path", default=None, help="DeepSpeed 配置文件路径")
    # 数据挂载
    parser.add_argument("--data-path", default=None, help="数据挂载路径（文件管理）")
    # 标准训练参数
    parser.add_argument("--learning-rate", default=None, help="学习率（默认 5e-05）")
    parser.add_argument("--epochs", default=None, type=float, help="训练轮数（默认 3）")
    parser.add_argument("--batch-size", default=None, type=int, help="批处理大小（默认 2）")
    parser.add_argument("--gradient-accumulation", default=None, type=int, help="梯度累积步数（默认 8）")
    parser.add_argument("--cutoff-len", default=None, type=int, help="截断长度（默认 1024）")
    parser.add_argument("--calculation-type", default=None, choices=["fp16", "bf16", "fp32"], help="计算类型（默认 fp16）")
    parser.add_argument("--max-samples", default=None, type=int, help="最大样本数（默认 100000）")
    parser.add_argument("--val-size", default=None, type=int, help="验证集比例（默认 0）")
    parser.add_argument("--lr-scheduler-type", default=None, help="学习率调度器（默认 cosine）")
    parser.add_argument("--template", default=None, help="提示词模板（默认 default）")
    parser.add_argument("--quantization-bit", default=None, help="量化等级（默认 none）")
    parser.add_argument("--max-grad-norm", default=None, type=float, help="最大梯度范数（默认 1.0）")
    # LoRA 专属参数
    parser.add_argument("--lora-rank", default=None, type=int, help="LoRA 秩（默认 8）")
    parser.add_argument("--lora-alpha", default=None, type=int, help="LoRA 缩放系数（默认 16）")
    parser.add_argument("--lora-dropout", default=None, type=float, help="LoRA 随机丢弃（默认 0）")
    # 部分参数专属
    parser.add_argument("--freeze-layers", default=None, type=int, help="可训练层数（默认 2）")
    parser.add_argument("--freeze-modules", default=None, help="可训练模块名称（默认 all）")
    # 资源信息（从任务详情获取，更新时需要回传）
    parser.add_argument("--resource-group-id", default=None, help="资源组 ID（默认从任务详情获取）")
    parser.add_argument("--resource-spec-id", default=None, type=int, help="资源规格 ID（默认从任务详情获取）")
    args = parser.parse_args()

    headers = get_auth_headers()

    # 先获取任务详情，保留未修改的配置
    detail_result = api_get(f"{BASE_URL}/finetuneapi/model/finetune/{args.task_id}", headers)
    if detail_result.get("code") != 200:
        print(json.dumps({"success": False, "message": f"获取任务详情失败: {detail_result.get('message')}"}))
        sys.exit(1)

    detail = detail_result["data"]

    # 构建参数配置
    param_overrides = {}
    if args.learning_rate is not None:
        param_overrides["learning_rate"] = args.learning_rate
    if args.epochs is not None:
        param_overrides["epochs"] = args.epochs
    if args.batch_size is not None:
        param_overrides["batch_size"] = args.batch_size
    if args.gradient_accumulation is not None:
        param_overrides["gradient_accumulation"] = args.gradient_accumulation
    if args.cutoff_len is not None:
        param_overrides["cutoff_len"] = args.cutoff_len
    if args.calculation_type is not None:
        param_overrides["calculation_type"] = args.calculation_type
    if args.max_samples is not None:
        param_overrides["max_samples"] = args.max_samples
    if args.val_size is not None:
        param_overrides["val_size"] = args.val_size
    if args.lr_scheduler_type is not None:
        param_overrides["lr_scheduler_type"] = args.lr_scheduler_type
    if args.template is not None:
        param_overrides["template"] = args.template
    if args.quantization_bit is not None:
        param_overrides["quantization_bit"] = args.quantization_bit
    if args.max_grad_norm is not None:
        param_overrides["max_grad_norm"] = args.max_grad_norm
    if args.lora_rank is not None:
        param_overrides["lora_rank"] = args.lora_rank
    if args.lora_alpha is not None:
        param_overrides["lora_alpha"] = args.lora_alpha
    if args.lora_dropout is not None:
        param_overrides["lora_dropout"] = args.lora_dropout
    if args.freeze_layers is not None:
        param_overrides["freeze_layers"] = args.freeze_layers
    if args.freeze_modules is not None:
        param_overrides["freeze_modules"] = args.freeze_modules

    parameter_configuration = build_parameter_configuration(
        finetuning_type=args.finetuning_type,
        dataset_name=args.dataset_name,
        **param_overrides,
    )

    parameter_info = build_parameter_info(
        finetuning_type=args.finetuning_type,
        **param_overrides,
    )

    # 构建完整请求体
    body = {
        "id": args.task_id,
        "name": detail.get("name"),
        "namespace": detail.get("namespace"),
        "modelType": detail.get("modelType"),
        "modelVersion": detail.get("modelVersion"),
        "suspend": detail.get("suspend", True),
        "modelMount": detail.get("modelMount"),
        "projectId": detail.get("projectId"),
        "parameterConfiguration": parameter_configuration,
        "parameterInfo": parameter_info,
        "schedulerOptions": detail.get("schedulerOptions", {
            "schedulerName": "volcano",
            "queue": "default",
            "strategy": "spreadout",
            "priorityClassName": "optimize-med",
        }),
        "resourceGroupId": args.resource_group_id or detail.get("resourceGroupId"),
        "resourceSpecId": args.resource_spec_id or detail.get("resourceSpecId"),
        "shmSize": detail.get("shmSize", 1),
        "replicas": detail.get("instanceCount", 1),
        "instanceCount": detail.get("instanceCount", 1),
        "terminate": detail.get("terminate", False),
        "autoStopTime": detail.get("autoStopTime"),
        "exportConfig": detail.get("exportConfig", {
            "exportDir": "",
            "exportSize": 1,
            "exportLegacyFormat": "False",
        }),
    }

    # 数据集挂载
    if args.dataset_id is not None:
        body["datasetMount"] = {
            "id": str(args.dataset_id),
            "containerPath": "/app/data/data",
            "hostPath": f"/app/data/data",
            "type": "DirectoryOrCreate",
        }

    # DeepSpeed 配置挂载
    if args.deepspeed_path is not None:
        body["deepSpeedMount"] = {
            "containerPath": "/app/data/deepspeed",
            "hostPath": args.deepspeed_path,
            "type": "File",
        }

    # 输出目录挂载
    if args.data_path is not None:
        body["fileManagerMount"] = [
            {
                "containerPath": "/app/output",
                "hostPath": args.data_path,
                "type": "DirectoryOrCreate",
            }
        ]

    result = api_put(f"{BASE_URL}/finetuneapi/model/finetune/{args.task_id}", headers, json=body, timeout=30)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result.get("code") == 200:
        print(f"\n[成功] 微调任务 {args.task_id} 配置已更新", file=sys.stderr)
    else:
        print(f"\n[失败] {result.get('message')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
