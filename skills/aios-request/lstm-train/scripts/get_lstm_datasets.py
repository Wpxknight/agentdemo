"""
获取平台上的所有可用数据集列表（不做格式校验）。

用法：python scripts/get_lstm_datasets.py
"""

import json
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import fix_stdout_encoding, make_project_headers, paginate_get
from config import BASE_URL

fix_stdout_encoding()


def main():
    headers = make_project_headers()
    all_records = paginate_get(
        f"{BASE_URL}/bccapi/dataNew/pageNew", headers,
        params={"isShare": "0"},
        record_keys=("list",),
        start_page=1, page_size=50,
    )

    datasets = []
    for r in all_records:
        datasets.append({
            "id": r.get("id"),
            "name": r.get("dataName", ""),
            "path": r.get("dataPath", ""),
            "version": r.get("version", ""),
        })

    print(json.dumps({
        "next_step": "run_business_script",
        "no_dataset_found": len(datasets) == 0,
        "data": datasets,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
