"""
列出所有已注册的算法。

读取 algorithm_registry.yaml，输出算法列表及其支持的版本。

用法：python scripts/list_algorithms.py
"""

import json
import os
import sys
from pathlib import Path

import yaml

from _import_base import *  # noqa: F401,F403
from api_utils import fix_stdout_encoding

fix_stdout_encoding()

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REGISTRY_PATH = Path(_THIS_DIR) / ".." / "references" / "algorithm_registry.yaml"


def main():
    if not _REGISTRY_PATH.exists():
        print(json.dumps({"success": False, "error": "算法注册表不存在"}, ensure_ascii=False))
        sys.exit(1)

    with open(_REGISTRY_PATH, encoding="utf-8") as f:
        registry = yaml.safe_load(f)

    algorithms = []
    for algo_id, algo_meta in registry.get("algorithms", {}).items():
        config_file = algo_meta.get("config_file", "")
        config_path = Path(_THIS_DIR) / ".." / "references" / config_file

        # 读取算法配置获取版本列表
        versions = []
        if config_path.exists():
            with open(config_path, encoding="utf-8") as cf:
                algo_config = yaml.safe_load(cf)
            versions = list(algo_config.get("versions", {}).keys())

        algorithms.append({
            "id": algo_id,
            "name": algo_meta.get("name", algo_id),
            "description": algo_meta.get("description", ""),
            "keywords": algo_meta.get("keywords", []),
            "has_quick_mode": algo_meta.get("has_quick_mode", False),
            "supported_versions": versions,
        })

    fallback = registry.get("fallback", {})

    print(json.dumps({
        "success": True,
        "algorithms": algorithms,
        "fallback": fallback,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
