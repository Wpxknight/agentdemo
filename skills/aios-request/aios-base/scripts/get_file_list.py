"""
查询文件管理目录列表（只返回目录，过滤文件）。
用法：python scripts/get_file_list.py [--path <相对路径>] [--project-name <项目名>]
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import api_get, fix_stdout_encoding, make_project_headers
from config import BASE_URL

fix_stdout_encoding()


def main():
    parser = argparse.ArgumentParser(description="查询文件管理目录列表")
    parser.add_argument("--path", default="/", help="查询的相对路径（默认根目录）")
    parser.add_argument("--project-name", default="poc", help="项目名称（默认 poc）")
    args = parser.parse_args()

    headers = make_project_headers()

    # 获取基础路径
    info = api_get(f"{BASE_URL}/bccapi/fileNew/fileInfo", headers, params={
        "isShare": "0", "relativePath": args.path, "projectName": args.project_name,
    })
    base_absolute = info.get("data", {}).get("absolutePath", "")

    # 查询目录列表
    data = api_get(f"{BASE_URL}/bccapi/fileNew/page", headers, params={
        "isLikeQuery": "true", "filename": "",
        "current": 1, "size": 200,
        "isShare": "0",
        "pageNum": 1, "pageSize": 200,
        "relativePath": args.path,
        "isFileShow": "1",
        "projectName": args.project_name,
    })
    items = data.get("data", {}).get("list", [])

    # 只保留目录（fileType=0），提取最小必要字段
    dirs = [
        {"name": item["fileName"], "path": item["absolutePath"]}
        for item in items
        if item.get("fileType") == 0
    ]

    print(json.dumps({
        "next_step": "run_business_script",
        "base_path": base_absolute,
        "data": dirs,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
