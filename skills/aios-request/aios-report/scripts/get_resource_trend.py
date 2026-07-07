"""
查询资源利用率趋势。

用法：
  python scripts/get_resource_trend.py [--days <天数>]

接口：GET /paas-web/aiosreportapi/measure/resource/charts
参数：start=<时间戳>&end=<时间戳>
"""

import argparse
from datetime import datetime, timedelta

import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


def main():
    parser = argparse.ArgumentParser(description="查询资源利用率趋势")
    parser.add_argument("--days", type=int, default=7, help="查询最近 N 天（默认 7）")
    args = parser.parse_args()

    headers = make_admin_headers()

    now = datetime.now()
    start_dt = now - timedelta(days=args.days)
    start_ts = int(start_dt.timestamp())
    end_ts = int(now.timestamp())

    params = {
        "start": start_ts,
        "end": end_ts,
    }

    resp = requests.get(
        f"{BASE_URL}/aiosreportapi/measure/resource/charts",
        headers=headers,
        params=params,
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()

    data = body.get("data") or {}

    output_result(
        success=True,
        message=f"最近 {args.days} 天资源利用率趋势",
        timeRange={
            "start": start_dt.strftime("%Y-%m-%d"),
            "end": now.strftime("%Y-%m-%d"),
        },
        data=data,
    )


if __name__ == "__main__":
    main()
