"""
创建推理任务（完整参数版）。

用法：
  python scripts/create_infer_task.py \
    --task-name <名称> \
    --model-source <1|2> \
    --deploy-type <1|2> \
    --framework <推理框架> \
    --resource-group-id <资源组ID> \
    --resource-spec-id <规格ID> \
    [其他可选参数 ...]

示例（模型仓库 + 框架默认镜像）：
  python scripts/create_infer_task.py \
    --task-name my-infer \
    --model-source 1 \
    --model-id 323 --model-name "Qwen3.5-0.8B" --model-path "/data/models/Qwen3.5-0.8B" \
    --model-type text-generation --model-type-parent-id 58 \
    --deploy-type 1 --framework vllm --replicas 1 \
    --image-source 1 \
    --resource-group-id abc --resource-spec-id 123 \
    --schedule-strategy local

示例（训练任务 + 自定义镜像）：
  python scripts/create_infer_task.py \
    --task-name my-infer \
    --model-source 2 \
    --train-task-id task-123 --train-task-output "/opt/bcc/storage2/users/poc/output" \
    --deploy-type 1 --framework vllm --replicas 1 \
    --image-source 3 --image "my-registry/my-image:latest" \
    --resource-group-id abc --resource-spec-id 123 \
    --schedule-strategy local
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_post
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id, get_default_project_id


def create_infer_task(args) -> dict:
    project_id = str(args.project_id)

    # 构建模型挂载
    if args.model_source == 1:
        model_mount = {
            "containerPath": "/mnt/models/",
            "hostPath": args.model_path,
        }
        train_task_mount = {"id": None, "containerPath": None, "hostPath": None}
        options_model_id = int(args.model_id)
        # modelVersion 使用模型记录的 ID（非 version 字符串）
        options_model_version = int(args.model_id)
        options_model_name = args.model_name
        model_type = args.model_type or "text-generation"
        model_type_parent_id = args.model_type_parent_id or 59
    else:
        model_mount = {"containerPath": None, "hostPath": None}
        train_task_mount = {
            "id": args.train_task_id,
            "containerPath": "/mnt/models/",
            "hostPath": args.train_task_output,
        }
        options_model_id = None
        options_model_version = None
        options_model_name = args.train_task_id
        model_type = "text-generation"
        model_type_parent_id = 59

    # 构建端口列表
    ports = []
    if args.ports:
        for p in args.ports.split(","):
            p = p.strip()
            if p:
                ports.append(int(p))

    # 构建数据挂载
    data_mounts = []
    if args.data_mounts:
        try:
            data_mounts = json.loads(args.data_mounts)
        except json.JSONDecodeError:
            print("[错误] data-mounts 参数 JSON 解析失败", file=sys.stderr)
            sys.exit(1)

    # 构建环境变量
    envs = []
    if args.envs:
        try:
            envs = json.loads(args.envs)
        except json.JSONDecodeError:
            print("[错误] envs 参数 JSON 解析失败", file=sys.stderr)
            sys.exit(1)

    # 构建请求体
    body = {
        "name": args.task_name,
        "modelSource": args.model_source,
        "mode": "standard",
        "modelMount": model_mount,
        "trainTaskMount": train_task_mount,
        "options": {
            "modelId": options_model_id,
            "modelVersion": options_model_version,
            "modelName": options_model_name,
            "framework": args.framework,
            "moreConfig": True,
            "tensorParallelScale": args.tensor_parallel_scale,
            "maxContextLength": args.max_context_length,
            "customParams": args.custom_params,
            "modelDir": "/mnt/models",
            "rayClusterEnable": False,
            "rayClusterId": None,
            "rayClusterAddress": None,
            "rayClusterNamespace": None,
            "modelType": model_type,
            "modelTypeParentId": model_type_parent_id,
        },
        "xinference": {
            "modelFramework": None,
            "modelName": None,
            "modelFormat": None,
            "modelSize": None,
            "modelQuantization": None,
        },
        "replicas": args.replicas,
        "command": args.command,
        "envs": envs,
        "serviceEndpoint": f"{BASE_URL.rsplit('/paas-web', 1)[0]}/portal-cluster-infer",
        "servicePath": None,
        "imageSource": args.image_source,
        "image": args.image,
        "rid": None,
        "resourceGroupId": args.resource_group_id,
        "resourceSpecId": args.resource_spec_id,
        "fileManagerMount": data_mounts,
        "shmSizeSwitch": False,
        "shmSize": None,
        "deployType": args.deploy_type,
        "scheduleStrategy": args.schedule_strategy,
        "gpuResourceGroupId": args.remote_resource_group_id if args.schedule_strategy == "remote" else None,
        "gpuResourceSpecId": args.remote_resource_spec_id if args.schedule_strategy == "remote" else None,
        "ports": ports,
        "autoStop": args.auto_stop,
        "autoStopTime": args.auto_stop_hours if args.auto_stop else None,
        "rdma": args.rdma,
        "suspend": False,
        "terminate": False,
        "projectId": int(project_id),
    }

    headers = get_auth_headers({
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "projectId": project_id,
    })

    return api_post(f"{BASE_URL}/inferapi/model/infer", headers, json=body, timeout=30)


def main():
    default_project_id = get_default_project_id()
    parser = argparse.ArgumentParser(
        description="创建推理任务（完整参数版）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # 必填参数
    parser.add_argument("--task-name", required=True, help="推理任务名称")
    parser.add_argument("--model-source", type=int, required=True, choices=[1, 2],
                        help="模型来源：1=模型仓库, 2=训练任务")
    parser.add_argument("--deploy-type", type=int, required=True, choices=[1, 2],
                        help="部署方式：1=单机, 2=分布式")
    parser.add_argument("--framework", required=True, help="推理框架 key（如 vllm, fastchat, tgi）")
    parser.add_argument("--resource-group-id", required=True, help="资源组 ID")
    parser.add_argument("--resource-spec-id", type=int, required=True, help="资源规格 ID")

    # 模型仓库参数（model-source=1）
    parser.add_argument("--model-id", default=None, help="模型记录 ID（model-source=1 时必填，同时作为 modelVersion）")
    parser.add_argument("--model-name", default=None, help="模型名称（model-source=1 时必填）")
    parser.add_argument("--model-path", default=None, help="模型路径（model-source=1 时必填）")
    parser.add_argument("--model-type", default=None,
                        help="模型类型值（如 text-generation，来自模型数据 modelTypeValue）")
    parser.add_argument("--model-type-parent-id", type=int, default=None,
                        help="模型类型父 ID（来自模型数据 modelTypeParentId）")

    # 训练任务参数（model-source=2）
    parser.add_argument("--train-task-id", default=None, help="训练任务 ID（model-source=2 时必填）")
    parser.add_argument("--train-task-output", default=None, help="训练任务输出路径（model-source=2 时必填）")

    # 可选参数
    parser.add_argument("--replicas", type=int, default=1, help="实例个数（默认 1）")
    parser.add_argument("--image-source", type=int, default=1, choices=[1, 2, 3],
                        help="镜像来源：1=框架默认, 2=自定义镜像, 3=第三方镜像")
    parser.add_argument("--image", default=None, help="镜像地址（image-source=2或3时必填）")
    parser.add_argument("--command", default=None, help="启动命令（使用框架默认时可为 null）")
    parser.add_argument("--ports", default=None, help="端口号，多端口用逗号分隔（如 8080,8081）")
    parser.add_argument("--data-mounts", default=None,
                        help="数据挂载 JSON，如 [{\"containerPath\":\"/mnt/data\",\"hostPath\":\"/opt/data\"}]")
    parser.add_argument("--envs", default=None,
                        help="环境变量 JSON，如 [{\"name\":\"KEY\",\"value\":\"VAL\"}]")
    parser.add_argument("--schedule-strategy", default="local", choices=["local", "remote"],
                        help="调度策略（默认 local）")
    parser.add_argument("--remote-resource-group-id", default=None, help="远程资源组 ID（远程调度时必填）")
    parser.add_argument("--remote-resource-spec-id", type=int, default=None,
                        help="远程资源规格 ID（远程调度时必填）")
    parser.add_argument("--auto-stop", type=lambda x: x.lower() == "true", default=False,
                        help="是否自动停止（true/false，默认 false）")
    parser.add_argument("--auto-stop-hours", type=int, default=None, help="自动停止小时数")
    parser.add_argument("--rdma", type=lambda x: x.lower() == "true", default=False,
                        help="是否启用 RDMA（true/false，默认 false）")

    # 框架参数
    parser.add_argument("--max-context-length", type=int, default=8192,
                        help="最大上下文长度（默认 8192）")
    parser.add_argument("--tensor-parallel-scale", type=int, default=1,
                        help="张量并行度（默认 1）")
    parser.add_argument("--custom-params", default=None,
                        help="框架自定义参数（来自框架 args 拼接或用户自定义）")

    parser.add_argument("--project-id", default=default_project_id, help="项目 ID（默认使用当前上下文）")

    args = parser.parse_args()
    args.project_id = str(args.project_id or get_current_project_id())

    # 参数校验
    if args.model_source == 1:
        if not all([args.model_id, args.model_name, args.model_path]):
            print("[错误] model-source=1 时必须提供 --model-id, --model-name, --model-path",
                  file=sys.stderr)
            sys.exit(1)
    else:
        if not all([args.train_task_id, args.train_task_output]):
            print("[错误] model-source=2 时必须提供 --train-task-id, --train-task-output",
                  file=sys.stderr)
            sys.exit(1)

    if args.image_source in (2, 3) and not args.image:
        print("[错误] image-source=2或3 时必须提供 --image", file=sys.stderr)
        sys.exit(1)

    if args.schedule_strategy == "remote":
        if not all([args.remote_resource_group_id, args.remote_resource_spec_id]):
            print("[错误] 远程调度时必须提供 --remote-resource-group-id 和 --remote-resource-spec-id",
                  file=sys.stderr)
            sys.exit(1)

    result = create_infer_task(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    task_id = None
    if isinstance(result.get("data"), dict):
        task_id = result["data"].get("id") or result["data"].get("taskId")
    elif result.get("data"):
        task_id = result["data"]

    if task_id:
        print(f"\n[成功] 推理任务已创建，任务ID: {task_id}", file=sys.stderr)
    elif result.get("success") is False or result.get("code") != 200:
        print(f"\n[失败] {result.get('error') or result.get('message')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
