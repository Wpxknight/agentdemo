"""
启动微调任务

用法：
  python scripts/launch_finetune_task.py --task-id <任务ID>
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_post
from auth import get_auth_headers
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="启动微调任务")
    parser.add_argument("--task-id", required=True, help="微调任务 ID")
    args = parser.parse_args()

    headers = get_auth_headers()
    result = api_post(f"{BASE_URL}/finetuneapi/model/finetune/launch", headers, json={"id": args.task_id})
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result.get("code") == 200:
        print(f"\n[成功] 微调任务 {args.task_id} 已启动", file=sys.stderr)
    else:
        print(f"\n[失败] {result.get('message')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
