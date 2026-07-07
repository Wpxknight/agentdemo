"""
通用数据集检测脚本。

根据算法配置中的 dataset_detection.strategy 决定检测策略：
  - coco_json: 检查数据集 train/ 目录下是否存在指定的标注文件（如 _annotations.coco.json）
  - list_all:  列出所有数据集，不做格式校验

用法：
  python scripts/detect_datasets.py \
    --algo-config references/yolo.yaml \
    --algo-version yolov5
"""

import argparse
import json
import os
import sys
from pathlib import Path

import yaml

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, fix_stdout_encoding, make_project_headers, paginate_get
from config import BASE_URL

fix_stdout_encoding()

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))


def load_algo_config(config_path: str, version_id: str) -> dict:
    """从算法配置 YAML 加载指定版本的配置。"""
    abs_path = Path(_THIS_DIR) / ".." / config_path if not os.path.isabs(config_path) else Path(config_path)
    with open(abs_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    versions = data.get("versions", {})
    if version_id not in versions:
        available = ", ".join(versions.keys())
        raise ValueError(f"未知的版本: {version_id}。可用版本: {available}")

    return versions[version_id]


def _has_file_in_dataset(headers: dict, dataset_id: int, check_file: str, check_subdir: str) -> bool:
    """检查数据集的指定子目录下是否存在指定文件。"""
    try:
        data = api_get(f"{BASE_URL}/bccapi/dataNew/files", headers, params={
            "isLikeQuery": "true", "fileName": "",
            "pageNum": 1, "pageSize": 200,
            "datasetId": dataset_id, "filePath": f"/{check_subdir}",
        })
    except Exception:
        return False
    files = data.get("data", {}).get("list", [])
    return any(f.get("fileName") == check_file and f.get("fileType") == 1 for f in files)


def detect_coco_json(headers: dict, detection_config: dict) -> list:
    """coco_json 策略：只返回包含指定标注文件的数据集。"""
    check_file = detection_config.get("check_file", "_annotations.coco.json")
    check_subdir = detection_config.get("check_subdir", "train")

    all_records = _get_all_datasets(headers)
    valid_datasets = []

    for r in all_records:
        dataset_id = r.get("id")
        if not dataset_id:
            continue
        if _has_file_in_dataset(headers, dataset_id, check_file, check_subdir):
            valid_datasets.append({
                "id": dataset_id,
                "name": r.get("dataName", ""),
                "path": r.get("dataPath", ""),
                "version": r.get("version", ""),
            })

    return valid_datasets


def detect_list_all(headers: dict) -> list:
    """list_all 策略：返回所有数据集。"""
    all_records = _get_all_datasets(headers)
    datasets = []

    for r in all_records:
        datasets.append({
            "id": r.get("id"),
            "name": r.get("dataName", ""),
            "path": r.get("dataPath", ""),
            "version": r.get("version", ""),
        })

    return datasets


def _get_all_datasets(headers: dict) -> list:
    """获取所有数据集记录。"""
    return paginate_get(
        f"{BASE_URL}/bccapi/dataNew/pageNew", headers,
        params={"isShare": "0"},
        record_keys=("list",),
        start_page=1, page_size=50,
    )


def main():
    parser = argparse.ArgumentParser(
        description="通用数据集检测",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--algo-config", required=True, help="算法配置文件路径")
    parser.add_argument("--algo-version", required=True, help="算法版本 ID")
    args = parser.parse_args()

    try:
        version_config = load_algo_config(args.algo_config, args.algo_version)
    except ValueError as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    headers = make_project_headers()
    detection = version_config.get("dataset_detection", {})
    strategy = detection.get("strategy", "list_all")

    if strategy == "coco_json":
        datasets = detect_coco_json(headers, detection)
    elif strategy == "list_all":
        datasets = detect_list_all(headers)
    else:
        print(json.dumps({"success": False, "error": f"未知的数据集检测策略: {strategy}"}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps({
        "next_step": "run_business_script",
        "strategy": strategy,
        "no_dataset_found": len(datasets) == 0,
        "data": datasets,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
