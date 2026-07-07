"""
查询已完成的训练任务列表（用于推理任务的模型来源选择）。

用法：
  python scripts/get_train_task_list.py

示例：
  python scripts/get_train_task_list.py
"""

import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, make_current_project_headers
from config import BASE_URL


def main():
    headers = make_current_project_headers()
    data = api_get(f"{BASE_URL}/trainapi/model/train", headers, params={
        "pageNum": 0,
        "pageSize": 99999,
        "states[]": "Completed",
    })

    items = data.get("data", {}).get("items", [])

    tasks = [
        {
            "id": t["id"],
            "name": t["name"],
            "framework": t.get("framework", ""),
            "images": t.get("images", []),
            "resourceSpecInfo": t.get("resourceSpecInfo", ""),
            "createdTime": t.get("createdTime", ""),
        }
        for t in items
    ]

    print(json.dumps({
        "next_step": "run_business_script",
        "count": len(tasks),
        "data": tasks,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
