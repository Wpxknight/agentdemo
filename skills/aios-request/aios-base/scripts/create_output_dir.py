"""
在平台文件管理中创建训练输出目录。

用法：python scripts/create_output_dir.py --dir-name <目录名>
示例：python scripts/create_output_dir.py --dir-name yolov5-output-my-task

成功后输出目录的 absolutePath，供后续脚本使用。
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
    parser = argparse.ArgumentParser(description="在平台文件管理中创建训练输出目录")
    parser.add_argument("--dir-name", required=True, help="要创建的目录名称（不含斜杠）")
    parser.add_argument("--project-name", default="poc", help="项目名称（默认 poc）")
    args = parser.parse_args()

    dir_name = args.dir_name.strip("/")
    relative_path = f"/{dir_name}"
    headers = make_project_headers()

    # 创建目录
    result = api_get(f"{BASE_URL}/bccapi/fileNew/newPath", headers, params={
        "sourcePath": relative_path,
        "isShare": "0",
        "projectName": args.project_name,
    })

    if not result.get("data"):
        print(json.dumps({
            "next_step": "error",
            "message": f"创建目录失败：{result.get('message') or result}",
        }, ensure_ascii=False, indent=2))
        sys.exit(1)

    # 创建成功，查询 absolutePath
    info = api_get(f"{BASE_URL}/bccapi/fileNew/fileInfo", headers, params={
        "isShare": "0",
        "relativePath": relative_path,
        "projectName": args.project_name,
    })
    absolute_path = info.get("data", {}).get("absolutePath", "")

    print(json.dumps({
        "next_step": "run_business_script",
        "name": dir_name,
        "path": absolute_path,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
