"""
查询微调任务列表

用法：
  python scripts/get_finetune_task_list.py [--page PAGE] [--page-size SIZE] [--name NAME]
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id


def main():
    parser = argparse.ArgumentParser(description="查询微调任务列表")
    parser.add_argument("--page", type=int, default=0, help="页码（默认 0）")
    parser.add_argument("--page-size", type=int, default=50, help="每页条数（默认 50）")
    parser.add_argument("--name", default="", help="按任务名过滤")
    args = parser.parse_args()

    headers = get_auth_headers()
    project_id = get_current_project_id()

    result = api_get(f"{BASE_URL}/finetuneapi/model/finetune", headers, params={
        "pageNum": args.page,
        "pageSize": args.page_size,
        "name": args.name,
        "projectIds[]": project_id,
    })

    # 规范化输出
    if result.get("code") == 200 and isinstance(result.get("data"), dict):
        data = result["data"]
        items = []
        for item in data.get("items", []):
            items.append({
                "id": item.get("id"),
                "name": item.get("name"),
                "modelName": item.get("modelName"),
                "modelVersion": item.get("modelVersion"),
                "modelVersionName": item.get("modelVersionName"),
                "trainState": item.get("trainState"),
                "exportState": item.get("exportState"),
                "createdTime": item.get("createdTime"),
                "endTime": item.get("endTime"),
                "resourceSpecInfo": item.get("resourceSpecInfo"),
                "instanceCount": item.get("instanceCount"),
                "resourceGroup": item.get("resourceGroup"),
                "description": item.get("description"),
            })
        print(json.dumps({
            "total": data.get("total", 0),
            "items": items,
        }, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
