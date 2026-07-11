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
    parser.add_argument("--username", required=True, help="平台账号")
    parser.add_argument("--password", required=True, help="平台密码")
    args = parser.parse_args()

    # 嵌入部署下凭据由 aiop 平台按当前用户注入 token.json，禁止账密登录；
    # 仅本地/独立部署调试时通过 AIOS_ALLOW_PASSWORD_LOGIN=1 显式开启。
    if os.environ.get("AIOS_ALLOW_PASSWORD_LOGIN", "").strip().lower() not in ("1", "true"):
        raise SystemExit(
            "账密登录未启用：平台凭据应由 aiop 自动注入。"
            "请在 AIOS 平台重新登录后重试；本地调试可设置 AIOS_ALLOW_PASSWORD_LOGIN=1 开启。"
        )

    try:
        login_with_credentials(username=args.username, password=args.password)
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
