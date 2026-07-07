"""
创建 IDE 任务（算法模板从 IDE 启动）。

调用 /paas-web/developkitapi/deployenv/onlineide 接口，
创建 Jupyter Notebook IDE 实例，用户在平台 IDE 中交互式操作。

用法：
  python scripts/create_ide_task.py \
    --algo-config references/tsf.yaml \
    --algo-version tsf \
    --task-name <任务名> \
    --resource-group-id <资源组ID> \
    --resource-spec-id <规格ID> \
    [--auto-stop-hours N] \
    [--project-id <项目ID>]

示例：
  python scripts/create_ide_task.py \
    --algo-config references/tsf.yaml \
    --algo-version tsf \
    --task-name tsf-20260427-test \
    --resource-group-id ae6a4e72-096e-413f-8c54-b4bea61d2456 \
    --resource-spec-id 76
"""

import argparse
import json
import os
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

# IDE 接口基础路径：BASE_URL = .../paas-web，IDE API 在 /paas-web/developkitapi 下
IDE_BASE_URL = BASE_URL + "/developkitapi"


def load_algo_config(config_path: str, version_id: str) -> dict:
    """从算法配置 YAML 加载指定版本的配置。"""
    abs_path = Path(_THIS_DIR) / ".." / config_path if not os.path.isabs(config_path) else Path(config_path)
    with open(abs_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)

    versions = data.get("versions", {})
    if version_id not in versions:
        available = ", ".join(versions.keys())
        raise ValueError(f"未知的版本: {version_id}。可用版本: {available}")

    return versions[version_id]


def create_ide_task(args) -> dict:
    """创建 IDE 任务。"""
    version_config = load_algo_config(args.algo_config, args.algo_version)

    body = {
        "name": args.task_name,
        "autoStop": args.auto_stop_hours is not None,
        "autoStopTime": args.auto_stop_hours,
        "envs": [],
        "command": "",
        "describe": "",
        "resourceGroupId": args.resource_group_id,
        "resourceSpecId": int(args.resource_spec_id),
        "shmSize": 0,
        "shmSizeSwitch": False,
        "fileManagerMount": [],
        "datasetMount": [],
        "scheduleStrategy": "local",
        "gitRepository": False,
        "gitUrl": None,
        "gitBranch": None,
        "gitLoginType": 1,
        "gitAccount": None,
        "gitPassword": None,
        "gitPasswordKey": None,
        "id": None,
        "description": version_config.get("description", ""),
        "icon": None,
        "ideType": version_config.get("ide_type", "notebook"),
        "imageType": 1,
        "image": version_config.get("image", ""),
        "createTime": None,
        "createId": None,
        "createName": None,
        "inbuilt": 0,
        "iconBase64": None,
        "rid": 1,
        "toolPort": version_config.get("tool_port", 31000),
        "projectId": int(args.project_id),
        "publicKey": "",
        "sshConnect": False,
        "replicas": 1,
    }

    headers = get_auth_headers({
        "Content-Type": "application/json;charset=UTF-8",
        "projectId": str(args.project_id),
    })

    resp = requests.post(
        f"{IDE_BASE_URL}/deployenv/onlineide",
        headers=headers,
        json=body,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    default_project_id = get_default_project_id()

    parser = argparse.ArgumentParser(
        description="创建 IDE 任务（算法模板从 IDE 启动）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python scripts/create_ide_task.py \\\n"
            "    --algo-config references/tsf.yaml \\\n"
            "    --algo-version tsf \\\n"
            "    --task-name tsf-20260427-test \\\n"
            "    --resource-group-id ae6a4e72-... \\\n"
            "    --resource-spec-id 76\n"
        ),
    )
    parser.add_argument("--algo-config", required=True, help="算法配置文件路径（相对于 aios-algorithm 目录）")
    parser.add_argument("--algo-version", required=True, help="算法版本 ID")
    parser.add_argument("--task-name", required=True, help="任务名称")
    parser.add_argument("--resource-group-id", required=True, help="资源组 ID")
    parser.add_argument("--resource-spec-id", required=True, help="资源规格 ID（quotaId）")
    parser.add_argument("--auto-stop-hours", type=int, default=None, help="自动停止小时数")
    parser.add_argument("--project-id", default=default_project_id, help="项目 ID")
    args = parser.parse_args()
    args.project_id = str(args.project_id or get_current_project_id())

    try:
        result = create_ide_task(args)
    except ValueError as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))

    task_id = None
    if isinstance(result.get("data"), dict):
        task_id = result["data"].get("id")
    elif result.get("data"):
        task_id = result["data"]

    if task_id:
        print(f"\n[成功] IDE 任务已创建，任务ID: {task_id}", file=sys.stderr)
    elif result.get("code") != 200:
        print(f"\n[失败] {result.get('message') or result.get('error')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
