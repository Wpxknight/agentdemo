"""
查询推理框架及默认配置。

用法：
  python scripts/get_infer_frameworks.py

示例：
  python scripts/get_infer_frameworks.py
"""

import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, make_current_project_headers
from config import BASE_URL


def main():
    headers = make_current_project_headers()
    data = api_get(f"{BASE_URL}/inferapi/model/infer/framework/llm-deploy", headers)

    frameworks = data.get("data", {})

    result = []
    for key, fw in frameworks.items():
        result.append({
            "key": key,
            "modelName": fw.get("modelName", key),
            "image": fw.get("image", ""),
            "command": fw.get("command"),
            "args": fw.get("args"),
            "requiredArgs": fw.get("requiredArgs", {}),
            "ports": fw.get("ports", []),
            "envs": fw.get("envs"),
        })

    print(json.dumps({
        "next_step": "run_business_script",
        "count": len(result),
        "data": result,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
