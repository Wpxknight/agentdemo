#!/usr/bin/env bash
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

namespace=${AIOP_NAMESPACE:-aios-system}
if [[ "$namespace" != 'aios-system' ]]; then
  printf 'BLOCKED: fresh staging namespace must be exactly aios-system\n' >&2
  exit 2
fi

block_unsafe_backup_path() {
  printf 'BLOCKED: %s\n' "$1" >&2
  exit 2
}

dist_path="$repo_root/dist"
if [[ -L "$dist_path" || ( -e "$dist_path" && ! -d "$dist_path" ) ]]; then
  block_unsafe_backup_path 'repository dist must be a real directory'
fi
umask 077
if [[ ! -d "$dist_path" ]]; then
  mkdir "$dist_path"
fi
if [[ -L "$dist_path" || ! -d "$dist_path" ]]; then
  block_unsafe_backup_path 'repository dist changed during creation'
fi
dist_root=$(realpath "$dist_path")
[[ "$dist_root" == "$dist_path" ]] ||
  block_unsafe_backup_path 'repository dist escaped its canonical path'
chmod 700 "$dist_root"

requested_run_root=${AIOP_BACKUP_DIR:-"$dist_root/aiop-staging-backup/$(date -u +%Y%m%dT%H%M%SZ)-$$"}
case "$requested_run_root" in
  /*) requested_run_root_absolute=$requested_run_root ;;
  *) requested_run_root_absolute="$PWD/$requested_run_root" ;;
esac

reject_symlink_components() {
  local path=$1
  local current=/
  local component
  IFS='/' read -r -a components <<< "${path#/}"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current%/}/$component"
    if [[ -L "$current" ]]; then
      block_unsafe_backup_path 'backup directory contains a symbolic link'
    fi
  done
}

reject_symlink_components "$requested_run_root_absolute"
run_root=$(realpath -m -- "$requested_run_root_absolute")
case "$run_root" in
  "$dist_root"/*) ;;
  *) block_unsafe_backup_path 'backup directory must be under canonical dist' ;;
esac

umask 077
relative_run_root=${run_root#"$dist_root"/}
current_dir=$dist_root
IFS='/' read -r -a run_components <<< "$relative_run_root"
for component in "${run_components[@]}"; do
  [[ -n "$component" && "$component" != '.' && "$component" != '..' ]] ||
    block_unsafe_backup_path 'backup directory has an invalid component'
  current_dir="$current_dir/$component"
  if [[ -L "$current_dir" || ( -e "$current_dir" && ! -d "$current_dir" ) ]]; then
    block_unsafe_backup_path 'backup directory contains a symbolic link or non-directory component'
  fi
  if [[ ! -d "$current_dir" ]]; then
    mkdir "$current_dir"
  fi
  [[ ! -L "$current_dir" && -d "$current_dir" ]] ||
    block_unsafe_backup_path 'backup directory component changed during creation'
  [[ "$(realpath "$current_dir")" == "$current_dir" ]] ||
    block_unsafe_backup_path 'backup directory escaped canonical dist during creation'
done
chmod 700 "$run_root"
export AIOP_BACKUP_DIR="$run_root"

kubeconfig=${AIOP_KUBECONFIG:-/home/lb/.kube/config-10.241.0.166}
kubectl_cmd=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")
image_tag=${IMAGE_TAG:?IMAGE_TAG is required}

cd "$repo_root"
for target in \
  backup-aiop-staging-k8s-settings \
  backup-aiop-staging-db-settings \
  pipeline \
  rebuild-aiop-staging-db \
  deploy-aiop-staging-workload; do
  make -n "$target" IMAGE_TAG="$image_tag" AIOP_BACKUP_DIR="$run_root" >/dev/null
done

printf 'staging target: namespace=%s database=aiop image_tag=%s\n' "$namespace" "$image_tag"
printf 'sequence: Kubernetes settings backup -> registry publish -> endpoint verification -> workload quiesce -> database settings backup -> aiop initialize-in-place restore -> workload-only deployment -> complete Kubernetes data comparison -> smoke\n'
make backup-aiop-staging-k8s-settings AIOP_BACKUP_DIR="$run_root"
make pipeline IMAGE_TAG="$IMAGE_TAG"

if ! server_env=$("${kubectl_cmd[@]}" exec deploy/aiop-server -c aiop -- sh -ceu '
  test "${MYSQL_DATABASE:-}" = aiop
  printf "%s\n%s\n%s\n" "$MYSQL_HOST" "${MYSQL_PORT:-3306}" "$MYSQL_DATABASE"
'); then
  printf 'BLOCKED: unable to read running AIoP database metadata; workload was not changed\n' >&2
  exit 2
fi
mapfile -t database_env <<< "$server_env"
database_host=${database_env[0]:-}
database_port=${database_env[1]:-}
database=${database_env[2]:-}
if [[ "$database_host" != '10.241.0.166' || "$database_port" != '3306' || "$database" != 'aiop' ]]; then
  printf 'BLOCKED: database endpoint does not match the fixed staging endpoint 10.241.0.166:3306/aiop; workload was not changed\n' >&2
  exit 2
fi

selector=$("${kubectl_cmd[@]}" get deployment aiop-server -o go-template='{{range $key, $value := .spec.selector.matchLabels}}{{printf "%s=%s," $key $value}}{{end}}')
selector=${selector%,}
if [[ -z "$selector" ]]; then
  printf 'BLOCKED: deployment/aiop-server has no selector; workload was not changed\n' >&2
  exit 2
fi
"${kubectl_cmd[@]}" scale deployment/aiop-server --replicas=0
workload_quiesced=true
fail_closed_after_quiesce() {
  local status=$?
  if [[ "$status" -ne 0 && "${workload_quiesced:-false}" == 'true' ]]; then
    printf 'BLOCKED: fresh staging workflow failed after quiescing; deployment/aiop-server remains scaled to zero\n' >&2
  fi
  exit "$status"
}
trap fail_closed_after_quiesce ERR
while true; do
  if ! remaining_pods=$("${kubectl_cmd[@]}" get pods -l "$selector" --no-headers); then
    printf 'BLOCKED: unable to verify that AIoP workload pods stopped; workload remains scaled to zero\n' >&2
    exit 3
  fi
  [[ -z "$remaining_pods" ]] && break
  sleep 2
done

verified_endpoint_args=(
  AIOP_VERIFIED_MYSQL_HOST="$database_host"
  AIOP_VERIFIED_MYSQL_PORT="$database_port"
  AIOP_VERIFIED_MYSQL_DATABASE="$database"
)
make backup-aiop-staging-db-settings AIOP_BACKUP_DIR="$run_root" "${verified_endpoint_args[@]}"
make rebuild-aiop-staging-db DB_REBUILD_MODE=initialize-in-place AIOP_BACKUP_DIR="$run_root" "${verified_endpoint_args[@]}"

restore_marker="$run_root/db/settings-restore.complete"
if [[ -L "$restore_marker" || ! -f "$restore_marker" ]] ||
   ! grep -qx 'database=aiop' "$restore_marker" ||
   ! grep -qx 'verified=true' "$restore_marker"; then
  printf 'BLOCKED: verified database settings restore marker is required before workload deployment; evidence retained at %s\n' "$run_root" >&2
  exit 4
fi

make deploy-aiop-staging-workload IMAGE_TAG="$IMAGE_TAG"
workload_quiesced=false
trap - ERR

verify_dir="$run_root/k8s/verify"
if [[ -L "$verify_dir" || ( -e "$verify_dir" && ! -d "$verify_dir" ) ]]; then
  printf 'BLOCKED: Kubernetes verification directory is unsafe; evidence retained at %s\n' "$run_root" >&2
  exit 5
fi
mkdir -p "$verify_dir"
chmod 700 "$verify_dir"

sort_complete_data() {
  local output=$1
  node -e '
const fs = require("fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const resource = JSON.parse(input);
  const data = resource.data ?? {};
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(process.argv[1], JSON.stringify(sorted) + "\n", { mode: 0o600 });
});
' "$output"
}

current_config="$verify_dir/aiop-config.data.json"
current_secrets="$verify_dir/aiop-secrets.data.json"
"${kubectl_cmd[@]}" get configmap aiop-config -o json | sort_complete_data "$current_config"
"${kubectl_cmd[@]}" get secret aiop-secrets -o json | sort_complete_data "$current_secrets"
chmod 600 "$current_config" "$current_secrets"

backup_config="$run_root/k8s/aiop-config.data.json"
backup_secrets="$run_root/k8s/aiop-secrets.data.json"
if [[ ! -f "$backup_config" || ! -f "$backup_secrets" ]]; then
  printf 'BLOCKED: complete Kubernetes data backups are missing; evidence retained at %s\n' "$run_root" >&2
  exit 5
fi
backup_config_hash=$(sha256sum "$backup_config" | cut -d' ' -f1)
backup_secrets_hash=$(sha256sum "$backup_secrets" | cut -d' ' -f1)
current_config_hash=$(sha256sum "$current_config" | cut -d' ' -f1)
current_secrets_hash=$(sha256sum "$current_secrets" | cut -d' ' -f1)
if [[ "$backup_config_hash" != "$current_config_hash" || "$backup_secrets_hash" != "$current_secrets_hash" ]]; then
  printf 'BLOCKED: complete Kubernetes ConfigMap/Secret data hashes differ after deployment; evidence retained at %s\n' "$run_root" >&2
  exit 5
fi

base_url=${AIOP_STAGING_BASE_URL:-http://10.241.0.166:30084}
curl --fail --silent --show-error "$base_url/healthz" | grep -qx '{"ok":true}'
curl --fail --silent --show-error "$base_url/readyz" | grep -qx '{"ok":true}'
"${kubectl_cmd[@]}" rollout status deployment/aiop-server --timeout=300s
"${kubectl_cmd[@]}" get deployment aiop-server -o jsonpath='{.status.readyReplicas}' | grep -qx '1'
{
  printf 'config_sha256=%s\n' "$current_config_hash"
  printf 'secret_sha256=%s\n' "$current_secrets_hash"
  printf 'kubernetes_settings_restore_verified=true\n'
  printf 'deployment_smoke=pass\n'
} > "$verify_dir/verification-summary.txt"
chmod 600 "$verify_dir/verification-summary.txt"
printf 'Staging deployment passed; protected evidence retained at %s\n' "$run_root"
