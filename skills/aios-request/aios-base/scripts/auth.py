"""
认证模块。负责登录换取 token、读取本地 token，以及组装请求头。
"""

import base64
import json
import os
import sys
import uuid
from datetime import datetime
from typing import Optional

import requests
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding as sym_padding

sys.path.insert(0, os.path.dirname(__file__))
from config import BASE_URL, CLIENT_ID, SYSTEM_ID, TOKEN_FILE


SETUP_AUTH_HINT = (
    "未找到有效 token。请先让 agent 在对话中提示用户输入账号和密码，"
    "然后执行 python ../aios-base/scripts/setup_auth.py --username <账号> --password <密码>。"
)


class AuthError(RuntimeError):
    """认证相关错误。"""


def _load_token() -> Optional[dict]:
    if not os.path.exists(TOKEN_FILE):
        return None
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _save_token(data: dict):
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def clear_token():
    if os.path.exists(TOKEN_FILE):
        os.remove(TOKEN_FILE)


def _is_expired(expired_time_str: str) -> bool:
    if not expired_time_str:
        return True
    try:
        expired_time_str = expired_time_str.replace("+0800", "+08:00")
        expired_dt = datetime.fromisoformat(expired_time_str)
        now = datetime.now(tz=expired_dt.tzinfo)
        return now >= expired_dt
    except Exception:
        return True


def _exchange_code_for_token(code: str, username: str) -> dict:
    resp = requests.get(
        f"{BASE_URL}/upmstreeapi/accessToken",
        params={"code": code},
        headers={"systemId": SYSTEM_ID},
        timeout=15,
    )
    resp.raise_for_status()

    token_data = resp.json().get("data", {})
    if not token_data.get("token"):
        raise AuthError(f"token 接口未返回有效 token，响应：{resp.json()}")

    token_data["username"] = username
    _save_token(token_data)
    return token_data


_AES_KEY = b"1234567890123456"
_AES_IV = b"1234567890123456"


def _encrypt_password(plaintext: str) -> str:
    """AES-CBC 加密密码：base64(明文) → AES-CBC → base64 输出。"""
    b64_plain = base64.b64encode(plaintext.encode("utf-8"))
    padder = sym_padding.PKCS7(128).padder()
    padded = padder.update(b64_plain) + padder.finalize()
    cipher = Cipher(algorithms.AES(_AES_KEY), modes.CBC(_AES_IV))
    enc = cipher.encryptor()
    ct = enc.update(padded) + enc.finalize()
    return base64.b64encode(ct).decode("utf-8")


def _get_client_id() -> str:
    return str(CLIENT_ID or "").strip() or uuid.uuid4().hex


def login_with_credentials(username: str, password: str) -> dict:
    if not str(username or "").strip():
        raise AuthError("账号不能为空。")
    if not str(password or "").strip():
        raise AuthError("密码不能为空。")

    resp = requests.post(
        f"{BASE_URL}/upmstreeapi/login",
        headers={
            "Content-Type": "application/json;charset=UTF-8",
            "systemId": SYSTEM_ID,
        },
        json={
            "typeConfigId": 0,
            "userName": username,
            "password": _encrypt_password(password),
            "clientId": _get_client_id(),
            "multfactor": "Y",
        },
        timeout=15,
    )
    resp.raise_for_status()

    login_data = resp.json()
    login_result = login_data.get("data")
    code = login_result.get("code") if isinstance(login_result, dict) else login_result
    if not code:
        raise AuthError(f"登录接口未返回 code，响应：{login_data}")

    return _exchange_code_for_token(str(code), username=username)


def get_token_data() -> dict:
    token_data = _load_token()
    if not token_data or not token_data.get("token"):
        raise AuthError(SETUP_AUTH_HINT)
    if _is_expired(token_data.get("expiredTime", "")):
        raise AuthError(f"token 已过期。{SETUP_AUTH_HINT}")
    return token_data


def has_valid_token() -> bool:
    token_data = _load_token()
    if not token_data or not token_data.get("token"):
        return False
    return not _is_expired(token_data.get("expiredTime", ""))


def login_with_token_data(token_data: dict) -> dict:
    """
    直接使用从浏览器获取的 token 数据进行认证。

    Args:
        token_data: 包含 token, refreshToken, expiredTime 等字段的字典

    Returns:
        保存的 token 数据
    """
    if not token_data or not token_data.get("token"):
        raise AuthError("token 数据无效或缺少 token 字段。")

    # 验证必要字段
    required_fields = ["token", "refreshToken", "expiredTime"]
    missing_fields = [f for f in required_fields if not token_data.get(f)]
    if missing_fields:
        raise AuthError(f"token 数据缺少必要字段: {', '.join(missing_fields)}")

    # 保存 token 数据
    _save_token(token_data)
    return token_data


def get_auth_headers(extra: dict = None, tenant_id: Optional[str] = None, require_tenant: bool = True) -> dict:
    token_data = get_token_data()
    if tenant_id is None and require_tenant:
        from context import get_current_tenant_id

        tenant_id = get_current_tenant_id()

    headers = {
        "token": token_data["token"],
        "refreshToken": token_data["refreshToken"],
        "systemId": SYSTEM_ID,
        "BsmAjaxHeader": "true",
    }
    if tenant_id:
        headers["modelId"] = str(tenant_id)
    if extra:
        headers.update(extra)
    return headers
