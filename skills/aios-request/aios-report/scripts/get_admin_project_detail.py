"""
查询项目详情（成员 + 配额）。

用法：
  python scripts/get_project_detail.py --project-id <项目ID>

接口：GET /paas-web/upmstreeapi/projects/{id}
"""

import argparse
import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="查询项目详情（成员 + 配额）")
    parser.add_argument("--project-id", required=True, help="项目 ID")
    args = parser.parse_args()

    headers = make_admin_headers()

    resp = requests.get(
        f"{BASE_URL}/upmstreeapi/projects/{args.project_id}",
        headers=headers,
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()

    data = body.get("data") or {}

    # 资源组
    resource_groups = []
    for rg in data.get("resourceGroup", []):
        resource_groups.append({
            "id": rg.get("id"),
            "name": rg.get("name"),
            "clusterId": rg.get("clusterId"),
            "clusterName": rg.get("clusterName"),
            "nodeIpList": rg.get("nodeIpList"),
        })

    # 资源规格配额
    resource_specs = []
    for rs in data.get("resourceSpec", []):
        resource_specs.append({
            "quotaId": rs.get("quotaId"),
            "name": rs.get("name"),
            "useNum": rs.get("useNum"),
            "totalNum": rs.get("totalNum"),
            "specType": rs.get("specType"),
            "gpuType": rs.get("gpuType"),
            "cpu": rs.get("cpu"),
            "memory": rs.get("memory"),
            "vgpuCore": rs.get("vgpuCore"),
            "vgpuMemory": rs.get("vgpuMemory"),
            "vgpuDevice": rs.get("vgpuDevice"),
        })

    # 成员
    member_data = data.get("member", {})
    members = []
    for m in member_data.get("list") or []:
        members.append({
            "id": m.get("id"),
            "name": m.get("name"),
            "joinTime": m.get("joinTime"),
            "datasetLimitNum": m.get("datasetLimitNum"),
        })

    result = {
        "projectId": data.get("projectId"),
        "projectName": data.get("projectName"),
        "describes": data.get("describes"),
        "creator": data.get("creator"),
        "createTime": data.get("createTime"),
        "resourceGroup": resource_groups,
        "resourceSpec": resource_specs,
        "member": {
            "total": member_data.get("total") or 0,
            "list": members,
        },
    }

    output_result(
        success=True,
        message=f"项目 {data.get('projectName', '')} 详情",
        data=result,
    )


if __name__ == "__main__":
    main()
