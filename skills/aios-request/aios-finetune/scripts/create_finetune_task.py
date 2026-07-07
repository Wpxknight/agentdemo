"""
创建微调任务（第一阶段：基本信息 + 资源配置）
创建后任务处于 Suspend 状态，需通过 update_finetune_config.py 配置参数后再启动。

用法：
  python scripts/create_finetune_task.py --task-name <名称> --model-name <模型名> --resource-group-id <资源组ID> --resource-spec-id <规格ID>
"""

import argparse
import json
import os
import re
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_post, paginate_get
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id


def find_model_by_name(model_name: str) -> dict:
    """按模型名称查找可用于微调的模型。"""
    headers = get_auth_headers()
    all_records = paginate_get(
        f"{BASE_URL}/bccapi/modelNew/page", headers,
        params={"isShare": "true", "modelFlag": "1"},
        record_keys=("records", "list"),
        start_page=1, page_size=99999,
    )

    target = model_name.lower()
    matched = [r for r in all_records if r.get("modelName", "").lower() == target]

    if not matched:
        available = sorted(set(r.get("modelName", "") for r in all_records))
        print(f"[错误] 找不到名称为 '{model_name}' 的微调模型。", file=sys.stderr)
        print(f"[提示] 可用模型列表（共 {len(available)} 个）：", file=sys.stderr)
        for name in available:
            print(f"  - {name}", file=sys.stderr)
        sys.exit(1)

    model = matched[0]
    print(
        f"[info] 找到模型: {model.get('modelName')} (id={model.get('id')}, version={model.get('version')})",
        file=sys.stderr,
    )
    return model


def main():
    parser = argparse.ArgumentParser(
        description="创建微调任务（第一阶段：基本信息+资源配置）",
    )
    parser.add_argument("--task-name", required=True, help="微调任务名称")
    parser.add_argument("--model-name", required=True, help="模型名称，例如 Qwen2.5-7B-Instruct")
    parser.add_argument("--describe", default="", help="任务描述")
    parser.add_argument("--resource-group-id", required=True, help="资源组 ID")
    parser.add_argument("--resource-spec-id", required=True, type=int, help="资源规格 ID")
    parser.add_argument("--instance-count", type=int, default=1, help="实例数量（默认 1）")
    parser.add_argument("--shm-size", type=int, default=1, help="共享内存大小 GB（默认 1）")
    parser.add_argument("--rdma", action="store_true", help="是否启用 RDMA")
    parser.add_argument("--auto-stop-hours", type=int, default=None, help="自动停止小时数（不设置则不自动停止）")
    parser.add_argument("--project-id", default=None, help="项目 ID（默认使用当前上下文）")
    args = parser.parse_args()

    args.project_id = str(args.project_id or get_current_project_id())

    # 查找模型信息
    model = find_model_by_name(args.model_name)
    model_id = str(model.get("id"))
    model_version = model.get("id")
    model_version_str = model.get("version", "V1.0")
    model_path = model.get("savePath") or model.get("modelPath", "")

    # 构建请求体
    body = {
        "name": args.task_name,
        "describe": args.describe,
        "modelType": model.get("modelName"),
        "modelVersion": model_version,
        "modelMount": {
            "version": model_version_str,
            "id": model_id,
            "containerPath": "",
            "hostPath": model_path,
            "type": "DirectoryOrCreate",
        },
        "resourceGroupId": args.resource_group_id,
        "resourceSpecId": args.resource_spec_id,
        "instanceCount": args.instance_count,
        "shmSize": args.shm_size,
        "rdma": args.rdma,
        "suspend": True,
        "terminate": False,
        "projectId": int(args.project_id),
        "autoStopTime": args.auto_stop_hours * 3600 if args.auto_stop_hours else None,
    }

    headers = get_auth_headers()
    result = api_post(f"{BASE_URL}/finetuneapi/model/finetune", headers, json=body, timeout=30)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    task_id = None
    if isinstance(result.get("data"), dict):
        task_id = result["data"].get("id")

    if task_id:
        print(f"\n[成功] 微调任务已创建，任务ID: {task_id}", file=sys.stderr)
        print(f"[提示] 任务处于 Suspend 状态，请通过 update_finetune_config.py 配置训练参数", file=sys.stderr)
    elif result.get("code") != 200:
        print(f"\n[失败] {result.get('message')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
