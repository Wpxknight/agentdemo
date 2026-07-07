"""
查询集群列表。

用法：
  python scripts/get_cluster_list.py

接口：POST /paas-web/bocapi/cluster/v3.0/listBaseInfo
请求体：{"category": 2, "clusterName": "", "currPageNum": 1, "pageSize": 9999, "sourceType": "", "version": "", "envId": 0}
"""

import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


def main():
    headers = make_admin_headers({"Content-Type": "application/json;charset=UTF-8"})
    payload = {
        "category": 2,
        "clusterName": "",
        "currPageNum": 1,
        "pageSize": 9999,
        "sourceType": "",
        "version": "",
        "envId": 0,
    }

    resp = requests.post(
        f"{BASE_URL}/bocapi/cluster/v3.0/listBaseInfo",
        headers=headers,
        json=payload,
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()

    rows = body.get("rows", [])
    clusters = []
    for r in rows:
        clusters.append({
            "clusterId": r.get("clusterId"),
            "clusterName": r.get("clusterName"),
            "clusterStatus": r.get("clusterStatus"),
            "version": r.get("version"),
            "serviceIp": r.get("serviceIp"),
            "runtime": r.get("runtime"),
            "platformType": r.get("platformType"),
        })

    output_result(
        success=True,
        message=f"共 {len(clusters)} 个集群",
        total=len(clusters),
        data=clusters,
    )


if __name__ == "__main__":
    main()
