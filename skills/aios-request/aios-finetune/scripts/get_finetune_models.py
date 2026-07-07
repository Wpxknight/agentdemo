"""
获取可用于微调的大模型列表

用法：
  python scripts/get_finetune_models.py
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, paginate_get
from auth import get_auth_headers
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="获取可用于微调的大模型列表")
    args = parser.parse_args()

    headers = get_auth_headers()

    all_records = paginate_get(
        f"{BASE_URL}/bccapi/modelNew/page", headers,
        params={"isShare": "true", "modelFlag": "1"},
        record_keys=("records", "list"),
        start_page=1, page_size=99999,
    )

    # 提取微调所需的关键字段
    models = []
    for r in all_records:
        models.append({
            "id": r.get("id"),
            "modelName": r.get("modelName"),
            "version": r.get("version"),
            "modelPath": r.get("modelPath"),
            "savePath": r.get("savePath"),
            "modelTypeParentName": r.get("modelTypeParentName"),
            "modelTypeName": r.get("modelTypeName"),
            "framework": r.get("framework"),
            "cardVendor": r.get("cardVendor"),
        })

    print(json.dumps({"total": len(models), "records": models}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
