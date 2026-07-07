"""
获取指定租户下的项目列表。

用法：
  python .\scripts\get_project_list.py --tenant-id 2
  python .\scripts\get_project_list.py --tenant-id 2 --project-name poc
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import api_get
from auth import get_auth_headers
from config import BASE_URL


def main():
    t_start = time.time()

    parser = argparse.ArgumentParser(description="获取指定租户下的项目列表")
    parser.add_argument("--tenant-id", required=True, help="租户ID")
    parser.add_argument("--project-name", default="", help="项目名称过滤，默认不过滤")
    args = parser.parse_args()

    headers = get_auth_headers(
        {"Accept": "application/json, text/plain, */*"},
        tenant_id=args.tenant_id,
        require_tenant=False,
    )
    t_auth = time.time()
    print(f"[timing] 获取认证信息耗时: {t_auth - t_start:.3f}s", file=sys.stderr)

    payload = api_get(f"{BASE_URL}/upmstreeapi/projects/list", headers, params={
        "projectName": args.project_name,
    })
    raw_items = payload.get("data") or []
    items = [
        {
            "project_id": str(item.get("projectId")),
            "project_name": item.get("projectName") or "",
            "project_namespace": item.get("projectNamespace") or "",
            "member_num": item.get("memberNum"),
            "creator": item.get("creator") or "",
        }
        for item in raw_items
    ]
    result = {
        "success": True,
        "tenant_id": str(args.tenant_id),
        "count": len(items),
        "auto_select": len(items) == 1,
        "items": items,
    }
    if len(items) == 1:
        result["selected"] = items[0]

    t_end = time.time()
    print(f"[timing] 业务接口耗时: {t_end - t_auth:.3f}s", file=sys.stderr)
    print(f"[timing] 脚本总耗时:   {t_end - t_start:.3f}s", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
