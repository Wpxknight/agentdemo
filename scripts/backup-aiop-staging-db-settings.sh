#!/usr/bin/env bash
set -euo pipefail

namespace=${AIOP_NAMESPACE:-aios-system}
kubeconfig=${AIOP_KUBECONFIG:-/home/lb/.kube/config-10.241.0.166}
backup_dir=${AIOP_BACKUP_DIR:?AIOP_BACKUP_DIR is required}
ssh_host=${AIOP_MARIADB_SSH_HOST:-root@10.241.0.166}
mariadb_container=${AIOP_MARIADB_CONTAINER:-mariadb-galera-master-166}
db_dir="$backup_dir/db"
kubectl_cmd=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")

umask 077
if [[ -L "$backup_dir" || ( -e "$backup_dir" && ! -d "$backup_dir" ) ]]; then
  printf 'BLOCKED: backup directory must be a real directory, not a symlink; no database operation was performed\n' >&2
  exit 2
fi
mkdir -p "$backup_dir"
if [[ -L "$db_dir" || ( -e "$db_dir" && ! -d "$db_dir" ) ]]; then
  printf 'BLOCKED: database backup directory must be a real directory, not a symlink; no database operation was performed\n' >&2
  exit 2
fi
mkdir -p "$db_dir"
chmod 700 "$backup_dir" "$db_dir"

verified_host=${AIOP_VERIFIED_MYSQL_HOST:-}
verified_port=${AIOP_VERIFIED_MYSQL_PORT:-}
verified_database=${AIOP_VERIFIED_MYSQL_DATABASE:-}
if [[ -n "$verified_host" || -n "$verified_port" || -n "$verified_database" ]]; then
  if [[ "$verified_host" != '10.241.0.166' || "$verified_port" != '3306' || "$verified_database" != 'aiop' ]]; then
    printf 'BLOCKED: verified database metadata must be exactly 10.241.0.166:3306/aiop; no database operation was performed\n' >&2
    exit 2
  fi
  database_host=$verified_host
  database_port=$verified_port
  database=$verified_database
