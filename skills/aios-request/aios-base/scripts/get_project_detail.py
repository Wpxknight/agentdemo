"""
查询项目详情（含可用资源组和资源规格）

用法：
  python scripts/get_project_detail.py [--project-id ID]

示例：
  python scripts/get_project_detail.py
  python scripts/get_project_detail.py --project-id 50
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import api_get
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id, get_default_project_id


def main():
    default_project_id = get_default_project_id()
    parser = argparse.ArgumentParser(description="查询项目详情")
    parser.add_argument("--project-id", default=default_project_id, help="项目ID（默认使用当前上下文）")
    args = parser.parse_args()
    project_id = str(args.project_id or get_current_project_id())

    headers = get_auth_headers({
        "Accept": "application/json, text/plain, */*",
        "projectId": project_id,
    })
    data = api_get(f"{BASE_URL}/upmstreeapi/projects/{project_id}", headers)
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
