"""
查询微调任务详情

用法：
  python scripts/get_finetune_task_detail.py --task-id <任务ID>
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get
from auth import get_auth_headers
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="查询微调任务详情")
    parser.add_argument("--task-id", required=True, help="微调任务 ID")
    args = parser.parse_args()

    headers = get_auth_headers()

    result = api_get(f"{BASE_URL}/finetuneapi/model/finetune/{args.task_id}", headers)

    if result.get("code") == 200 and isinstance(result.get("data"), dict):
        data = result["data"]
        detail = {
            "id": data.get("id"),
            "name": data.get("name"),
            "modelType": data.get("modelType"),
            "modelVersion": data.get("modelVersion"),
            "trainState": data.get("status", {}).get("trainState"),
            "exportState": data.get("status", {}).get("exportState"),
            "createdTime": data.get("status", {}).get("createdTime"),
            "resourceGroupId": data.get("resourceGroupId"),
            "resourceSpecId": data.get("resourceSpecId"),
            "instanceCount": data.get("instanceCount"),
            "shmSize": data.get("shmSize"),
            "namespace": data.get("namespace"),
            "clusterName": data.get("clusterName"),
            "resourceGroupName": data.get("resourceGroupName"),
            "resourceSpec": data.get("resourceSpec"),
            "modelMount": data.get("modelMount"),
            "datasetMount": data.get("datasetMount"),
            "deepSpeedMount": data.get("deepSpeedMount"),
            "fileManagerMount": data.get("fileManagerMount"),
            "exportConfig": data.get("exportConfig"),
            "parameterConfiguration": data.get("parameterConfiguration"),
            "parameterInfo": data.get("parameterInfo"),
        }
        print(json.dumps(detail, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
