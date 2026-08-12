#!/usr/bin/env bash
# Module: scheduler
# Test: Scheduler W4 staging HTTP/MySQL-contract regression
# Author: aios-tester
# Created: 2026-08-06
# Updated: 2026-08-06
# Usage: bash .test-scripts/scheduler/w4_staging_regression.sh [BASE_URL]
#
# This script only creates and deletes a uniquely named QA scheduled task under
# the authenticated test account. It never alters model or sandbox settings.

set -euo pipefail

BASE_URL="${1:-http://10.241.0.166:30084}"
EVIDENCE_DIR="/opt/develop/aicoding/aiop/dist/test-evidence/scheduler/w4"
mkdir -p "$EVIDENCE_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$EVIDENCE_DIR/http-regression-$STAMP.log"
QA_ID="qa-scheduler-w4-${STAMP}-$RANDOM"
QA_TENANT="${QA_TENANT:-default}"
QA_USERNAME="${QA_USERNAME:-admin}"
QA_PASSWORD="${QA_PASSWORD:-admin-pass}"
PASS=0
FAIL=0
TASK_ID=""
TOKEN=""

cleanup() {
  if [[ -n "$TASK_ID" && -n "$TOKEN" ]]; then
    curl -sS --max-time 15 -X DELETE "$BASE_URL/v1/schedule/$TASK_ID" \
      -H "authorization: Bearer $TOKEN" >>"$OUT" 2>&1 || true
  fi
}
trap cleanup EXIT

record() {
  local got="$1" expected="$2" id="$3" detail="$4"
  if [[ "$got" == "$expected" ]]; then
    printf '[PASS] %s - %s\n' "$id" "$detail" | tee -a "$OUT"
    PASS=$((PASS + 1))
  else
    printf '[FAIL] %s - %s (expected HTTP %s, got %s)\n' "$id" "$detail" "$expected" "$got" | tee -a "$OUT"
    FAIL=$((FAIL + 1))
  fi
}
request() {
  local method="$1" path="$2" data="${3:-}" extra="${4:-}"
  local -a args=(-sS --max-time 20 -w '\n%{http_code}' -X "$method" "$BASE_URL$path")
  [[ -n "$TOKEN" ]] && args+=(-H "authorization: Bearer $TOKEN")
  [[ -n "$extra" ]] && args+=(-H "$extra")
  if [[ -n "$data" ]]; then
    args+=(-H 'content-type: application/json' --data "$data")
  fi
  curl "${args[@]}"
}
status_of() { printf '%s' "$1" | tail -n 1; }
body_of() { printf '%s' "$1" | head -n -1; }

printf 'Scheduler W4 regression: %s\n' "$BASE_URL" | tee "$OUT"
health=$(curl -sS --max-time 10 -w '\n%{http_code}' "$BASE_URL/healthz")
record "$(status_of "$health")" 200 TC001 'health endpoint is available'
unauth=$(request GET /v1/schedule)
record "$(status_of "$unauth")" 401 TC002 'schedule list rejects unauthenticated access'

# QA credentials may be passed as process variables and are never logged.
login=$(curl -sS --max-time 15 -w '\n%{http_code}' -X POST "$BASE_URL/auth/login" -H 'content-type: application/json' --data "{\"tenantId\":\"$QA_TENANT\",\"username\":\"$QA_USERNAME\",\"password\":\"$QA_PASSWORD\"}")
record "$(status_of "$login")" 200 TC003 'scheduler QA account can authenticate'
if [[ "$(status_of "$login")" != 200 ]]; then
  printf '=== Result: %s PASS, %s FAIL ===\n' "$PASS" "$FAIL" | tee -a "$OUT"
  exit 1