else
  server_env=$("${kubectl_cmd[@]}" exec deploy/aiop-server -c aiop -- sh -ceu '
    printf "%s\n%s\n%s\n" "$MYSQL_HOST" "${MYSQL_PORT:-3306}" "$MYSQL_DATABASE"
  ')
  mapfile -t database_env <<< "$server_env"
  database_host=${database_env[0]:-}
  database_port=${database_env[1]:-}
  database=${database_env[2]:-}
fi

if [[ -z "$database_host" || -z "$database_port" ]]; then
  printf 'BLOCKED: AIoP database connection metadata is incomplete; no database operation was performed\n' >&2
  exit 2
fi
if [[ "$database" != 'aiop' ]]; then
  printf 'BLOCKED: expected exact database aiop; no database operation was performed\n' >&2
  exit 2
fi
if [[ "$database_host" != '10.241.0.166' || "$database_port" != '3306' ]]; then
  printf 'BLOCKED: live AIoP database endpoint does not match the fixed staging endpoint; no database operation was performed\n' >&2
  exit 2
fi
if [[ "$ssh_host" != 'root@10.241.0.166' || "$mariadb_container" != 'mariadb-galera-master-166' ]]; then
  printf 'BLOCKED: configured MariaDB execution target does not match the fixed staging target; no database operation was performed\n' >&2
  exit 2
fi
container_identity=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$ssh_host" \
  "docker inspect --type container --format '{{.Name}}' '$mariadb_container'")
if [[ "$container_identity" != "/$mariadb_container" ]]; then
  printf 'BLOCKED: MariaDB container identity verification failed; no database operation was performed\n' >&2
  exit 2
fi

remote_select() {
  local encoded_query
  encoded_query=$(printf '%s' "$1" | base64 -w0)
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$ssh_host" "
    docker exec -e AIOP_QUERY_B64='$encoded_query' '$mariadb_container' sh -ceu '
      client=\$(command -v mariadb || command -v mysql)
      query=\$(printf %s \"\$AIOP_QUERY_B64\" | base64 -d)
      MYSQL_PWD=\"\$MYSQL_ROOT_PASSWORD\" \"\$client\" --protocol=socket --user=root --database=aiop --batch --skip-column-names --raw --execute=\"\$query\"
    '
  "
}

tenant_settings_out="$db_dir/tenant-settings.tsv"
setting_secrets_out="$db_dir/setting-secrets.tsv"
summary_out="$db_dir/db-settings-summary.txt"
marker_out="$db_dir/settings-backup.complete"
for artifact in "$tenant_settings_out" "$setting_secrets_out" "$summary_out" "$marker_out"; do
  if [[ -L "$artifact" || ( -e "$artifact" && ! -f "$artifact" ) ]]; then
    printf 'BLOCKED: database backup artifact path is a symlink or non-regular file; no database operation was performed\n' >&2
    exit 2
  fi
done

tenant_settings_tmp=$(mktemp "$db_dir/.tenant-settings.tsv.XXXXXX")
setting_secrets_tmp=$(mktemp "$db_dir/.setting-secrets.tsv.XXXXXX")
summary_tmp=$(mktemp "$db_dir/.db-settings-summary.txt.XXXXXX")
marker_tmp=$(mktemp "$db_dir/.settings-backup.complete.XXXXXX")
cleanup() {
  rm -f "$tenant_settings_tmp" "$setting_secrets_tmp" "$summary_tmp" "$marker_tmp"
}
trap cleanup EXIT
chmod 600 "$tenant_settings_tmp" "$setting_secrets_tmp" "$summary_tmp" "$marker_tmp"

remote_select "SELECT tenant_id, setting_key, HEX(config), created_at, updated_at
FROM tenant_settings
WHERE setting_key IN ('llm.default', 'sandbox.default')
ORDER BY tenant_id, setting_key;" > "$tenant_settings_tmp"
remote_select "SELECT tenant_id, setting_key, HEX(payload), created_at, updated_at
FROM setting_secrets
WHERE setting_key = 'sandbox.default.api_key'
ORDER BY tenant_id, setting_key;" > "$setting_secrets_tmp"

tenant_settings_rows=$(wc -l < "$tenant_settings_tmp" | tr -d '[:space:]')
setting_secrets_rows=$(wc -l < "$setting_secrets_tmp" | tr -d '[:space:]')
tenant_settings_sha256=$(sha256sum "$tenant_settings_tmp" | cut -d' ' -f1)
setting_secrets_sha256=$(sha256sum "$setting_secrets_tmp" | cut -d' ' -f1)
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

{
  printf 'database=aiop\n'
  printf 'tenant_settings_rows=%s\n' "$tenant_settings_rows"
  printf 'tenant_settings_sha256=%s\n' "$tenant_settings_sha256"
  printf 'setting_secrets_rows=%s\n' "$setting_secrets_rows"
  printf 'setting_secrets_sha256=%s\n' "$setting_secrets_sha256"
  printf 'timestamp=%s\n' "$timestamp"
} > "$summary_tmp"

printf '%s  %s\n' "$tenant_settings_sha256" "$tenant_settings_tmp" | sha256sum --check --status
printf '%s  %s\n' "$setting_secrets_sha256" "$setting_secrets_tmp" | sha256sum --check --status
cp "$summary_tmp" "$marker_tmp"
chmod 600 "$marker_tmp"
mv "$tenant_settings_tmp" "$tenant_settings_out"
mv "$setting_secrets_tmp" "$setting_secrets_out"
mv "$summary_tmp" "$summary_out"
mv "$marker_tmp" "$marker_out"

printf 'Database settings backup verified at %s (database=aiop, values omitted)\n' "$db_dir"
