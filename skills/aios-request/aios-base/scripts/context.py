"""
上下文模块。负责租户和项目上下文的本地缓存与读取。
"""

import json
import os
from datetime import datetime
from typing import Optional

from config import CONTEXT_FILE


SETUP_CONTEXT_HINT = (
    "未找到有效上下文。请先让 agent 查询当前用户可选的租户和项目，"
    "自动默认单个选项，若存在多个再让用户选择，最后执行 "
    "python ../aios-base/scripts/setup_context.py --tenant-id <租户ID> --project-id <项目ID>。"
)


class ContextError(RuntimeError):
    """上下文相关错误。"""


def _load_context() -> dict:
    if not os.path.exists(CONTEXT_FILE):
        return {}
    try:
        with open(CONTEXT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_context(
    tenant_id: str,
    project_id: str,
    tenant_name: Optional[str] = None,
    project_name: Optional[str] = None,
):
    data = {
        "tenant_id": str(tenant_id),
        "project_id": str(project_id),
        "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    if tenant_name:
        data["tenant_name"] = str(tenant_name)
    if project_name:
        data["project_name"] = str(project_name)

    with open(CONTEXT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def clear_context():
    if os.path.exists(CONTEXT_FILE):
        os.remove(CONTEXT_FILE)


def get_context() -> dict:
    return _load_context()


def get_default_tenant_id() -> Optional[str]:
    return _load_context().get("tenant_id")


def get_default_project_id() -> Optional[str]:
    return _load_context().get("project_id")


def get_current_tenant_id() -> str:
    tenant_id = _load_context().get("tenant_id")
    if not tenant_id:
        raise ContextError(f"未配置租户。{SETUP_CONTEXT_HINT}")
    return str(tenant_id)


def get_current_project_id() -> str:
    project_id = _load_context().get("project_id")
    if not project_id:
        raise ContextError(f"未配置项目。{SETUP_CONTEXT_HINT}")
    return str(project_id)


def has_context() -> bool:
    data = _load_context()
    return bool(data.get("tenant_id")) and bool(data.get("project_id"))
