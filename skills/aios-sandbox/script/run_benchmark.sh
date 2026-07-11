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

if [ -x "$RUN_DIR/venv/Scripts/python.exe" ]; then
  PYTHON="$RUN_DIR/venv/Scripts/python.exe"
elif [ -x "$RUN_DIR/venv/bin/python" ]; then
  PYTHON="$RUN_DIR/venv/bin/python"
else
  if command -v python >/dev/null 2>&1; then
    python -m venv "$RUN_DIR/venv"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m venv "$RUN_DIR/venv"
  else
    echo "python/python3 not found"
    exit 1
  fi
  if [ -x "$RUN_DIR/venv/Scripts/python.exe" ]; then
    PYTHON="$RUN_DIR/venv/Scripts/python.exe"
  else
    PYTHON="$RUN_DIR/venv/bin/python"
  fi
fi

"$PYTHON" -m pip install "e2b==${E2B_SDK_VERSION:-$DEFAULT_E2B_SDK_VERSION}"

cp "$SCRIPT_DIR/$CA_CERT_FILE" "$RUN_DIR/$CA_CERT_FILE"
export SSL_CERT_FILE="$RUN_DIR/$CA_CERT_FILE"
export E2B_BENCH_ITERATIONS="${E2B_BENCH_ITERATIONS:-$DEFAULT_E2B_BENCH_ITERATIONS}"
export E2B_BENCH_CONCURRENCY="${E2B_BENCH_CONCURRENCY:-$DEFAULT_E2B_BENCH_CONCURRENCY}"
export E2B_BENCH_MAX_CONCURRENCY="${E2B_BENCH_MAX_CONCURRENCY:-$DEFAULT_E2B_BENCH_MAX_CONCURRENCY}"
export E2B_BENCH_WARMUP="${E2B_BENCH_WARMUP:-$DEFAULT_E2B_BENCH_WARMUP}"
export E2B_BENCH_READY_ATTEMPTS="${E2B_BENCH_READY_ATTEMPTS:-$DEFAULT_E2B_BENCH_READY_ATTEMPTS}"
export E2B_BENCH_READY_INTERVAL_SECONDS="${E2B_BENCH_READY_INTERVAL_SECONDS:-$DEFAULT_E2B_BENCH_READY_INTERVAL_SECONDS}"
export E2B_BENCH_COMMAND="${E2B_BENCH_COMMAND:-$DEFAULT_E2B_BENCH_COMMAND}"
export E2B_BENCH_RUN_DIR="$RUN_DIR"

cp "$SCRIPT_DIR/$BENCHMARK_SCRIPT_FILE" "$RUN_DIR/$BENCHMARK_SCRIPT_FILE"
"$PYTHON" "$RUN_DIR/$BENCHMARK_SCRIPT_FILE" 2>&1 | tee "$RUN_DIR/$BENCHMARK_LOG_FILE"
