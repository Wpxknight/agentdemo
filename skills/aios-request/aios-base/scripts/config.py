"""
平台公共配置。
所有脚本只从这里读取静态常量，不在此处保存用户敏感信息。
"""

import os

BASE_URL = "http://js1.blockelite.cn:25582/paas-web"
LOGIN_URL = "http://js1.blockelite.cn:25582/"

# 登录换 token 时使用的固定参数
CLIENT_ID = "be2030fc2aa0416d8c9dcaa5081fb1ad"
SYSTEM_ID = "1"

# 集群
CLUSTER_NAME = "portal-cluster"

# 本地缓存文件
ROOT_DIR = os.path.join(os.path.dirname(__file__), "..")
TOKEN_FILE = os.path.join(ROOT_DIR, "token.json")
CONTEXT_FILE = os.path.join(ROOT_DIR, "context.json")
