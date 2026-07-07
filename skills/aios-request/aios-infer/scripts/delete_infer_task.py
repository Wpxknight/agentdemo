"""
删除推理任务（先自动终止，再删除）
"""

import argparse
import json
import os
import sys

from _import_base import *  # noqa: F401,F403
from api_utils import api_delete, api_post, paginate_get
from auth import get_auth_headers
from config import BASE_URL
from context import get_current_project_id


def find_task_by_name(task_name: str, project_id: str) -> str:
    headers = get_auth_headers({"projectId": project_id})
    all_records = paginate_get(
        f"{BASE_URL}/inferapi/model/infer", headers,
        params={"serviceType": "mine"},
        record_keys=("items", "records", "list"),
        start_page=0, page_size=20,
    )

    target = task_name.lower()
    matched = [r for r in all_records if r.get("name", "").lower() == target]

    if not matched:
        available = sorted(r.get("name", "") for r in all_records if r.get("name"))
        print(f"[错误] 找不到名称为 '{task_name}' 的推理任务。", file=sys.stderr)
        if available:
            print(f"[提示] 当前可用任务列表（共 {len(available)} 个）：", file=sys.stderr)
            for name in available:
                print(f"  - {name}", file=sys.stderr)
        else:
            print("[提示] 当前没有可用的推理任务。", file=sys.stderr)
        sys.exit(1)

    task = matched[0]
    task_id = str(task.get("id") or task.get("taskId"))
    print(f"[info] 找到任务: {task.get('name')} (id={task_id})", file=sys.stderr)
    return task_id


def main():
    parser = argparse.ArgumentParser(
        description="删除推理任务（自动先终止再删除）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例（推荐，按名称删除）：
  python scripts/delete_infer_task.py --task-name my-infer-task

兼容旧用法：
  python scripts/delete_infer_task.py --task-id abc123
  python scripts/delete_infer_task.py --task-id abc123 --skip-terminate
        """,
    )
    parser.add_argument("--task-id", default=None, help="推理任务ID（与 --task-name 二选一）")
    parser.add_argument("--task-name", default=None, help="推理任务名称，自动查找对应ID（与 --task-id 二选一）")
    parser.add_argument("--skip-terminate", action="store_true", help="跳过终止步骤，直接删除")
    args = parser.parse_args()

    if not args.task_id and not args.task_name:
        parser.error("必须指定 --task-id 或 --task-name 之一")

    project_id = get_current_project_id()
    if args.task_id is None:
        args.task_id = find_task_by_name(args.task_name, project_id)

    headers_json = get_auth_headers({
        "Content-Type": "application/json",
        "projectId": project_id,
    })
    headers_base = get_auth_headers({"projectId": project_id})

    if not args.skip_terminate:
        print(f"[1/2] 正在终止任务 {args.task_id} ...", file=sys.stderr)
        terminate_result = api_post(
            f"{BASE_URL}/inferapi/model/infer/terminate",
            headers_json, json={"id": args.task_id},
        )
        print("终止结果：", terminate_result)

    print(f"[2/2] 正在删除任务 {args.task_id} ...", file=sys.stderr)
    delete_result = api_delete(f"{BASE_URL}/inferapi/model/infer/{args.task_id}", headers_base)
    print(json.dumps(delete_result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
