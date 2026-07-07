"""
查询资源报表（筛选 + 分页 + 全量）。

用法：
  python scripts/get_resource_report.py [--resource-type <类型>] [--cluster-name <集群名>]
                                        [--user-name <用户名>] [--page <页码>] [--page-size <条数>] [--all]

接口：POST /paas-web/aiosreportapi/report/management/resource/list
请求体：{"page": 1, "limit": 10, "sort": {"key": "resourceUsage", "type": "DESC"}, "filter": {...}}
"""

import argparse
import math
import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


VALID_RESOURCE_TYPES = ("GPU", "CPU", "GPU_Memory", "Memory")


def fetch_page(headers, page, limit, resource_type=None, cluster_name=None, user_name=None):
    """拉取一页资源报表。"""
    payload = {
        "page": page,
        "limit": limit,
        "sort": {"key": "resourceUsage", "type": "DESC"},
        "filter": {
            "clusterName": cluster_name,
            "resourceType": resource_type,
            "userName": user_name,
        },
    }
    resp = requests.post(
        f"{BASE_URL}/aiosreportapi/report/management/resource/list",
        headers=headers,
        json=payload,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="查询资源报表")
    parser.add_argument("--resource-type", default=None, choices=VALID_RESOURCE_TYPES,
                        help="资源类型筛选：GPU / CPU / GPU_Memory / Memory")
    parser.add_argument("--cluster-name", default=None, help="集群名称筛选")
    parser.add_argument("--user-name", default=None, help="用户名筛选")
    parser.add_argument("--page", type=int, default=1, help="页码（默认 1）")
    parser.add_argument("--page-size", type=int, default=20, help="每页条数（默认 20）")
    parser.add_argument("--all", action="store_true", help="全量拉取（自动翻页）")
    args = parser.parse_args()

    headers = make_admin_headers({"Content-Type": "application/json;charset=UTF-8"})

    body = fetch_page(
        headers, args.page, args.page_size,
        resource_type=args.resource_type,
        cluster_name=args.cluster_name,
        user_name=args.user_name,
    )

    data = body.get("data") or {}
    items = data.get("items") or []
    total = data.get("total") or 0

    if args.all and len(items) < total:
        all_items = list(items)
        pages = math.ceil(total / args.page_size)
        for p in range(args.page + 1, pages + 1):
            page_body = fetch_page(
                headers, p, args.page_size,
                resource_type=args.resource_type,
                cluster_name=args.cluster_name,
                user_name=args.user_name,
            )
            page_data = page_body.get("data") or {}
            page_items = page_data.get("items") or []
            all_items.extend(page_items)
            if not page_items:
                break
        items = all_items

    output_result(
        success=True,
        message=f"共 {total} 条记录" + ("（已全量拉取）" if args.all else f"（第 {args.page} 页）"),
        total=total,
        page=args.page,
        pageSize=args.page_size,
        data=items,
    )


if __name__ == "__main__":
    main()