fi
TOKEN=$(body_of "$login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

invalid=$(request POST /v1/schedule '{"cron":"not-a-cron","task":"qa invalid cron"}')
record "$(status_of "$invalid")" 400 TC004 'invalid cron is rejected before persistence'
invalid_tz=$(request POST /v1/schedule '{"cron":"0 2 * * *","timezone":"Not/A_Zone","task":"qa invalid timezone"}')
record "$(status_of "$invalid_tz")" 400 TC005 'invalid IANA timezone is rejected'

created=$(request POST /v1/schedule "{\"title\":\"$QA_ID\",\"task\":\"$QA_ID contract validation only\",\"cron\":\"*/5 * * * *\",\"timezone\":\"America/New_York\"}")
record "$(status_of "$created")" 201 TC006 'create a QA scheduled task with IANA timezone'
if [[ "$(status_of "$created")" == 201 ]]; then
  TASK_ID=$(body_of "$created" | python3 -c 'import json,sys; x=json.load(sys.stdin)["task"]; assert x["timezone"]=="America/New_York"; print(x["id"])')
else
  printf '=== Result: %s PASS, %s FAIL ===\n' "$PASS" "$FAIL" | tee -a "$OUT"
  exit 1
fi

listed=$(request GET /v1/schedule)
if body_of "$listed" | python3 -c "import json,sys; assert any(x['id']==$TASK_ID for x in json.load(sys.stdin)['tasks'])"; then record "$(status_of "$listed")" 200 TC007 'created task appears in scoped list'; else record 0 200 TC007 'created task appears in scoped list'; fi
badpatch=$(request PATCH "/v1/schedule/$TASK_ID" '{"cron":"bad cron"}')
record "$(status_of "$badpatch")" 400 TC008 'PATCH rejects invalid cron'
updated=$(request PATCH "/v1/schedule/$TASK_ID" "{\"cron\":\"0 2 * * *\",\"timezone\":\"Asia/Shanghai\",\"task\":\"$QA_ID patched\"}")
record "$(status_of "$updated")" 200 TC009 'PATCH recomputes a valid time-zoned task'
disable=$(request POST "/v1/schedule/$TASK_ID/disable")
record "$(status_of "$disable")" 200 TC010 'disable task'
enable=$(request POST "/v1/schedule/$TASK_ID/enable")
record "$(status_of "$enable")" 200 TC011 'enable task'
missing_toggle=$(request POST /v1/schedule/999999999/disable)
record "$(status_of "$missing_toggle")" 404 TC012 'missing task enable-disable returns 404'
missing_key=$(request POST "/v1/schedule/$TASK_ID/run")
record "$(status_of "$missing_key")" 400 TC013 'manual run requires Idempotency-Key'

KEY="$QA_ID-manual"
manual1=$(request POST "/v1/schedule/$TASK_ID/run" '' "Idempotency-Key: $KEY")
record "$(status_of "$manual1")" 202 TC014 'manual Fire is persisted'
manual2=$(request POST "/v1/schedule/$TASK_ID/run" '' "Idempotency-Key: $KEY")
record "$(status_of "$manual2")" 202 TC015 'same idempotency key replays manual Fire'
if body_of "$manual1" | python3 -c "import json,sys; a=json.load(sys.stdin); assert a['replayed'] is False and a['taskId']==$TASK_ID" && body_of "$manual2" | python3 -c "import json,sys; b=json.load(sys.stdin); assert b['replayed'] is True"; then
  record 202 202 TC016 'manual Fire response records initial/replayed semantics'
else
  record 0 202 TC016 'manual Fire response records initial/replayed semantics'
fi
sleep 3
history=$(request GET "/v1/schedule/$TASK_ID/runs")
if body_of "$history" | python3 -c 'import json,sys; r=json.load(sys.stdin)["runs"]; assert any(x["triggerKind"]=="manual" for x in r)'; then record "$(status_of "$history")" 200 TC017 'Fire-first execution history exposes manual fire'; else record 0 200 TC017 'Fire-first execution history exposes manual fire'; fi
missing_run=$(request POST /v1/schedule/999999999/run '' "Idempotency-Key: $KEY")
record "$(status_of "$missing_run")" 404 TC018 'manual run for nonexistent task returns 404'

# Verify soft deletion through public contract; trap repeats safely on failure.
deleted=$(request DELETE "/v1/schedule/$TASK_ID")
record "$(status_of "$deleted")" 200 TC019 'delete QA task'
if [[ "$(status_of "$deleted")" == 200 ]]; then
  after=$(request GET "/v1/schedule/$TASK_ID/runs")
  record "$(status_of "$after")" 200 TC020 'execution history remains available after soft delete'
  TASK_ID=""
fi
printf '=== Result: %s PASS, %s FAIL ===\n' "$PASS" "$FAIL" | tee -a "$OUT"
[[ "$FAIL" -eq 0 ]]
