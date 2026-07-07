"""
创建 YOLO 训练任务（支持多版本）。

用法：
  python scripts/create_train_task.py \
    --yolo-version <版本ID> \
    --task-name <任务名> \
    --resource-group-id <资源组ID> \
    --resource-spec-id <规格ID> \
    --dataset-host-path <数据集平台路径> \
    --output-host-path <输出目录平台路径> \
    --num-classes <类别数> \
    [--epoch N] [--batch-size N] [--base-lr F] \
    [--auto-stop-hours N]

示例：
  python scripts/create_train_task.py \
    --yolo-version yolov5 \
    --task-name yolov5-20260408-test \
    --resource-group-id 3 \
    --resource-spec-id 123 \
    --dataset-host-path /opt/bcc/storage2/users/poc02-8/dataset \
    --output-host-path /opt/bcc/storage2/users/poc02-8/yolov5-output-test \
    --num-classes 5
"""

import argparse
import json
import os
import random
import re
import sys
from datetime import datetime
from pathlib import Path

import requests
import yaml

from _import_base import *  # noqa: F401,F403
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id, get_default_project_id


def load_version_config(version_id: str) -> dict:
    """从 references/yolo_versions.yaml 加载指定版本的配置。"""
    config_path = Path(_this_dir) / ".." / "references" / "yolo_versions.yaml"
    with open(config_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    versions = data.get("versions", {})
    if version_id not in versions:
        available = ", ".join(versions.keys())
        raise ValueError(f"未知的 YOLO 版本: {version_id}。可用版本: {available}")

    version_config = versions[version_id]
    shared = data.get("shared", {})

    # 合并共享配置
    return {**version_config, "shared": shared}


def _fix_path(path: str) -> str:
    """还原被 Git Bash 转义的 Linux 绝对路径。"""
    m = re.match(r"^[A-Za-z]:[/\\](?:Program Files[/\\]Git|Git)[/\\](.*)", path)
    if m:
        return "/" + m.group(1).replace("\\", "/")
    return path


def build_command(version_config: dict, args) -> str:
    """根据版本配置和参数生成训练命令。"""
    # 使用版本配置中的默认值（如果命令行未指定）
    defaults = version_config.get("defaults", {})
    epoch = args.epoch or defaults.get("epoch", 30)
    batch_size = args.batch_size or defaults.get("batch_size", 8)
    base_lr = args.base_lr or defaults.get("base_lr", 0.01)

    # 构建环境变量和命令
    cudnn_path = version_config.get("cudnn_ld_path", "")
    work_dir = version_config.get("work_dir", "")
    train_script = version_config.get("train_script", "")
    yml_config = version_config.get("yml_config", "")
    command_flags = version_config.get("command_flags", "")

    # 拼接命令
    env_part = f"export LD_LIBRARY_PATH={cudnn_path}:$LD_LIBRARY_PATH && "
    cd_part = f"cd {work_dir} && "
    train_part = f"python3 {train_script} -c ../{yml_config} "
    params_part = (
        f"-o epoch={epoch} "
        f"-o batch_size={batch_size} "
        f"-o base_lr={base_lr} "
        f"-o num_classes={args.num_classes} "
    )
    flags_part = command_flags if command_flags else ""

    full_command = f"{env_part}{cd_part}{train_part}{params_part}{flags_part}".strip()

    return f"/bin/bash\n-c\n{full_command}"


def create_task(args) -> dict:
    """创建训练任务。"""
    version_config = load_version_config(args.yolo_version)
    command = build_command(version_config, args)

    # 修正路径
    output_host_path = _fix_path(args.output_host_path)
    dataset_host_path = _fix_path(args.dataset_host_path)

    # 获取共享配置
    shared = version_config.get("shared", {})
    scheduler = shared.get("scheduler", {})

    # 构建请求体
    body = {
        "name": args.task_name,
        "type": version_config.get("framework", {}).get("type", "standalone"),
        "frameworkOptions": {
            "name": version_config.get("framework", {}).get("name", "Stardard"),
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
                "image": version_config.get("image", ""),
                "rid": None,
            }
        ],
        "shmSize": 0,
        "envs": [],
        "command": command,
        "porst": [],
        "fileManagerMount": [],
        "datasetMount": [
            {
                "containerPath": version_config.get("dataset_container_path", ""),
                "hostPath": dataset_host_path,
            }
        ],
        "nasMount": [],
        "outputMount": [
            {
                "containerPath": version_config.get("output_container_path", ""),
                "hostPath": output_host_path,
            }
        ],
        "suspend": False,
        "terminate": False,
        "schedulerOptions": {
            "priorityClassName": scheduler.get("priorityClassName", "infer-med"),
            "schedulerName": scheduler.get("schedulerName", "volcano"),
            "queue": scheduler.get("queue", "default"),
            "podGroup": scheduler.get("podGroup", "default"),
            "strategy": scheduler.get("strategy", "spreadout"),
            "minAvailable": scheduler.get("minAvailable", 1),
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
        description="创建 YOLO 训练任务（支持多版本）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--yolo-version", default="yolov5",
        help="YOLO 版本 ID（默认 yolov5），支持：yolov5"
    )
    parser.add_argument("--task-name", required=True, help="训练任务名称")
    parser.add_argument("--resource-group-id", required=True, help="资源组 ID")
    parser.add_argument("--resource-spec-id", required=True, help="资源规格 ID（quotaId）")
    parser.add_argument("--num-classes", type=int, required=True, help="数据集类别数")
    parser.add_argument("--dataset-host-path", required=True, help="数据集在平台的目录路径")
    parser.add_argument("--output-host-path", required=True, help="训练结果保存的平台目录路径")
    parser.add_argument("--epoch", type=int, default=None, help="训练轮数（默认使用版本配置）")
    parser.add_argument("--batch-size", type=int, default=None, help="批大小（默认使用版本配置）")
    parser.add_argument("--base-lr", type=float, default=None, help="初始学习率（默认使用版本配置）")
    parser.add_argument("--auto-stop-hours", type=int, default=None, help="自动停止小时数")
    parser.add_argument("--project-id", default=default_project_id, help="项目 ID")
    args = parser.parse_args()
    args.project_id = str(args.project_id or get_current_project_id())

    try:
        result = create_task(args)
    except ValueError as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))

    task_id = None
    if isinstance(result.get("data"), dict):
        task_id = result["data"].get("id") or result["data"].get("taskId")
    elif result.get("data"):
        task_id = result["data"]

    if task_id:
        print(f"\n[成功] YOLO 训练任务已创建，任务ID: {task_id}", file=sys.stderr)
    elif result.get("code") != 200:
        print(f"\n[失败] {result.get('message') or result.get('error')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
