"""
查询平台支持的训练框架及预制镜像。
用法：python scripts/get_train_frameworks.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import fix_stdout_encoding, make_current_project_headers
from config import BASE_URL

fix_stdout_encoding()


def main():
    headers = make_current_project_headers()

    resp = __import__("requests").get(
        f"{BASE_URL}/trainapi/model/train/framework/images/default",
        headers=headers,
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json().get("data", {})

    frameworks = []
    for fw_name, images in data.items():
        fw_images = []
        for img in images:
            fw_images.append({
                "image": img.get("image", ""),
                "labels": img.get("labels", {}),
                "tags": img.get("tags", []),
            })
        frameworks.append({
            "name": fw_name,
            "images": fw_images,
        })

    print(json.dumps({
        "next_step": "run_business_script",
        "count": len(frameworks),
        "data": frameworks,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
