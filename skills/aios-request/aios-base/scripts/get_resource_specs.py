"""
获取资源规格列表

用法：
  python scripts/get_resource_specs.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import api_get, make_current_project_headers
from config import BASE_URL


def main():
    headers = make_current_project_headers()
    data = api_get(f"{BASE_URL}/bccapi/resource/specs/all", headers)
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
