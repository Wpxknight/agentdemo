#!/bin/bash
# Module: sandbox
# Test: AIOS Sandbox dynamic placement local contract regression
# Author: aios-tester
# Created: 2026-08-13
# Updated: 2026-08-13
# Usage: bash .test-scripts/sandbox/dynamic_placement_local.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EVIDENCE_DIR="$PROJECT_ROOT/dist/aios-team/dynamic-sandbox-placement/local"
LOG_FILE="$EVIDENCE_DIR/dynamic-placement-local.log"
PASS_COUNT=0
FAIL_COUNT=0

mkdir -p "$EVIDENCE_DIR"
: > "$LOG_FILE"

run_case() {
  local case_id="$1"
  local description="$2"
  shift 2

  if "$@" >> "$LOG_FILE" 2>&1; then
    echo "[PASS] $case_id - $description"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[FAIL] $case_id - $description (see $LOG_FILE)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

cd "$PROJECT_ROOT" || exit 1

run_case "TC001" "dynamic placement focused Vitest suites pass" \
  npm exec -- vitest run \
    tests/aios-e2b.test.ts \
    tests/sandbox-placement.test.ts \
    tests/sandbox-settings.test.ts \
    tests/sandbox.test.ts \
    tests/http.test.ts \
    tests/runtime-sandbox-controller.test.ts

run_case "TC002" "TypeScript typecheck passes" npm run typecheck
run_case "TC003" "Web production build passes" npm --prefix web run build

echo "=== Result: $PASS_COUNT PASS, $FAIL_COUNT FAIL ==="
echo "Evidence: $LOG_FILE"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
