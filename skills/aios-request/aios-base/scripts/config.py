"""
平台公共配置。
环境信息一律来自环境变量（禁止在代码里写死地址 / client id）；
用户敏感信息（账号密码）不在此处出现，只在运行时由用户提供（见 setup_auth.py）。

必需环境变量：
- AIOS_BASE_URL   平台 API 地址，如 http://10.10.72.20:30001/paas-web
- AIOS_CLIENT_ID  登录换 token 的客户端 ID

可选环境变量：
- AIOS_LOGIN_URL     平台登录页地址；缺省取 AIOS_BASE_URL 的 origin
- AIOS_SYSTEM_ID     系统 ID，默认 "1"
- AIOS_CLUSTER_NAME  集群名；用到集群参数的脚本会各自校验
"""

import os
from urllib.parse import urlparse


class ConfigError(RuntimeError):
    """环境配置缺失。"""


def _require_env(key: str, hint: str) -> str:
    value = os.environ.get(key, "").strip()
    if not value:
        raise ConfigError(
            f"缺少环境变量 {key}（{hint}）。"
            f"请向用户确认该信息，然后在执行命令前 export {key}=... 再重试。"
        )
    return value


BASE_URL = _require_env("AIOS_BASE_URL", "平台 API 地址，如 http://<host>:<port>/paas-web")
CLIENT_ID = _require_env("AIOS_CLIENT_ID", "登录换 token 的客户端 ID，可从平台登录页请求中获取")

_parsed = urlparse(BASE_URL)
LOGIN_URL = os.environ.get("AIOS_LOGIN_URL", "").strip() or f"{_parsed.scheme}://{_parsed.netloc}/"

SYSTEM_ID = os.environ.get("AIOS_SYSTEM_ID", "1").strip() or "1"

# 集群名：仅部分脚本需要；为空时由使用方给出明确报错
CLUSTER_NAME = os.environ.get("AIOS_CLUSTER_NAME", "").strip()

# 本地缓存文件（沙箱临时文件系统内，随沙箱销毁）
ROOT_DIR = os.path.join(os.path.dirname(__file__), "..")
TOKEN_FILE = os.path.join(ROOT_DIR, "token.json")
CONTEXT_FILE = os.path.join(ROOT_DIR, "context.json")
