"""
查询加速卡列表（卡片级详情）。

用法：
  python scripts/get_accel_card_list.py [--cluster-name <集群名>] [--all]

接口：POST /paas-web/commonserverapi/common/cluster/accecard/manage/list
请求体：{"page": 1, "pageSize": 10, "clusterNames": [...], "hostName": null, ...}
"""

import argparse
import math
import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


def fetch_page(headers, cluster_names, page, page_size):
    """拉取一页加速卡数据。"""
    payload = {
        "page": page,
        "pageSize": page_size,
        "clusterNames": cluster_names,
        "hostName": None,
        "cardVendor": None,
        "cardType": None,
        "cardStatus": None,
        "virtualized": None,
    }
    resp = requests.post(
        f"{BASE_URL}/commonserverapi/common/cluster/accecard/manage/list",
        headers=headers,
        json=payload,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def simplify_card(item):
    """精简卡片字段，只保留报表需要的。"""
    return {
        "clusterName": item.get("clusterName"),
        "uuid": item.get("uuid"),
        "cardName": item.get("cardName"),
        "hostName": item.get("hostName"),
        "cardVendor": item.get("cardVendor"),
        "cardType": item.get("cardType"),
        "utilization": item.get("utilization"),
        "memoryUtilization": item.get("memoryUtilization"),
        "cardStatus": item.get("cardStatus"),
        "cardMode": item.get("cardMode"),
        "hadVirtualization": item.get("hadVirtualization"),
        "virtualized": item.get("virtualized"),
        "temperature": item.get("temperature"),
        "power": item.get("power"),
        "taskNumber": item.get("taskNumber"),
        "cardMemTotal": item.get("cardMemTotal"),
    }


def main():
    parser = argparse.ArgumentParser(description="查询加速卡列表")
    parser.add_argument("--cluster-name", default=None, help="集群名称筛选")
    parser.add_argument("--all", action="store_true", help="拉取全部数据（自动翻页）")
    parser.add_argument("--page", type=int, default=1, help="页码（默认 1）")
    parser.add_argument("--page-size", type=int, default=20, help="每页条数（默认 20）")
    args = parser.parse_args()

    headers = make_admin_headers({"Content-Type": "application/json;charset=UTF-8"})

    cluster_names = [args.cluster_name] if args.cluster_name else []

    # 首次请求
    body = fetch_page(headers, cluster_names, args.page, args.page_size)
    data = body.get("data") or {}
    items = data.get("items") or []
    total = data.get("total") or 0
    info = data.get("info") or {}

    if args.all and len(items) < total:
        # 自动翻页拉取全部
        all_items = list(items)
        pages = math.ceil(total / args.page_size)
        for p in range(args.page + 1, pages + 1):
            page_body = fetch_page(headers, cluster_names, p, args.page_size)
            page_data = page_body.get("data") or {}
            page_items = page_data.get("items") or []
            all_items.extend(page_items)
            if not page_items:
                break
        items = all_items

    cards = [simplify_card(item) for item in items]

    output_result(
        success=True,
        message=f"共 {total} 张加速卡" + ("（已全量拉取）" if args.all else f"（第 {args.page} 页）"),
        total=total,
        info=info,
        data=cards,
    )


if __name__ == "__main__":
    main()
