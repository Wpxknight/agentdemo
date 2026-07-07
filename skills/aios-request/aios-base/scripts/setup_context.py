"""
上下文初始化脚本。由 agent 传入租户 ID 和项目 ID 后执行，生成 context.json。
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from api_utils import api_get
from auth import AuthError, get_auth_headers, has_valid_token
from config import BASE_URL, CONTEXT_FILE, SYSTEM_ID
from context import ContextError, has_context, save_context


def validate_tenant(tenant_id: str):
    if not str(tenant_id or "").strip():
        raise ContextError("租户ID不能为空。")

    api_get(
        f"{BASE_URL}/bccapi/modelNew/page",
        get_auth_headers(tenant_id=tenant_id, require_tenant=False),
        params={
            "isShare": "true",
            "current": 1, "size": 1,
            "pageNum": 1, "pageSize": 1,
        },
    )


def validate_project(tenant_id: str, project_id: str) -> str:
    if str(project_id or "").strip():
        pass
    else:
        raise ContextError("项目ID不能为空。")

    data = api_get(
        f"{BASE_URL}/upmstreeapi/projects/{project_id}",
        get_auth_headers(
            {
                "Accept": "application/json, text/plain, */*",
                "projectId": str(project_id),
                "systemId": SYSTEM_ID,
            },
            tenant_id=tenant_id,
            require_tenant=False,
        ),
    )

    project_data = data.get("data", {})
    return str(project_data.get("name") or project_data.get("projectName") or "")


def main():
    parser = argparse.ArgumentParser(description="配置当前租户和项目")
    parser.add_argument("--tenant-id", required=True, help="租户ID")
    parser.add_argument("--project-id", required=True, help="项目ID")
    parser.add_argument("--tenant-name", default=None, help="租户名称，可选")
    parser.add_argument("--project-name", default=None, help="项目名称，可选")
    args = parser.parse_args()

    try:
        validate_tenant(args.tenant_id)
        project_name = args.project_name or validate_project(args.tenant_id, args.project_id)
    except Exception as exc:
        import requests as _requests
        if isinstance(exc, _requests.HTTPError):
            detail = exc.response.text if exc.response is not None else str(exc)
            raise SystemExit(f"上下文校验失败：{detail}")
        elif isinstance(exc, (AuthError, ContextError)):
            raise SystemExit(str(exc))
        raise

    save_context(
        tenant_id=args.tenant_id,
        project_id=args.project_id,
        tenant_name=args.tenant_name or None,
        project_name=project_name or None,
    )

    result = {
        "success": True,
        "token_file_ready": has_valid_token(),
        "context_file": CONTEXT_FILE,
        "context_ready": has_context(),
        "selected": {
            "tenant_id": str(args.tenant_id),
            "tenant_name": args.tenant_name or "",
            "project_id": str(args.project_id),
            "project_name": project_name or "",
        },
        "next_step": "run_business_script",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
