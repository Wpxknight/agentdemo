"""
查询项目列表（管理员端）。

用法：
  python scripts/get_project_list.py [--page <页码>] [--page-size <条数>]

接口：GET /paas-web/upmstreeapi/projects
参数：projectName=&pageNum=1&pageSize=10&creator=&startTime=&endTime=
"""

import argparse
import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="查询项目列表（管理员端）")
    parser.add_argument("--page", type=int, default=1, help="页码（默认 1）")
    parser.add_argument("--page-size", type=int, default=20, help="每页条数（默认 20）")
    parser.add_argument("--project-name", default="", help="项目名称筛选")
    parser.add_argument("--creator", default="", help="创建者筛选")
    args = parser.parse_args()

    headers = make_admin_headers()
    params = {
        "projectName": args.project_name,
        "pageNum": args.page,
        "pageSize": args.page_size,
        "creator": args.creator,
        "startTime": "",
        "endTime": "",
    }

    resp = requests.get(
        f"{BASE_URL}/upmstreeapi/projects",
        headers=headers,
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()

    resp_data = body.get("data") or {}
    total = resp_data.get("total") or 0
    projects = []
    for p in resp_data.get("data") or []:
        projects.append({
            "projectId": p.get("projectId"),
            "projectName": p.get("projectName"),
            "projectNamespace": p.get("projectNamespace"),
            "memberNum": p.get("memberNum"),
            "describes": p.get("describes"),
            "creatorId": p.get("creatorId"),
            "creator": p.get("creator"),
            "createTime": p.get("createTime"),
        })

    output_result(
        success=True,
        message=f"共 {total} 个项目（第 {args.page} 页）",
        total=total,
        page=args.page,
        pageSize=args.page_size,
        data=projects,
    )


if __name__ == "__main__":
    main()
