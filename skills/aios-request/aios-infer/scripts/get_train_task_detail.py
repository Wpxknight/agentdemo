"""
查询训练任务详情（获取输出路径等信息）。

用法：
  python scripts/get_train_task_detail.py --task-id <任务ID>

示例：
  python scripts/get_train_task_detail.py --task-id resnet50-20260430-7293-1777514012
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, make_current_project_headers
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="查询训练任务详情")
    parser.add_argument("--task-id", required=True, help="训练任务 ID")
    args = parser.parse_args()

    headers = make_current_project_headers()
    data = api_get(f"{BASE_URL}/trainapi/model/train/{args.task_id}", headers)

    task_data = data.get("data", {})

    result = {
        "id": task_data.get("id"),
        "name": task_data.get("name"),
        "framework": task_data.get("frameworkOptions", {}).get("name", ""),
        "outputMount": task_data.get("outputMount", []),
        "datasetMount": task_data.get("datasetMount", []),
        "command": task_data.get("command", ""),
        "resourceGroupId": task_data.get("resourceGroupId"),
        "resourceSpecId": task_data.get("resourceSpecId"),
        "rdma": task_data.get("rdma", False),
    }

    print(json.dumps({
        "next_step": "run_business_script",
        "data": result,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
