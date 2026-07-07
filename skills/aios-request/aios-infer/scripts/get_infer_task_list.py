"""
查询推理任务列表

用法：
  python scripts/get_infer_task_list.py [--page PAGE] [--page-size SIZE]

示例：
  python scripts/get_infer_task_list.py
  python scripts/get_infer_task_list.py --page 0 --page-size 20
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, make_current_project_headers
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="查询推理任务列表")
    parser.add_argument("--page", type=int, default=0, help="页码，从0开始（默认 0）")
    parser.add_argument("--page-size", type=int, default=10, help="每页条数（默认 10）")
    args = parser.parse_args()

    headers = make_current_project_headers()
    data = api_get(f"{BASE_URL}/inferapi/model/infer", headers, params={
        "pageNum": args.page,
        "pageSize": args.page_size,
        "serviceType": "mine",
    })
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
