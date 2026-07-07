"""
查询平台镜像仓库列表。
用法：python scripts/get_image_registries.py
"""

import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import fix_stdout_encoding, make_current_project_headers
from config import BASE_URL

fix_stdout_encoding()


def main():
    headers = make_current_project_headers()
    params = {"pageNum": 1, "pageSize": 9999}

    resp = requests.get(
        f"{BASE_URL}/imagemanagerapi/common/cluster/repo/registries",
        headers=headers,
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json().get("data", {})
    items = data.get("items", [])

    registries = [
        {
            "id": r["id"],
            "name": r["name"],
            "host": r["host"],
            "port": r["port"],
        }
        for r in items
    ]

    print(json.dumps({
        "next_step": "run_business_script",
        "count": len(registries),
        "data": registries,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
