"""
获取当前账号可访问的租户列表。

用法：
  python .\scripts\get_tenant_list.py
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

    argparse.ArgumentParser(description="获取当前账号可访问的租户列表").parse_args()

    headers = get_auth_headers(
        {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        },
        require_tenant=False,
    )
    t_auth = time.time()
    print(f"[timing] 获取认证信息耗时: {t_auth - t_start:.3f}s", file=sys.stderr)

    payload = api_get(f"{BASE_URL}/upmstreeapi/tenants/account", headers)
    raw_items = payload.get("data") or []
    items = [
        {
            "tenant_id": str(item.get("id")),
            "tenant_name": item.get("name") or "",
            "account_name": item.get("accountName") or "",
            "role_ids": item.get("roleIds") or [],
        }
        for item in raw_items
    ]
    result = {
        "success": True,
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
