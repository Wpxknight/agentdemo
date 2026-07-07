"""
获取模型列表（支持自动翻页获取全量数据，支持按模型名称筛选）。

用法：
  python scripts/get_model_list.py [--page PAGE] [--page-size SIZE] [--all]
  python scripts/get_model_list.py --model-name <模型名称>

示例：
  python scripts/get_model_list.py
  python scripts/get_model_list.py --all
  python scripts/get_model_list.py --model-name Qwen3.5-0.8B
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, paginate_get
from auth import get_auth_headers
from config import BASE_URL


def query_by_name(model_name: str):
    """按模型名称查询，使用 listPage 接口（返回更丰富的模型数据）。"""
    headers = get_auth_headers()
    data = api_get(f"{BASE_URL}/bccapi/modelNew/listPage", headers, params={
        "isShare": "true",
        "modelName": model_name,
        "pageNum": 1,
        "pageSize": 99999,
    })
    records = data.get("data", {}).get("list", [])
    print(json.dumps({"total": len(records), "records": records}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="获取模型列表")
    parser.add_argument("--page",      type=int, default=1,     help="页码（默认 1）")
    parser.add_argument("--page-size", type=int, default=10,    help="每页条数（默认 10）")
    parser.add_argument("--all",       action="store_true",     help="自动翻页获取全部数据")
    parser.add_argument("--model-name", default=None,           help="按模型名称筛选（使用 listPage 接口）")
    args = parser.parse_args()

    if args.model_name:
        query_by_name(args.model_name)
        return

    headers = get_auth_headers()

    if not args.all:
        result = api_get(f"{BASE_URL}/bccapi/modelNew/page", headers, params={
            "isShare": "true",
            "current": args.page, "size": args.page_size,
            "pageNum": args.page, "pageSize": args.page_size,
        })
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    all_records = paginate_get(
        f"{BASE_URL}/bccapi/modelNew/page", headers,
        params={"isShare": "true"},
        record_keys=("records", "list"),
        start_page=1, page_size=args.page_size,
    )
    print(json.dumps({"total": len(all_records), "records": all_records}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
