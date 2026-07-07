"""
统一算法训练任务创建脚本。

用法：
  python scripts/create_train_task.py \
    --algo-config references/yolo.yaml \
    --algo-version yolov5 \
    --task-name <任务名> \
    --resource-group-id <资源组ID> \
    --resource-spec-id <规格ID> \
    --output-host-path <输出路径> \
    --algo-params '{"epoch":30,"batch_size":8,"num_classes":5}' \
    [--dataset-host-path <数据集路径>] \
    [--auto-stop-hours N] \
    [--project-id <项目ID>]

示例（YOLO，挂载数据集）：
  python scripts/create_train_task.py \
    --algo-config references/yolo.yaml \
    --algo-version yolov5 \
    --task-name yolov5-20260408-test \
    --resource-group-id ae6a4e72-096e-413f-8c54-b4bea61d2456 \
    --resource-spec-id 58 \
    --output-host-path /opt/bcc/storage2/users/poc02-8/yolov5-output-test \
    --algo-params '{"epoch":30,"batch_size":8,"base_lr":0.01,"num_classes":5}' \
    --dataset-host-path /opt/bcc/storage2/users/poc02-8/dataset

示例（LSTM，使用镜像自带数据）：
  python scripts/create_train_task.py \
    --algo-config references/lstm.yaml \
    --algo-version paddle_lstm \
    --task-name lstm-20260421-test \
    --resource-group-id ae6a4e72-096e-413f-8c54-b4bea61d2456 \
    --resource-spec-id 58 \
    --output-host-path /opt/bcc/storage2/users/poc02-8/lstm-output-test \
    --algo-params '{"model_type":"small","rnn_model":"basic_lstm"}'
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
from api_utils import fix_stdout_encoding
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id, get_default_project_id

fix_stdout_encoding()

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))


def load_algo_config(config_path: str, version_id: str) -> dict:
    """从算法配置 YAML 加载指定版本的配置。"""
    abs_path = Path(_THIS_DIR) / ".." / config_path if not os.path.isabs(config_path) else Path(config_path)
    with open(abs_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    versions = data.get("versions", {})
    if version_id not in versions:
        available = ", ".join(versions.keys())
        raise ValueError(f"未知的版本: {version_id}。可用版本: {available}")

    version_config = versions[version_id]
    shared = data.get("shared", {})

    return {**version_config, "shared": shared}


def _fix_path(path: str) -> str:
    """还原被 Git Bash 转义的 Linux 绝对路径。"""
    m = re.match(r"^[A-Za-z]:[/\\](?:Program Files[/\\]Git|Git)[/\\](.*)", path)
    if m:
        return "/" + m.group(1).replace("\\", "/")
    return path


def render_command(version_config: dict, algo_params: dict, has_dataset: bool) -> str:
    """根据 command_template 和参数渲染训练命令。"""
    template = version_config.get("command_template", "")
    if not template:
        raise ValueError("算法配置中未定义 command_template")

    # 不参与命令渲染的元数据字段
    # 注意：output_container_path 已从排除列表移除，允许在 command_template 中通过
    # {{output_container_path}} 引用输出挂载路径，用于将结果写入持久化目录
    _META_KEYS = frozenset({
        "shared", "params", "dataset_detection", "dataset_mount",
        "command_template", "framework", "task_prefix", "task_type",
        "ide_type", "tool_port", "ide_usage", "name", "description", "image",
        "has_quick_mode", "builtin_data_path",
        "dataset_data_path",
    })

    # 从版本配置中提取所有标量字段作为渲染上下文
    render_context = {}
    for key, value in version_config.items():
        if key in _META_KEYS or isinstance(value, (dict, list)):
            continue
        render_context[key] = value

    # 处理 data_path 的特殊逻辑（脚本预处理，不放在模板中）
    # builtin_data_path 可能在顶层或 dataset_mount 下，需兼容两种位置
    _builtin = version_config.get("builtin_data_path") or (
        isinstance(version_config.get("dataset_mount"), dict)
        and version_config["dataset_mount"].get("builtin_data_path")
    ) or ""
    if has_dataset:
        # 用户挂载数据时，优先使用 dataset_data_path（支持数据子目录结构），
        # 回退到 dataset_container_path（数据直接在挂载根目录的情况）
        render_context["data_path"] = version_config.get(
            "dataset_data_path",
            version_config.get("dataset_container_path", ""),
        )
    else:
        render_context["data_path"] = _builtin or version_config.get("dataset_container_path", "")

    # 合并用户传入的算法参数（可覆盖配置值）
    render_context.update(algo_params)

    # 渲染模板：替换所有 {{key}} 占位符
    command = template.strip()
    for key, value in render_context.items():
        if value is None:
            continue
        command = command.replace(f"{{{{{key}}}}}", str(value))

    # 合并多行命令为单行（YAML | 块标量保留换行，平台按行分割执行会出错）
    command = command.replace("\\\n", " ")
    command = " ".join(command.split())

    return f"/bin/bash\n-c\n{command}"


def create_task(args) -> dict:
    """创建训练任务。"""
    version_config = load_algo_config(args.algo_config, args.algo_version)
    algo_params = json.loads(args.algo_params)
    has_dataset = args.dataset_host_path is not None and args.dataset_host_path.strip() != ""

    command = render_command(version_config, algo_params, has_dataset)

    output_host_path = _fix_path(args.output_host_path)

    # 获取共享配置
    shared = version_config.get("shared", {})
    scheduler = shared.get("scheduler", {})

    # 构建 datasetMount
    if has_dataset:
        dataset_host_path = _fix_path(args.dataset_host_path)
        dataset_mount = [
            {
                "containerPath": version_config.get("dataset_container_path", ""),
                "hostPath": dataset_host_path,
            }
        ]
    else:
        dataset_mount = []

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
        description="统一算法训练任务创建",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python scripts/create_train_task.py \\\n"
            "    --algo-config references/yolo.yaml \\\n"
            "    --algo-version yolov5 \\\n"
            "    --task-name yolov5-20260408-test \\\n"
            '    --algo-params \'{"epoch":30,"num_classes":5}\'\n'
        ),
    )
    parser.add_argument("--algo-config", required=True, help="算法配置文件路径（相对于 aios-algorithm 目录）")
    parser.add_argument("--algo-version", required=True, help="算法版本 ID")
    parser.add_argument("--task-name", required=True, help="训练任务名称")
    parser.add_argument("--resource-group-id", required=True, help="资源组 ID")
    parser.add_argument("--resource-spec-id", required=True, help="资源规格 ID（quotaId）")
    parser.add_argument("--output-host-path", required=True, help="训练结果保存的平台目录路径")
    parser.add_argument("--algo-params", required=True, help='算法参数 JSON 字符串，如 \'{"epoch":30}\'')
    parser.add_argument("--dataset-host-path", default=None, help="数据集在平台的目录路径（不传则使用镜像自带数据）")
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
        print(f"\n[成功] 训练任务已创建，任务ID: {task_id}", file=sys.stderr)
    elif result.get("code") != 200:
        print(f"\n[失败] {result.get('message') or result.get('error')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
