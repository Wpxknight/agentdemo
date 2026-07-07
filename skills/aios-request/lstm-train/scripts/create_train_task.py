"""
创建 LSTM 训练任务。

用法：
  python scripts/create_train_task.py \
    --task-name <任务名> \
    --resource-group-id <资源组ID> \
    --resource-spec-id <规格ID> \
    --dataset-host-path <数据集平台路径，可选> \
    --output-host-path <输出目录平台路径> \
    --model-type <small|medium|large> \
    --rnn-model <basic_lstm> \
    [--auto-stop-hours N]

示例：
  python scripts/create_train_task.py \
    --task-name lstm-20260421-test \
    --resource-group-id ae6a4e72-096e-413f-8c54-b4bea61d2456 \
    --resource-spec-id 58 \
    --dataset-host-path /opt/bcc/storage2/datasets/users/poc02-8/wenbenshuju-2-input/v1.0 \
    --output-host-path /opt/bcc/storage2/users/poc02-8/lstm-output-test \
    --model-type small \
    --rnn-model basic_lstm
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

import requests
import yaml

from _import_base import *  # noqa: F401,F403
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id, get_default_project_id

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))


def load_version_config(version_id: str = "paddle_lstm") -> dict:
    """从 references/lstm_versions.yaml 加载版本配置。"""
    config_path = Path(_THIS_DIR) / ".." / "references" / "lstm_versions.yaml"
    with open(config_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    versions = data.get("versions", {})
    if version_id not in versions:
        available = ", ".join(versions.keys())
        raise ValueError(f"未知的 LSTM 版本: {version_id}。可用版本: {available}")

    version_config = versions[version_id]
    shared = data.get("shared", {})

    return {**version_config, "shared": shared}


def _fix_path(path: str) -> str:
    """还原被 Git Bash 转义的 Linux 绝对路径。"""
    m = re.match(r"^[A-Za-z]:[/\\](?:Program Files[/\\]Git|Git)[/\\](.*)", path)
    if m:
        return "/" + m.group(1).replace("\\", "/")
    return path


def build_command(version_config: dict, args) -> str:
    """根据版本配置和参数生成训练命令。"""
    defaults = version_config.get("defaults", {})
    model_type = args.model_type or defaults.get("model_type", "small")
    rnn_model = args.rnn_model or defaults.get("rnn_model", "basic_lstm")

    work_dir = version_config.get("work_dir", "")
    train_script = version_config.get("train_script", "")

    if args.dataset_host_path:
        data_path = version_config.get("dataset_container_path", "")
    else:
        data_path = version_config.get("builtin_data_path", version_config.get("dataset_container_path", ""))

    cd_part = f"cd {work_dir} && "
    train_part = (
        f"python3 {train_script} "
        f"--use_gpu True "
        f"--data_path {data_path} "
        f"--model_type {model_type} "
        f"--rnn_model {rnn_model}"
    )

    full_command = f"{cd_part}{train_part}".strip()

    return f"/bin/bash\n-c\n{full_command}"


def create_task(args) -> dict:
    """创建训练任务。"""
    version_config = load_version_config()
    command = build_command(version_config, args)

    output_host_path = _fix_path(args.output_host_path)

    shared = version_config.get("shared", {})
    scheduler = shared.get("scheduler", {})

    if args.dataset_host_path:
        dataset_host_path = _fix_path(args.dataset_host_path)
        dataset_mount = [
            {
                "containerPath": version_config.get("dataset_container_path", ""),
                "hostPath": dataset_host_path,
            }
        ]
    else:
        dataset_mount = []

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
        "datasetMount": dataset_mount,
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
        description="创建 LSTM 训练任务",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--task-name", required=True, help="训练任务名称")
    parser.add_argument("--resource-group-id", required=True, help="资源组 UUID（从 resourceGroup[].id 获取）")
    parser.add_argument("--resource-spec-id", required=True, help="资源规格 ID（quotaId）")
    parser.add_argument("--dataset-host-path", default=None, help="数据集在平台的目录路径（不传则使用镜像自带数据）")
    parser.add_argument("--output-host-path", required=True, help="训练结果保存的平台目录路径")
    parser.add_argument("--model-type", default="small", help="模型大小：small / medium / large（默认 small）")
    parser.add_argument("--rnn-model", default="basic_lstm", help="RNN 模型类型（默认 basic_lstm）")
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
        print(f"\n[成功] LSTM 训练任务已创建，任务ID: {task_id}", file=sys.stderr)
    elif result.get("code") != 200:
        print(f"\n[失败] {result.get('message') or result.get('error')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
