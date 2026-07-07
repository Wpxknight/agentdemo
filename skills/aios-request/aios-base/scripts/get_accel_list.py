"""
获取加速卡列表

用法：
  python scripts/get_accel_list.py [--page PAGE] [--page-size SIZE]

示例：
  python scripts/get_accel_list.py
  python scripts/get_accel_list.py --page 1 --page-size 20
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import api_post
from auth import get_auth_headers
from config import BASE_URL, CLUSTER_NAME


def main():
    t_start = time.time()

    parser = argparse.ArgumentParser(description="获取加速卡列表")
    parser.add_argument("--page",      type=int, default=1,  help="页码（默认 1）")
    parser.add_argument("--page-size", type=int, default=10, help="每页条数（默认 10）")
    args = parser.parse_args()

    headers = get_auth_headers({"Content-Type": "application/json"})
    t_auth = time.time()
    print(f"[timing] 获取token耗时: {t_auth - t_start:.3f}s", file=sys.stderr)

    data = api_post(
        f"{BASE_URL}/commonserverapi/common/cluster/accecard/manage/list",
        headers,
        json={
            "page":         args.page,
            "pageSize":     args.page_size,
            "clusterNames": [CLUSTER_NAME],
            "hostName":     None,
            "cardVendor":   None,
            "cardType":     None,
            "cardStatus":   None,
            "virtualized":  None,
        },
    )
    t_end = time.time()
    print(f"[timing] 业务接口耗时: {t_end - t_auth:.3f}s", file=sys.stderr)
    print(f"[timing] 脚本总耗时:   {t_end - t_start:.3f}s", file=sys.stderr)
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
