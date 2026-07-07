"""
报表脚本公共工具模块。
处理跨 skill 模块引用、编码修复、管理员认证头构造等共享逻辑。
"""

import json
import os
import sys

# Windows 下 stdout 重编码为 UTF-8
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from _import_base import *  # noqa: F401,F403
from auth import get_token_data
from config import BASE_URL, SYSTEM_ID


def make_admin_headers(extra: dict = None) -> dict:
    """构建管理员端请求头（modelId=0, projectId 为空）。"""
    token_data = get_token_data()
    headers = {
        "token": token_data["token"],
        "refreshToken": token_data["refreshToken"],
        "systemId": SYSTEM_ID,
        "BsmAjaxHeader": "true",
        "modelId": "0",
        "projectId": "",
    }
    if extra:
        headers.update(extra)
    return headers


def output_result(success: bool, data=None, message: str = "", **kwargs):
    """统一输出 JSON 结果。"""
    result = {"success": success, "message": message}
    if data is not None:
        result["data"] = data
    result.update(kwargs)
    print(json.dumps(result, ensure_ascii=False, indent=2))
