#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/constants.sh"
source "$SCRIPT_DIR/confirm_env.sh"

# 环境变量优先级: 已有环境变量 > 交互式确认 > 默认值
confirm_env E2B_API_KEY     "$DEFAULT_E2B_API_KEY"     "E2B_API_KEY (API Key)"
confirm_env E2B_API_URL     "$DEFAULT_E2B_API_URL"     "E2B_API_URL (管理侧地址)"
confirm_env E2B_SANDBOX_URL "$DEFAULT_E2B_SANDBOX_URL" "E2B_SANDBOX_URL (数据侧地址)"
confirm_env CUBE_TEMPLATE_ID "$DEFAULT_CUBE_TEMPLATE_ID" "CUBE_TEMPLATE_ID (模板 ID)"

echo "=============================================="
echo "  最终使用的环境变量:"
echo "    E2B_API_KEY     = ${E2B_API_KEY:0:12}..."
echo "    E2B_API_URL     = $E2B_API_URL"
echo "    E2B_SANDBOX_URL = $E2B_SANDBOX_URL"
echo "    CUBE_TEMPLATE_ID = $CUBE_TEMPLATE_ID"
echo "=============================================="
echo ""

check_api_key_valid "$E2B_API_KEY"

RUN_DIR="${E2B_RUN_DIR:-$PWD/$DEFAULT_RUN_DIR_NAME}"
mkdir -p "$RUN_DIR"

python -m venv "$RUN_DIR/venv"
PYTHON="$RUN_DIR/venv/Scripts/python.exe"
"$PYTHON" -m pip install --upgrade pip
"$PYTHON" -m pip install "e2b==${E2B_SDK_VERSION:-$DEFAULT_E2B_SDK_VERSION}"

cp "$SCRIPT_DIR/$CA_CERT_FILE" "$RUN_DIR/$CA_CERT_FILE"
export SSL_CERT_FILE="$RUN_DIR/$CA_CERT_FILE"
cp "$SCRIPT_DIR/$LIFECYCLE_SCRIPT_FILE" "$RUN_DIR/$LIFECYCLE_SCRIPT_FILE"
cp "$SCRIPT_DIR/$AGENT_E2E_SCRIPT_FILE" "$RUN_DIR/$AGENT_E2E_SCRIPT_FILE"

"$PYTHON" "$RUN_DIR/$LIFECYCLE_SCRIPT_FILE" 2>&1 | tee "$RUN_DIR/$LIFECYCLE_LOG_FILE"
"$PYTHON" "$RUN_DIR/$AGENT_E2E_SCRIPT_FILE" 2>&1 | tee "$RUN_DIR/$AGENT_E2E_LOG_FILE"
