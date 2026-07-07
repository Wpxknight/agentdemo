"""
通用模型训练任务创建脚本。

用于无匹配算法模板时的通用训练场景，用户自选框架、镜像、命令等。

用法：
  python scripts/create_generic_train_task.py \
    --task-name <任务名> \
    --resource-group-id <资源组ID> \
    --resource-spec-id <规格ID> \
    --image <镜像地址> \
    --command <启动命令> \
    [--dataset-mounts '<JSON>'] \
    [--file-mounts '<JSON>'] \
    [--output-container-path <容器路径>] \
    [--output-host-path <平台路径>] \
    [--auto-stop-hours N] \
    [--project-id <项目ID>]

示例：
  python scripts/create_generic_train_task.py \
    --task-name train-20260420-3718 \
    --resource-group-id 3 \
    --resource-spec-id 123 \
    --image "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel" \
    --command "python train.py --epochs 50" \
    --dataset-mounts '[{"containerPath":"/home/user/dataset","hostPath":"/opt/bcc/storage2/users/poc/dataset"}]' \
    --output-container-path /home/user/output \
    --output-host-path /opt/bcc/storage2/users/poc/output
"""

import argparse
import json
import os
import re
import sys

import requests

from _import_base import *  # noqa: F401,F403
from api_utils import fix_stdout_encoding
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id, get_default_project_id

fix_stdout_encoding()


def _fix_path(path: str) -> str:
    """还原被 Git Bash 转义的 Linux 绝对路径。"""
    m = re.match(r"^[A-Za-z]:[/\\](?:Program Files[/\\]Git|Git)[/\\](.*)", path)
    if m:
        return "/" + m.group(1).replace("\\", "/")
    return path


def create_task(args) -> dict:
    """创建通用训练任务。"""
    dataset_mounts = json.loads(args.dataset_mounts) if args.dataset_mounts else []
    file_mounts = json.loads(args.file_mounts) if args.file_mounts else []

    output_mount = []
    if args.output_host_path:
        output_mount.append({
            "containerPath": args.output_container_path or "/home/user/output",
            "hostPath": _fix_path(args.output_host_path),
        })

    for mount in dataset_mounts:
        if "hostPath" in mount:
            mount["hostPath"] = _fix_path(mount["hostPath"])
    for mount in file_mounts:
        if "hostPath" in mount:
            mount["hostPath"] = _fix_path(mount["hostPath"])

    body = {
        "name": args.task_name,
        "type": "standalone",
        "frameworkOptions": {
            "name": "Stardard",
            "strategy": None,
            "ps": {"master": "master", "worker": "worker", "port": 2222},
        },
        "resourceGroupId": args.resource_group_id,
        "resourceSpecId": int(args.resource_spec_id),
        "projectId": int(args.project_id),
        "rdma": False,
        "tasks": [
            {
                "name": "worker",
                "replicas": 1,
                "minAvailable": 1,
                "imageType": "3",
                "image": args.image,
                "rid": None,
            }
        ],
        "shmSize": 0,
        "envs": [],
        "command": f"/bin/bash\n-c\n{args.command}",
        "porst": [],
        "fileManagerMount": file_mounts,
        "datasetMount": dataset_mounts,
        "nasMount": [],
        "outputMount": output_mount,
        "suspend": False,
        "terminate": False,
        "schedulerOptions": {
            "priorityClassName": "infer-med",
            "schedulerName": "volcano",
            "queue": "default",
            "podGroup": "default",
            "strategy": "spreadout",
            "minAvailable": 1,
        },
        "tensorboardOptions": {
            "containerPath": None,
            "hostPath": None,
            "autoStopTime": 1,
        },
        "autoStop": args.auto_stop_hours is not None,
        "autoStopTime": args.auto_stop_hours,
    }

    headers = get_auth_headers({
        "Content-Type": "application/json;charset=UTF-8",
        "projectId": str(args.project_id),
    })

    resp = requests.post(
        f"{BASE_URL}/trainapi/model/train",
        headers=headers,
        json=body,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    default_project_id = get_default_project_id()

    parser = argparse.ArgumentParser(
        description="创建通用模型训练任务",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--task-name", required=True, help="训练任务名称")
    parser.add_argument("--resource-group-id", required=True, help="资源组 ID")
    parser.add_argument("--resource-spec-id", required=True, help="资源规格 ID（quotaId）")
    parser.add_argument("--image", required=True, help="训练镜像完整地址")
    parser.add_argument("--command", required=True, help="启动命令（无需包含 /bin/bash -c 前缀）")
    parser.add_argument("--dataset-mounts", default="[]", help="数据集挂载 JSON，格式：[{\"containerPath\":\"...\",\"hostPath\":\"...\"}]")
    parser.add_argument("--file-mounts", default="[]", help="文件挂载 JSON，格式：[{\"containerPath\":\"...\",\"hostPath\":\"...\"}]")
    parser.add_argument("--output-container-path", default=None, help="训练输出容器内路径（默认 /home/user/output）")
    parser.add_argument("--output-host-path", default=None, help="训练输出平台路径")
    parser.add_argument("--auto-stop-hours", type=int, default=None, help="自动停止小时数")
    parser.add_argument("--project-id", default=default_project_id, help="项目 ID")
    args = parser.parse_args()
    args.project_id = str(args.project_id or get_current_project_id())

    try:
        result = create_task(args)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))

    task_id = None
    if isinstance(result.get("data"), dict):
        task_id = result["data"].get("id") or result["data"].get("taskId")
    elif result.get("data"):
        task_id = result["data"]

    if task_id:
        print(f"\n[成功] 训练任务已创建，任务ID: {task_id}", file=sys.stderr)
    elif result.get("code") != 200:
        print(f"\n[失败] {result.get('message') or result.get('error')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
