"""
查询推理任务实例列表
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, make_current_project_headers
from config import BASE_URL, CLUSTER_NAME


def main():
    parser = argparse.ArgumentParser(description="查询推理任务实例列表")
    parser.add_argument("--task-id", required=True, help="推理任务ID")
    parser.add_argument("--namespace", required=True, help="项目命名空间")
    args = parser.parse_args()

    headers = make_current_project_headers({"Accept": "application/json, text/plain, */*"})
    data = api_get(f"{BASE_URL}/commonserverapi/common/tasks/instances", headers, params={
        "clusterName": CLUSTER_NAME,
        "taskType": "infer",
        "taskId": args.task_id,
        "namespace": args.namespace,
    })
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
