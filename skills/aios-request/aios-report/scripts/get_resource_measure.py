"""
查询资源度量列表（时间范围筛选）。

用法：
  python scripts/get_resource_measure.py [--days <天数>] [--page <页码>] [--page-size <条数>] [--all]

接口：GET /paas-web/aiosreportapi/measure/resource/list
参数：page=1&size=10&start=<时间戳>&end=<时间戳>
"""

import argparse
import math
from datetime import datetime, timedelta

import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


def fetch_page(headers, page, size, start_ts, end_ts):
    """拉取一页资源度量数据。"""
    params = {
        "page": page,
        "size": size,
        "start": start_ts,
        "end": end_ts,
    }
    resp = requests.get(
        f"{BASE_URL}/aiosreportapi/measure/resource/list",
        headers=headers,
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="查询资源度量列表")
    parser.add_argument("--days", type=int, default=7, help="查询最近 N 天（默认 7）")
    parser.add_argument("--page", type=int, default=1, help="页码（默认 1）")
    parser.add_argument("--page-size", type=int, default=20, help="每页条数（默认 20）")
    parser.add_argument("--all", action="store_true", help="全量拉取（自动翻页）")
    args = parser.parse_args()

    headers = make_admin_headers()

    now = datetime.now()
    start_dt = now - timedelta(days=args.days)
    start_ts = int(start_dt.timestamp())
    end_ts = int(now.timestamp())

    body = fetch_page(headers, args.page, args.page_size, start_ts, end_ts)

    data = body.get("data") or {}
    items = data.get("task_info") or []
    total = data.get("total") or 0

    if args.all and len(items) < total:
        all_items = list(items)
        pages = math.ceil(total / args.page_size)
        for p in range(args.page + 1, pages + 1):
            page_body = fetch_page(headers, p, args.page_size, start_ts, end_ts)
            page_data = page_body.get("data") or {}
            page_items = page_data.get("task_info") or []
            all_items.extend(page_items)
            if not page_items:
                break
        items = all_items

    output_result(
        success=True,
        message=f"共 {total} 条记录" + ("（已全量拉取）" if args.all else f"（第 {args.page} 页）"),
        total=total,
        timeRange={
            "start": start_dt.strftime("%Y-%m-%d"),
            "end": now.strftime("%Y-%m-%d"),
        },
        data=items,
    )


if __name__ == "__main__":
    main()
