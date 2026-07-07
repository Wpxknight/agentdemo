"""
查询资源组详情（含虚拟卡可用信息）
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import api_get, get_project_resource_groups
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id, get_default_project_id


def get_resource_group_from_project(project_id: str) -> tuple:
    """从项目详情自动获取第一个资源组的 id 和 name。"""
    project_data = get_project_resource_groups(project_id)

    resource_groups = project_data.get("resourceGroup", [])
    if not resource_groups:
        raise RuntimeError(
            f"项目 {project_id} 没有可用的资源组，请先在平台上配置。\n"
            f"项目详情：{json.dumps(project_data, ensure_ascii=False)}"
        )

    group = resource_groups[0]
    resource_id = str(group.get("id", ""))
    resource_key = str(group.get("name", ""))

    if not resource_id:
        raise RuntimeError(f"无法从资源组数据中提取 id：{group}")
    if not resource_key:
        raise RuntimeError(f"无法从资源组数据中提取 name：{group}")

    print(f"[info] 自动获取资源组: {resource_key} (id={resource_id})", file=sys.stderr)
    return resource_id, resource_key


def main():
    default_project_id = get_default_project_id()
    parser = argparse.ArgumentParser(
        description="查询资源组详情（虚拟卡可用性），不传参数时自动从项目详情获取",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例（推荐，自动获取）：
  python scripts/get_resource_group_detail.py

兼容旧用法：
  python scripts/get_resource_group_detail.py --resource-id 3 --resource-key my-group
        """,
    )
    parser.add_argument("--resource-id", default=None, help="资源组ID（可选，不提供则自动从项目详情获取）")
    parser.add_argument("--resource-key", default=None, help="资源组名称（可选，不提供则自动从项目详情获取）")
    parser.add_argument("--project-id", default=default_project_id, help="项目ID（默认使用当前上下文）")
    args = parser.parse_args()
    project_id = str(args.project_id or get_current_project_id())

    if args.resource_id is None or args.resource_key is None:
        args.resource_id, args.resource_key = get_resource_group_from_project(project_id)

    headers = get_auth_headers({
        "Accept": "application/json, text/plain, */*",
        "projectId": project_id,
    })
    data = api_get(f"{BASE_URL}/bccapi/resource/groups/cards", headers, params={
        "resourceId": args.resource_id,
        "resourceKey": args.resource_key,
    })
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
