"""
检测平台数据集中符合 YOLOv5（PaddleDetection）训练格式的数据集。

判断规则：数据集 train/ 目录下存在 _annotations.coco.json 文件。

用法：python scripts/detect_yolo_datasets.py
"""

import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, fix_stdout_encoding, make_project_headers, paginate_get
from config import BASE_URL

fix_stdout_encoding()

ANNOTATION_FILE = "_annotations.coco.json"


def has_coco_annotation(headers: dict, dataset_id: int) -> bool:
    """检查数据集的 train/ 目录下是否存在 _annotations.coco.json。"""
    try:
        data = api_get(f"{BASE_URL}/bccapi/dataNew/files", headers, params={
            "isLikeQuery": "true", "fileName": "",
            "pageNum": 1, "pageSize": 200,
            "datasetId": dataset_id, "filePath": "/train",
        })
    except Exception:
        return False
    files = data.get("data", {}).get("list", [])
    return any(f.get("fileName") == ANNOTATION_FILE and f.get("fileType") == 1 for f in files)


def main():
    headers = make_project_headers()
    all_records = paginate_get(
        f"{BASE_URL}/bccapi/dataNew/pageNew", headers,
        params={"isShare": "0"},
        record_keys=("list",),
        start_page=1, page_size=50,
    )

    valid_datasets = []
    for r in all_records:
        dataset_id = r.get("id")
        if not dataset_id:
            continue
        if has_coco_annotation(headers, dataset_id):
            valid_datasets.append({
                "id": dataset_id,
                "name": r.get("dataName", ""),
                "path": r.get("dataPath", ""),
                "version": r.get("version", ""),
            })

    print(json.dumps({
        "next_step": "run_business_script",
        "no_dataset_found": len(valid_datasets) == 0,
        "data": valid_datasets,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
