"""
管理员权限验证脚本。
检查 token 有效性并验证当前用户是否具有管理员权限。

返回 JSON：
  - auth_ready: 是否已认证
  - is_admin: 是否为管理员
  - next_step: 建议的下一步动作
"""

import json
import os
import sys

# Windows 下 stdout 重编码为 UTF-8，避免中文乱码
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

from _import_base import *  # noqa: F401,F403
from auth import has_valid_token, get_token_data, SETUP_AUTH_HINT
from config import BASE_URL, TOKEN_FILE

import requests


def _check_admin_via_api() -> bool:
    """通过调用报表 API（最小请求）验证管理员权限。

    报表 API 以管理员身份调用（modelId=0, projectId 为空），
    若返回成功则说明当前用户具有管理员权限。
    """
    token_data = get_token_data()

    headers = {
        "token": token_data["token"],
        "refreshToken": token_data["refreshToken"],
        "systemId": "1",
        "BsmAjaxHeader": "true",
        "modelId": "0",
        "projectId": "",
    }

    payload = {
        "page": 1,
        "limit": 1,
        "filter": {},
    }

    try:
        resp = requests.post(
            f"{BASE_URL}/aiosreportapi/report/management/resource/list",
            headers=headers,
            json=payload,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        # code=0 表示成功，非管理员通常会被拦截返回错误码
        return data.get("code") == 0

    except requests.exceptions.HTTPError as e:
        # 403 或类似错误说明无权限
        if e.response is not None and e.response.status_code in (403, 401):
            return False
        raise
    except Exception:
        raise


def main():
    auth_ready = has_valid_token()

    if not auth_ready:
        result = {
            "success": True,
            "auth_ready": False,
            "is_admin": False,
            "token_file_exists": os.path.exists(TOKEN_FILE),
            "next_step": "setup_auth",
            "message": SETUP_AUTH_HINT,
        }
    else:
        try:
            is_admin = _check_admin_via_api()
            if is_admin:
                next_step = "run_business_script"
                message = "管理员权限验证通过。"
            else:
                next_step = "halt"
                message = "当前账号不是管理员，报表功能仅限管理员使用。"

            result = {
                "success": True,
                "auth_ready": True,
                "is_admin": is_admin,
                "token_file_exists": True,
                "next_step": next_step,
                "message": message,
            }
        except Exception as e:
            result = {
                "success": False,
                "auth_ready": True,
                "is_admin": False,
                "token_file_exists": True,
                "next_step": "halt",
                "message": f"管理员权限验证失败：{e}",
            }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
