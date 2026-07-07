"""
查询平台已上传数据集列表（全量翻页，过滤无关字段）。
用法：python scripts/get_dataset_list.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
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

    datasets = [
        {"id": r["id"], "name": r["dataName"], "path": r["dataPath"], "version": r.get("version", "")}
        for r in all_records
    ]

    print(json.dumps({"next_step": "run_business_script", "data": datasets}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
