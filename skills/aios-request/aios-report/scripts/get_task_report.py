"""
查询任务报表（筛选 + 分页 + 全量）。

用法：
  python scripts/get_task_report.py [--task-type <类型>] [--task-status <状态>] [--cluster-name <集群名>]
                                    [--user-name <用户名>] [--start-time <开始时间>] [--end-time <结束时间>]
                                    [--project-id <项目ID>] [--page <页码>] [--page-size <条数>] [--all]

接口：POST /paas-web/aiosreportapi/report/management/tasks/list
请求体：{"page": 1, "limit": 10, "sort": {"key": "startTime", "type": "DESC"}, "filter": {...}}
"""

import argparse
import math
import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


VALID_TASK_TYPES = (
    "train", "infer", "evaluate", "model_convert", "algorithm_dev",
    "model_compress", "model_optimization", "automl", "annotation", "simulation",
)

VALID_TASK_STATUS = (
    "Suspend", "Pending", "Running", "Failed",
    "Terminated", "Completed", "Succeeded",
)


def fetch_page(headers, page, limit, task_type=None, task_status=None,
               cluster_name=None, user_name=None, start_time=None,
               end_time=None, project_id=None, task_name=None):
    """拉取一页任务报表。"""
    payload = {
        "page": page,
        "limit": limit,
        "sort": {"key": "startTime", "type": "DESC"},
        "filter": {
            "taskName": task_name,
            "taskType": task_type,
            "userName": user_name,
            "startTime": start_time,
            "endTime": end_time,
            "taskStatus": task_status,
            "clusterName": cluster_name,
            "projectId": project_id,
        },
    }
    resp = requests.post(
        f"{BASE_URL}/aiosreportapi/report/management/tasks/list",
        headers=headers,
        json=payload,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="查询任务报表")
    parser.add_argument("--task-type", default=None, choices=VALID_TASK_TYPES,
                        help="任务类型筛选")
    parser.add_argument("--task-status", default=None, choices=VALID_TASK_STATUS,
                        help="任务状态筛选")
    parser.add_argument("--cluster-name", default=None, help="集群名称筛选")
    parser.add_argument("--user-name", default=None, help="用户名筛选")
    parser.add_argument("--start-time", default=None,
                        help="开始时间，格式 YYYY-MM-DD HH:MM:SS")
    parser.add_argument("--end-time", default=None,
                        help="结束时间，格式 YYYY-MM-DD HH:MM:SS")
    parser.add_argument("--project-id", default=None, help="项目 ID 筛选")
    parser.add_argument("--task-name", default=None, help="任务名称筛选")
    parser.add_argument("--page", type=int, default=1, help="页码（默认 1）")
    parser.add_argument("--page-size", type=int, default=20, help="每页条数（默认 20）")
    parser.add_argument("--all", action="store_true", help="全量拉取（自动翻页）")
    args = parser.parse_args()

    headers = make_admin_headers({"Content-Type": "application/json;charset=UTF-8"})

    body = fetch_page(
        headers, args.page, args.page_size,
        task_type=args.task_type,
        task_status=args.task_status,
        cluster_name=args.cluster_name,
        user_name=args.user_name,
        start_time=args.start_time,
        end_time=args.end_time,
        project_id=args.project_id,
        task_name=args.task_name,
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
                task_type=args.task_type,
                task_status=args.task_status,
                cluster_name=args.cluster_name,
                user_name=args.user_name,
                start_time=args.start_time,
                end_time=args.end_time,
                project_id=args.project_id,
                task_name=args.task_name,
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
