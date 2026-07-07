"""
前置检查脚本。返回当前是否已完成认证和上下文配置，以及下一步建议。
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from auth import has_valid_token
from config import CONTEXT_FILE, TOKEN_FILE
from context import has_context


def main():
    auth_ready = has_valid_token()
    context_ready = has_context()

    if not auth_ready:
        next_step = "setup_auth"
    elif not context_ready:
        next_step = "resolve_context"
    else:
        next_step = "run_business_script"

    result = {
        "success": True,
        "token_file_exists": os.path.exists(TOKEN_FILE),
        "auth_ready": auth_ready,
        "context_file_exists": os.path.exists(CONTEXT_FILE),
        "context_ready": context_ready,
        "next_step": next_step,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
