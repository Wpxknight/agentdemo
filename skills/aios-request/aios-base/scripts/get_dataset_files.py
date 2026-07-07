"""
查询指定数据集内的文件/目录列表。
如果根目录只有目录没有文件，自动往下钻一层展示。

用法：python scripts/get_dataset_files.py --dataset-id <数据集ID>
     python scripts/get_dataset_files.py --dataset-id <数据集ID> --file-path <子目录>
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import api_get, fix_stdout_encoding, make_project_headers
from config import BASE_URL

fix_stdout_encoding()


def list_files(headers: dict, dataset_id: str, file_path: str = "") -> list:
    """查询数据集指定路径下的文件/目录列表。"""
    data = api_get(f"{BASE_URL}/bccapi/dataNew/files", headers, params={
        "isLikeQuery": "true",
        "fileName": "",
        "pageNum": 1,
        "pageSize": 200,
        "datasetId": dataset_id,
        "filePath": file_path,
    })
    items = data.get("data", {}).get("list", [])
    return [
        {"name": item["fileName"], "type": "file" if item.get("fileType") == 1 else "dir"}
        for item in items
        if not item["fileName"].startswith(".")  # 过滤隐藏文件
    ]


def main():
    parser = argparse.ArgumentParser(description="查询数据集内的训练数据文件列表")
    parser.add_argument("--dataset-id", required=True, help="数据集 ID")
    parser.add_argument("--file-path", default="", help="指定子目录路径（默认自动探测）")
    args = parser.parse_args()

    headers = make_project_headers()

    # 如果用户指定了路径，直接查询
    if args.file_path:
        files = list_files(headers, args.dataset_id, file_path=args.file_path)
    else:
        # 查询根目录
        root_files = list_files(headers, args.dataset_id)

        # 如果根目录只有目录没有文件，自动钻入每个目录展示内容
        has_regular_file = any(f["type"] == "file" for f in root_files)
        if not has_regular_file and root_files:
            files = []
            for d in root_files:
                sub_path = f"/{d['name']}"
                children = list_files(headers, args.dataset_id, file_path=sub_path)
                for child in children:
                    files.append({"name": f"{d['name']}/{child['name']}", "type": child["type"]})
        else:
            files = root_files

    print(json.dumps({
        "next_step": "run_business_script",
        "data": files,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
