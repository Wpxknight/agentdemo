"""
终止推理任务

用法：
  python scripts/terminate_infer_task.py --task-id TASK_ID

示例：
  python scripts/terminate_infer_task.py --task-id abc123
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_post, make_current_project_headers
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="终止推理任务")
    parser.add_argument("--task-id", required=True, help="推理任务ID")
    args = parser.parse_args()

    headers = make_current_project_headers({"Content-Type": "application/json"})
    data = api_post(
        f"{BASE_URL}/inferapi/model/infer/terminate",
        headers, json={"id": args.task_id},
    )
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
