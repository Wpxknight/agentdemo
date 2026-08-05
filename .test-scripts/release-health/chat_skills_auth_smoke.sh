#!/bin/bash
# Module: release-health
# Test: Chat 与 Skills 页面认证前置冒烟
# Author: aios-tester
# Created: 2026-08-03
# Updated: 2026-08-03
# Usage: bash .test-scripts/release-health/chat_skills_auth_smoke.sh [BASE_URL]

set -uo pipefail

BASE_URL="${1:-http://192.168.10.108:30083}"
TENANT_ID="default"
USERNAME="admin"
PASSWORD="admin-pass"
PASS=0
FAIL=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() {
  printf '[PASS] %s\n' "$1"
  PASS=$((PASS + 1))
}

fail() {
  printf '[FAIL] %s\n' "$1"
  FAIL=$((FAIL + 1))
}

health_code="$(curl -sS -o "$TMP_DIR/health.json" -w '%{http_code}' "$BASE_URL/healthz" || true)"
if [[ "$health_code" == "200" ]] && grep -q '"ok"[[:space:]]*:[[:space:]]*true' "$TMP_DIR/health.json"; then
  pass 'TC001 - healthz 返回 200 和 ok=true'
else
  fail "TC001 - healthz 异常: HTTP $health_code"
fi

login_code="$(curl -sS -o "$TMP_DIR/login.json" -w '%{http_code}' \
  -H 'content-type: application/json' -X POST "$BASE_URL/auth/login" \
  --data "{\"tenantId\":\"$TENANT_ID\",\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" || true)"
TOKEN="$(python -c 'import json,sys; print(json.load(open(sys.argv[1])).get("token", ""))' "$TMP_DIR/login.json" 2>/dev/null || true)"
if [[ "$login_code" == "200" && -n "$TOKEN" ]]; then
  pass 'TC002 - 测试管理员登录并取得 JWT'
else
  fail "TC002 - 测试管理员登录失败: HTTP $login_code"
fi

for endpoint in '/v1/sessions' '/v1/tools'; do
  code="$(curl -sS -o "$TMP_DIR/$(basename "$endpoint").json" -w '%{http_code}' \
    -H "authorization: Bearer $TOKEN" "$BASE_URL$endpoint" || true)"
  if [[ "$login_code" == "200" && "$code" == "200" ]]; then
    pass "TC003 - 已认证访问 $endpoint"
  else
    fail "TC003 - 已认证访问 $endpoint 异常: HTTP $code"
  fi
done

printf '=== Result: %d PASS, %d FAIL ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
