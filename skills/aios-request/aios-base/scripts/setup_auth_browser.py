"""
浏览器 Token 认证脚本。由 agent 通过 agent-browser 获取 token 后执行，生成 token.json。
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from auth import AuthError, has_valid_token, login_with_token_data
from config import TOKEN_FILE
from context import clear_context, has_context


def main():
    parser = argparse.ArgumentParser(description="使用从浏览器获取的 token 完成认证")
    parser.add_argument("--token-data", required=True, help="从浏览器 localStorage 获取的 token JSON 数据")
    args = parser.parse_args()

    try:
        # 解析 JSON 数据
        token_data = json.loads(args.token_data)
    except json.JSONDecodeError as e:
        raise SystemExit(f"token 数据格式错误：{e}")

    try:
        login_with_token_data(token_data)
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
