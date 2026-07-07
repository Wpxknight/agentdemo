"""
查询指定镜像仓库中的镜像列表。
用法：python scripts/get_images.py --registry-id <仓库ID> [--name <名称过滤>]
"""

import argparse
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import fix_stdout_encoding, make_current_project_headers
from config import BASE_URL

fix_stdout_encoding()


def main():
    parser = argparse.ArgumentParser(description="查询镜像仓库中的镜像列表")
    parser.add_argument("--registry-id", required=True, type=int, help="镜像仓库 ID")
    parser.add_argument("--name", default="", help="按名称过滤")
    args = parser.parse_args()

    headers = make_current_project_headers()
    params = {
        "name": args.name,
        "pageNum": 1,
        "pageSize": 99999,
        "pid": -1,
        "rid": args.registry_id,
    }

    resp = requests.get(
        f"{BASE_URL}/imagemanagerapi/common/cluster/repo/images",
        headers=headers,
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json().get("data", {})
    items = data.get("items", [])

    images = [
        {
            "id": r["id"],
            "name": r["name"],
            "tag": r.get("tag", "latest"),
            "image_path": r["image_path"],
            "framework": r.get("framework", 0),
            "type": r.get("type", 0),
            "arch": r.get("arch", ""),
        }
        for r in items
    ]

    print(json.dumps({
        "next_step": "run_business_script",
        "registry_id": args.registry_id,
        "count": len(images),
        "data": images,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
