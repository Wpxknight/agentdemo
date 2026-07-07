"""
查询平台总览数据（资源总览 + 训练统计 + 任务数量统计）。

用法：
  python scripts/get_platform_overview.py [--cluster-name <集群名>]

接口：
  POST /paas-web/aiosreportapi/report/overview/signage/taskResourceMetric
  POST /paas-web/aiosreportapi/report/overview/signage/trainTaskStatistics
  POST /paas-web/aiosreportapi/report/overview/signage/taskNumStatistics

请求体统一为：{"clusterName": "", "userId": "", "resourceGroupName": ""}
"""

import argparse

import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


OVERVIEW_APIS = [
    {
        "key": "resourceMetric",
        "path": "/aiosreportapi/report/overview/signage/taskResourceMetric",
        "label": "资源总览",
    },
    {
        "key": "trainStatistics",
        "path": "/aiosreportapi/report/overview/signage/trainTaskStatistics",
        "label": "训练任务统计",
    },
    {
        "key": "taskStatistics",
        "path": "/aiosreportapi/report/overview/signage/taskNumStatistics",
        "label": "任务数量统计",
    },
]


def fetch_overview(headers, path, cluster_name=""):
    """调用一个总览接口。"""
    payload = {
        "clusterName": cluster_name,
        "userId": "",
        "resourceGroupName": "",
    }
    resp = requests.post(
        f"{BASE_URL}{path}",
        headers=headers,
        json=payload,
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="查询平台总览数据")
    parser.add_argument("--cluster-name", default="", help="集群名称筛选（默认全部）")
    args = parser.parse_args()

    headers = make_admin_headers({"Content-Type": "application/json;charset=UTF-8"})

    result = {}
    for api in OVERVIEW_APIS:
        body = fetch_overview(headers, api["path"], args.cluster_name)
        result[api["key"]] = body.get("data") or {}

    output_result(
        success=True,
        message="平台总览数据",
        clusterName=args.cluster_name or "全部",
        data=result,
    )


if __name__ == "__main__":
    main()
