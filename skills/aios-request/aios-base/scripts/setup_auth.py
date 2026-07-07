"""
认证初始化脚本。由 agent 传入账号密码后执行，生成 token.json。
"""

import argparse
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from auth import AuthError, has_valid_token, login_with_credentials
from config import TOKEN_FILE
from context import clear_context, has_context


def main():
    parser = argparse.ArgumentParser(description="登录模型训推平台并缓存 token")
    parser.add_argument("--username", help="平台账号；缺省读环境变量 AIOS_USERNAME")
    parser.add_argument("--password", help="平台密码；缺省读环境变量 AIOS_PASSWORD（推荐：避免密码出现在进程列表）")
    args = parser.parse_args()

    username = args.username or os.environ.get("AIOS_USERNAME", "")
    password = args.password or os.environ.get("AIOS_PASSWORD", "")
    if not username or not password:
        raise SystemExit(
            "缺少账号或密码。请向用户索取后执行："
            "export AIOS_USERNAME='<账号>' AIOS_PASSWORD='<密码>' && python setup_auth.py"
        )

    try:
        login_with_credentials(username=username, password=password)
    except requests.HTTPError as exc:
        detail = exc.response.text if exc.response is not None else str(exc)
        raise SystemExit(f"认证失败：{detail}")
    except AuthError as exc:
        raise SystemExit(str(exc))

    # 换账号登录后，旧上下文（租户/项目）对新账号未必有效，强制清除
    clear_context()

    result = {
        "success": True,
        "token_file": TOKEN_FILE,
        "auth_ready": has_valid_token(),
        "context_ready": has_context(),
        "next_step": "resolve_context",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
