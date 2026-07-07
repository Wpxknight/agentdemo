"""
查询资源规格列表（整卡/切分判断）。

用法：
  python scripts/get_resource_specs.py

接口：GET /paas-web/bccapi/resource/specs/all
"""

import sys
import os
from _import_base import *  # noqa: F401,F403

import requests

from report_utils import make_admin_headers, output_result
from config import BASE_URL


def main():
    headers = make_admin_headers()

    resp = requests.get(
        f"{BASE_URL}/bccapi/resource/specs/all",
        headers=headers,
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()

    raw_specs = body.get("data", [])

    specs = []
    for s in raw_specs:
        specs.append({
            "id": s.get("id"),
            "name": s.get("name"),
            "specType": s.get("specType"),
            "gpuType": s.get("gpuType"),
            "cardVendor": s.get("cardVendor"),
            "cpu": s.get("cpu"),
            "memory": s.get("memory"),
            "aiCore": s.get("aiCore"),
            "aiMemory": s.get("aiMemory"),
            "device": s.get("device"),
            "isFullCard": s.get("isFullCard"),
        })

    # 统计整卡 vs 切分
    gpu_specs = [s for s in specs if s["specType"] == "gpu"]
    full_card_count = sum(1 for s in gpu_specs if s["isFullCard"])
    split_card_count = len(gpu_specs) - full_card_count
    cpu_specs_count = len([s for s in specs if s["specType"] == "cpu"])

    output_result(
        success=True,
        message=f"共 {len(specs)} 个规格（GPU 整卡 {full_card_count}，切分 {split_card_count}，CPU {cpu_specs_count}）",
        total=len(specs),
        summary={
            "gpuFullCard": full_card_count,
            "gpuSplitCard": split_card_count,
            "cpuSpecs": cpu_specs_count,
        },
        data=specs,
    )


if __name__ == "__main__":
    main()
