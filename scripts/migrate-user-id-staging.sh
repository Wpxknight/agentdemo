#!/usr/bin/env bash
set -euo pipefail

: "${CONFIRM_USER_ID_MIGRATION:?Set CONFIRM_USER_ID_MIGRATION to the exact target confirmation}"
: "${USER_ID_MIGRATION_BACKUP:?Set USER_ID_MIGRATION_BACKUP to the verified backup artifact}"
: "${MIGRATION_NAMESPACE:?Set MIGRATION_NAMESPACE explicitly}"
: "${MIGRATION_DEPLOYMENT:?Set MIGRATION_DEPLOYMENT explicitly}"
: "${MIGRATION_EXPECTED_REPLICAS:?Set MIGRATION_EXPECTED_REPLICAS explicitly}"
: "${AIOP_EXPECTED_KUBE_CONTEXT:?Set AIOP_EXPECTED_KUBE_CONTEXT explicitly}"
: "${DEPLOYMENT_MODE:?Set DEPLOYMENT_MODE explicitly}"
: "${AUTH_PROVIDER:?Set AUTH_PROVIDER explicitly}"
: "${MYSQL_HOST:?Set MYSQL_HOST explicitly}"
: "${MYSQL_DATABASE:?Set MYSQL_DATABASE explicitly}"
: "${MYSQL_USER:?Set MYSQL_USER explicitly}"

expected_confirmation="context=$AIOP_EXPECTED_KUBE_CONTEXT namespace=$MIGRATION_NAMESPACE deployment=$MIGRATION_DEPLOYMENT database=$MYSQL_DATABASE"
if [[ "$CONFIRM_USER_ID_MIGRATION" != "$expected_confirmation" ]]; then
  printf 'CONFIRM_USER_ID_MIGRATION must exactly equal: %s\n' "$expected_confirmation" >&2
  exit 1
fi
if [[ ! "$MIGRATION_EXPECTED_REPLICAS" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' 'MIGRATION_EXPECTED_REPLICAS must be a positive integer' >&2
  exit 1
fi
if [[ ! -s "$USER_ID_MIGRATION_BACKUP" || ! -s "$USER_ID_MIGRATION_BACKUP.sha256" ]]; then
  printf '%s\n' 'Backup artifact and .sha256 verification file are required' >&2
  exit 1
fi

kubectl_cmd=("${KUBECTL:-kubectl}")
if [[ -n "${MIGRATION_KUBECONFIG:-}" ]]; then
  kubectl_cmd+=(--kubeconfig "$MIGRATION_KUBECONFIG")
fi
kube() { "${kubectl_cmd[@]}" --context "$AIOP_EXPECTED_KUBE_CONTEXT" -n "$MIGRATION_NAMESPACE" "$@"; }
preflight() {
  DEPLOYMENT_MODE="$DEPLOYMENT_MODE" AUTH_PROVIDER="$AUTH_PROVIDER" npm exec -- tsx scripts/check-user-id-migration.ts
}

restoration_required=0
original_replicas=''
restore() {
  local status=$?
  local restore_status=0
  local current_replicas=''
  trap - EXIT INT TERM
  if [[ "$restoration_required" == 1 ]]; then
    printf '%s\n' 'migration-step:restore'
    if ! current_replicas="$(kube get "deployment/$MIGRATION_DEPLOYMENT" -o jsonpath='{.spec.replicas}')"; then
      printf '%s\n' 'ERROR: failed to read Deployment replicas during restoration' >&2
      restore_status=1
    elif [[ "$current_replicas" != "$original_replicas" ]]; then
      if ! kube scale "deployment/$MIGRATION_DEPLOYMENT" --replicas="$original_replicas"; then
        printf 'ERROR: failed to restore Deployment to %s replicas\n' "$original_replicas" >&2
        restore_status=1
      elif ! kube rollout status "deployment/$MIGRATION_DEPLOYMENT" --timeout="${MIGRATION_ROLLOUT_TIMEOUT:-300s}"; then
        printf '%s\n' 'ERROR: Deployment restoration rollout failed' >&2
        restore_status=1
      fi
    fi
  fi
  if [[ "$status" == 0 && "$restore_status" != 0 ]]; then
    status=$restore_status
  fi
  exit "$status"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

current_context="$("${kubectl_cmd[@]}" config current-context)"
if [[ "$current_context" != "$AIOP_EXPECTED_KUBE_CONTEXT" ]]; then
  printf 'Kubernetes context mismatch: expected %s, found %s\n' "$AIOP_EXPECTED_KUBE_CONTEXT" "$current_context" >&2
  exit 1
fi
deployment_environment="$(kube get "deployment/$MIGRATION_DEPLOYMENT" -o jsonpath='{.metadata.annotations.aiop\.bocloud\.com/environment}')"
deployment_database="$(kube get "deployment/$MIGRATION_DEPLOYMENT" -o jsonpath='{.metadata.annotations.aiop\.bocloud\.com/database}')"
if [[ "$deployment_environment" != staging ]]; then
  printf 'Deployment environment annotation mismatch: expected staging, found %s\n' "$deployment_environment" >&2
  exit 1
fi
if [[ "$deployment_database" != "$MYSQL_DATABASE" ]]; then
  printf 'Deployment database annotation mismatch: expected %s, found %s\n' "$MYSQL_DATABASE" "$deployment_database" >&2
  exit 1
fi

printf '%s\n' 'migration-step:backup'
npm exec -- tsx scripts/verify-backup-checksum.ts "$USER_ID_MIGRATION_BACKUP"

printf '%s\n' 'migration-step:precheck'
preflight
original_replicas="$(kube get "deployment/$MIGRATION_DEPLOYMENT" -o jsonpath='{.spec.replicas}')"
if [[ "$original_replicas" != "$MIGRATION_EXPECTED_REPLICAS" ]]; then
  printf 'Deployment replicas mismatch: expected %s, found %s\n' "$MIGRATION_EXPECTED_REPLICAS" "$original_replicas" >&2
  exit 1
fi
selector="$(kube get "deployment/$MIGRATION_DEPLOYMENT" -o jsonpath='{range $k,$v := .spec.selector.matchLabels}{printf "%s=%s," $k $v}{end}')"
selector="${selector%,}"
[[ -n "$selector" ]] || { printf '%s\n' 'Deployment selector is empty' >&2; exit 1; }

printf '%s\n' 'migration-step:scale0'
restoration_required=1
kube scale "deployment/$MIGRATION_DEPLOYMENT" --replicas=0
kube rollout status "deployment/$MIGRATION_DEPLOYMENT" --timeout="${MIGRATION_ROLLOUT_TIMEOUT:-300s}"

printf '%s\n' 'migration-step:quiesced-check'
if [[ -n "$(kube get pods -l "$selector" -o name)" ]]; then
  printf '%s\n' 'Writer pods still exist after scale-to-zero' >&2
  exit 1
fi
preflight

printf '%s\n' 'migration-step:migrate'
npm exec -- tsx -e "import { readMysqlConfig } from './src/config/mysql.ts'; import { createMysqlPool, runMigrations } from './src/db/index.ts'; const cfg=readMysqlConfig(); if (!cfg) throw new Error('MYSQL_HOST is required'); const pool=createMysqlPool(cfg); await runMigrations(pool); await pool.promise().end();"

printf '%s\n' 'migration-step:postcheck'
preflight
