#!/usr/bin/env bash
set -euo pipefail

namespace=${AIOP_NAMESPACE:-aios-system}
kubeconfig=${AIOP_KUBECONFIG:-/home/lb/.kube/config-10.241.0.166}
backup_dir=${AIOP_BACKUP_DIR:-"$(pwd)/dist/aiop-staging-backup/manual"}
k8s_dir="$backup_dir/k8s"
kubectl_cmd=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")

umask 077
mkdir -p "$k8s_dir"
chmod 700 "$backup_dir" "$k8s_dir"

config_raw="$k8s_dir/aiop-config.raw.json"
secrets_raw="$k8s_dir/aiop-secrets.raw.json"
config_out="$k8s_dir/aiop-config.data.json"
secrets_out="$k8s_dir/aiop-secrets.data.json"
summary="$k8s_dir/aiop-settings-summary.txt"

"${kubectl_cmd[@]}" get configmap aiop-config -o json > "$config_raw"
"${kubectl_cmd[@]}" get secret aiop-secrets -o json > "$secrets_raw"

node -e '
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const data = input.data ?? {};
const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(process.argv[2], JSON.stringify(sorted) + "\n", { mode: 0o600 });
' "$config_raw" "$config_out"

node -e '
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const data = input.data ?? {};
const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(process.argv[2], JSON.stringify(sorted) + "\n", { mode: 0o600 });
' "$secrets_raw" "$secrets_out"

chmod 600 "$config_out" "$secrets_out"
rm -f "$config_raw" "$secrets_raw"

config_key_count=$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))).length)' "$config_out")
secret_key_count=$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))).length)' "$secrets_out")

if [[ "$config_key_count" -eq 0 ]] || [[ "$secret_key_count" -eq 0 ]]; then
  printf 'BLOCKED: Kubernetes ConfigMap/Secret backup is incomplete\n' >&2
  exit 2
fi

{
  printf 'config_key_count=%s\n' "$config_key_count"
  printf 'secret_key_count=%s\n' "$secret_key_count"
  printf 'config_sha256=%s\n' "$(sha256sum "$config_out" | cut -d' ' -f1)"
  printf 'secret_sha256=%s\n' "$(sha256sum "$secrets_out" | cut -d' ' -f1)"
} > "$summary"
chmod 600 "$summary"
printf 'Kubernetes settings backup verified at %s\n' "$k8s_dir"
