"""
报表权限前置检查。
验证当前用户是否具有管理员角色，报表功能仅限管理员使用。
"""

import json
import sys
import os

from _import_base import *  # noqa: F401,F403

import requests
from auth import get_token_data
from config import BASE_URL, SYSTEM_ID

PLATFORM_TENANT_NAME = "Platform"


def main():
    try:
        token_data = get_token_data()
    except Exception as e:
        print(json.dumps({
            "success": False,
            "message": f"未登录或 token 无效：{e}",
            "next_step": "setup_auth",
        }, ensure_ascii=False))
        return

    headers = {
        "token": token_data["token"],
        "refreshToken": token_data["refreshToken"],
        "systemId": SYSTEM_ID,
    }

    try:
        resp = requests.get(
            f"{BASE_URL}/upmstreeapi/tenants/account",
            headers=headers,
            timeout=10,
        )
        resp.raise_for_status()
        result = resp.json()
    except Exception as e:
        print(json.dumps({
            "success": False,
            "message": f"权限检查请求失败：{e}",
            "next_step": "setup_auth",
        }, ensure_ascii=False))
        return

    if result.get("code") != 200 or not result.get("data"):
        print(json.dumps({
            "success": False,
            "message": "权限检查接口返回异常",
            "next_step": "setup_auth",
        }, ensure_ascii=False))
        return

    tenants = result["data"]
    is_admin = any(t.get("name") == PLATFORM_TENANT_NAME for t in tenants)
    username = token_data.get("username", "unknown")

    if is_admin:
        print(json.dumps({
            "success": True,
            "message": f"用户 {username} 具有管理员权限",
            "next_step": "run_business_script",
        }, ensure_ascii=False))
    else:
        tenant_names = [t.get("name") for t in tenants]
        print(json.dumps({
            "success": False,
            "message": f"用户 {username} 不是平台管理员（tenants: {tenant_names}），报表功能仅限平台管理员使用",
            "next_step": "forbidden",
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
