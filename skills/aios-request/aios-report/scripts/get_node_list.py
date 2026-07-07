"""
查询节点列表（健康状态）。

用法：
  python scripts/get_node_list.py

接口：GET /paas-web/bccapi/node/page/new
参数：current=1&size=999&pageNum=1&pageSize=999
"""

import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


def main():
    headers = make_admin_headers()
    params = {
        "current": 1,
        "size": 999,
        "pageNum": 1,
        "pageSize": 999,
    }

    resp = requests.get(
        f"{BASE_URL}/bccapi/node/page/new",
        headers=headers,
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()

    data = body.get("data") or {}
    summary = {
        "cpuTotal": data.get("cpuTotal"),
        "memoryTotal": data.get("memoryTotal"),
        "storageTotal": data.get("storageTotal"),
        "nodeNumTotal": data.get("nodeNumTotal"),
        "gpuNumTotal": data.get("gpuNumTotal"),
        "normalGpuNumTotal": data.get("normalGpuNumTotal"),
        "faultGpuNumTotal": data.get("faultGpuNumTotal"),
        "gpuModelNumTotal": data.get("gpuModelNumTotal"),
        "gpuMemoryTotal": data.get("gpuMemoryTotal"),
    }

    page = data.get("page") or {}
    nodes = []
    for n in page.get("list") or []:
        nodes.append({
            "hostId": n.get("hostId"),
            "clusterId": n.get("clusterId"),
            "clusterName": n.get("clusterName"),
            "nodeName": n.get("nodeName"),
            "nodeIp": n.get("nodeIp"),
            "nodeType": n.get("nodeType"),
            "status": n.get("status"),
            "schedulingAble": n.get("schedulingAble"),
            "cpuLimit": n.get("cpuLimit"),
            "cpuUnit": n.get("cpuUnit"),
            "memLimit": n.get("memLimit"),
            "memUnit": n.get("memUnit"),
            "gpuNum": n.get("gpuNum"),
            "gpuMemLimit": n.get("gpuMemLimit"),
            "gpuMemUnit": n.get("gpuMemUnit"),
            "storageLimit": n.get("storageLimit"),
            "storageUnit": n.get("storageUnit"),
        })

    output_result(
        success=True,
        message=f"共 {page.get('total') or 0} 个节点",
        summary=summary,
        total=page.get("total") or 0,
        data=nodes,
    )


if __name__ == "__main__":
    main()
