"""
平台公共配置。
所有可变配置均从环境变量读取，避免在 skill 脚本中绑定具体环境。
"""

import os


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"缺少必要环境变量：{name}")
    return value.rstrip("/")


BASE_URL = _required_env("AIOS_BASE_URL")
LOGIN_URL = _required_env("AIOS_LOGIN_URL")

# 登录换 token 时使用的参数
# CLIENT_ID 为可选配置；未提供时使用平台默认客户端 ID。
CLIENT_ID = os.environ.get("AIOS_CLIENT_ID", "be2030fc2aa0416d8c9dcaa5081fb1ad").strip()
SYSTEM_ID = os.environ.get("AIOS_SYSTEM_ID", "1").strip() or "1"

# 集群与推理服务访问地址
CLUSTER_NAME = _required_env("AIOS_CLUSTER_NAME")
INFER_SERVICE_ENDPOINT = os.environ.get("AIOS_INFER_SERVICE_ENDPOINT", "").strip().rstrip("/") or (
    f"{BASE_URL.rsplit('/paas-web', 1)[0]}/{CLUSTER_NAME}-infer"
)

# 本地缓存文件
ROOT_DIR = os.path.join(os.path.dirname(__file__), "..")
TOKEN_FILE = os.environ.get("AIOS_TOKEN_FILE", os.path.join(ROOT_DIR, "token.json"))
CONTEXT_FILE = os.environ.get("AIOS_CONTEXT_FILE", os.path.join(ROOT_DIR, "context.json"))
