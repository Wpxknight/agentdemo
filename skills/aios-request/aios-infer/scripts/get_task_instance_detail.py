"""
查询推理任务实例详情（分析启动失败、排队原因）
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_get, paginate_find
from auth import get_auth_headers
from config import BASE_URL, CLUSTER_NAME
from context import get_current_project_id


def find_namespace_by_task_id(task_id: str, project_id: str) -> str:
    headers = get_auth_headers({"projectId": project_id})
    record = paginate_find(
        f"{BASE_URL}/inferapi/model/infer", headers,
        params={"serviceType": "mine"},
        match_fn=lambda r: str(r.get("id") or r.get("taskId") or "") == str(task_id),
        record_keys=("items", "records", "list"),
        start_page=0, page_size=20,
    )

    if not record:
        raise RuntimeError(f"找不到 task_id={task_id} 的推理任务，请确认 ID 是否正确。")

    namespace = (
        record.get("resourceNamespace")
        or record.get("namespace")
        or record.get("k8sNamespace")
        or ""
    )
    if not namespace:
        raise RuntimeError(
            f"任务 {task_id} 找到但 namespace 字段为空。\n"
            f"任务数据：{json.dumps(record, ensure_ascii=False)}"
        )
    print(f"[info] 找到任务 namespace: {namespace}", file=sys.stderr)
    return namespace


def find_first_pod(task_id: str, namespace: str, project_id: str) -> str:
    headers = get_auth_headers({
        "Accept": "application/json, text/plain, */*",
        "projectId": project_id,
    })
    result = api_get(f"{BASE_URL}/commonserverapi/common/tasks/instances", headers, params={
        "clusterName": CLUSTER_NAME,
        "taskType": "infer",
        "taskId": task_id,
        "namespace": namespace,
    })

    instances = result.get("data") or []
    if isinstance(instances, dict):
        instances = instances.get("items") or instances.get("records") or instances.get("list") or []

    if not instances:
        raise RuntimeError(
            f"任务 {task_id} 没有运行中的实例（namespace={namespace}）。\n"
            f"完整响应：{json.dumps(result, ensure_ascii=False)}"
        )

    first = instances[0]
    pod_name = first.get("name") or first.get("podName") or first.get("pod") or ""
    if not pod_name:
        raise RuntimeError(
            f"实例数据中找不到 pod 名称字段。\n"
            f"实例数据：{json.dumps(first, ensure_ascii=False)}"
        )

    print(f"[info] 使用第一个实例 pod: {pod_name}（共 {len(instances)} 个实例）", file=sys.stderr)
    return pod_name


def main():
    parser = argparse.ArgumentParser(
        description="查询推理任务实例详情，只需任务ID即可自动获取 namespace 和 pod",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例（推荐，只需 task-id）：
  python scripts/get_task_instance_detail.py --task-id abc123

兼容旧用法：
  python scripts/get_task_instance_detail.py --pod infer-abc123-0 --namespace proj-50
        """,
    )
    parser.add_argument("--task-id", default=None, help="推理任务ID（推荐，自动获取 namespace 和 pod）")
    parser.add_argument("--pod", default=None, help="Pod 名称（与 --namespace 配合使用）")
    parser.add_argument("--namespace", default=None, help="命名空间（与 --pod 配合使用）")
    args = parser.parse_args()
    project_id = get_current_project_id()

    if args.task_id:
        namespace = find_namespace_by_task_id(args.task_id, project_id)
        pod = find_first_pod(args.task_id, namespace, project_id)
    elif args.pod and args.namespace:
        pod = args.pod
        namespace = args.namespace
    else:
        parser.error("必须指定 --task-id，或同时指定 --pod 和 --namespace")

    headers = get_auth_headers({
        "Accept": "application/json, text/plain, */*",
        "projectId": project_id,
    })
    data = api_get(f"{BASE_URL}/commonserverapi/common/tasks/detail", headers, params={
        "pod": pod,
        "clusterName": CLUSTER_NAME,
        "namespace": namespace,
    })
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
