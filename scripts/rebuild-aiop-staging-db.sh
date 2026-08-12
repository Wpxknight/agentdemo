#!/usr/bin/env bash
set -euo pipefail

namespace=${AIOP_NAMESPACE:-aios-system}
kubeconfig=${AIOP_KUBECONFIG:-/home/lb/.kube/config-10.241.0.166}
mode=${DB_REBUILD_MODE:-}
backup_dir=${AIOP_BACKUP_DIR:?AIOP_BACKUP_DIR is required}
ssh_host=${AIOP_MARIADB_SSH_HOST:-root@10.241.0.166}
mariadb_container=${AIOP_MARIADB_CONTAINER:-mariadb-galera-master-166}
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
dist_dir="$repo_root/dist"
db_dir="$backup_dir/db"
backup_marker="$db_dir/settings-backup.complete"
tenant_settings_backup="$db_dir/tenant-settings.tsv"
setting_secrets_backup="$db_dir/setting-secrets.tsv"
baseline_file="$repo_root/src/db/migrations/0001_baseline.sql"
kubectl_cmd=(kubectl --kubeconfig "$kubeconfig" -n "$namespace")

umask 077
block_before_write() {
  printf 'BLOCKED: %s; no database write was performed\n' "$1" >&2
  exit 2
}

if [[ "$mode" != 'initialize-in-place' ]]; then
  block_before_write 'DB_REBUILD_MODE=initialize-in-place is required'
fi
if [[ -L "$backup_dir" || ! -d "$backup_dir" ]]; then
  block_before_write 'backup directory must be a real directory'
fi
backup_dir=$(cd "$backup_dir" && pwd -P)
db_dir="$backup_dir/db"
backup_marker="$db_dir/settings-backup.complete"
tenant_settings_backup="$db_dir/tenant-settings.tsv"
setting_secrets_backup="$db_dir/setting-secrets.tsv"
case "$backup_dir/" in
  "$dist_dir"/*) ;;
  *) block_before_write 'backup directory must be inside the repository dist directory' ;;
esac
if [[ -L "$db_dir" || ! -d "$db_dir" ]]; then
  block_before_write 'database backup directory must be a real directory'
fi
for artifact in "$backup_marker" "$tenant_settings_backup" "$setting_secrets_backup"; do
  if [[ -L "$artifact" || ! -f "$artifact" ]]; then
    block_before_write 'required protected backup artifact is missing or invalid'
  fi
  if [[ "$(stat -c '%a' "$artifact")" != '600' ]]; then
    block_before_write 'protected backup artifact permissions must be 600'
  fi
done

marker_value() {
  local key=$1
  local value
  value=$(grep -E "^${key}=" "$backup_marker" || true)
  if [[ -z "$value" || "$value" == *$'\n'* ]]; then
    block_before_write "backup marker field $key is missing or duplicated"
  fi
  printf '%s' "${value#*=}"
}

if [[ "$(marker_value database)" != 'aiop' ]]; then
  block_before_write 'backup marker does not target exact database aiop'
fi
expected_tenant_rows=$(marker_value tenant_settings_rows)
expected_tenant_hash=$(marker_value tenant_settings_sha256)
expected_secret_rows=$(marker_value setting_secrets_rows)
expected_secret_hash=$(marker_value setting_secrets_sha256)
if [[ ! "$expected_tenant_rows" =~ ^[0-9]+$ || ! "$expected_secret_rows" =~ ^[0-9]+$ ||
      ! "$expected_tenant_hash" =~ ^[0-9a-f]{64}$ || ! "$expected_secret_hash" =~ ^[0-9a-f]{64}$ ]]; then
  block_before_write 'backup marker row counts or hashes are invalid'
fi
actual_tenant_rows=$(wc -l < "$tenant_settings_backup" | tr -d '[:space:]')
actual_secret_rows=$(wc -l < "$setting_secrets_backup" | tr -d '[:space:]')
if [[ "$actual_tenant_rows" != "$expected_tenant_rows" || "$actual_secret_rows" != "$expected_secret_rows" ]]; then
  block_before_write 'backup row counts do not match the completion marker'
fi
if ! printf '%s  %s\n' "$expected_tenant_hash" "$tenant_settings_backup" | sha256sum --check --status ||
   ! printf '%s  %s\n' "$expected_secret_hash" "$setting_secrets_backup" | sha256sum --check --status; then
  block_before_write 'backup hashes do not match the completion marker'
fi
if [[ "$ssh_host" != 'root@10.241.0.166' || "$mariadb_container" != 'mariadb-galera-master-166' ]]; then
  block_before_write 'configured MariaDB execution target does not match the fixed staging target'
fi

verified_host=${AIOP_VERIFIED_MYSQL_HOST:-}
verified_port=${AIOP_VERIFIED_MYSQL_PORT:-}
verified_database=${AIOP_VERIFIED_MYSQL_DATABASE:-}
if [[ -n "$verified_host" || -n "$verified_port" || -n "$verified_database" ]]; then
  if [[ "$verified_host" != '10.241.0.166' || "$verified_port" != '3306' || "$verified_database" != 'aiop' ]]; then
    block_before_write 'verified database metadata must be exactly 10.241.0.166:3306/aiop'
  fi
  database_host=$verified_host
  database_port=$verified_port
  database=$verified_database
else
  if ! server_env=$("${kubectl_cmd[@]}" exec deploy/aiop-server -c aiop -- sh -ceu '
    test "${MYSQL_DATABASE:-}" = aiop
    printf "%s\n%s\n%s\n" "$MYSQL_HOST" "${MYSQL_PORT:-3306}" "$MYSQL_DATABASE"
  '); then
    block_before_write 'unable to read live AIoP database metadata'
  fi
  mapfile -t database_env <<< "$server_env"
  database_host=${database_env[0]:-}
  database_port=${database_env[1]:-}
  database=${database_env[2]:-}
fi
if [[ "$database" != 'aiop' ]]; then
  block_before_write 'expected exact database aiop'
fi
if [[ "$database_host" != '10.241.0.166' || "$database_port" != '3306' ]]; then
  block_before_write 'live AIoP database endpoint does not match the fixed staging endpoint'
fi
if ! container_identity=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$ssh_host" \
  "docker inspect --type container --format '{{.Name}}' '$mariadb_container'"); then
  block_before_write 'unable to verify MariaDB container identity'
fi
if [[ "$container_identity" != "/$mariadb_container" ]]; then
  block_before_write 'MariaDB container identity verification failed'
fi

remote_query() {
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

remote_import() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$ssh_host" "
    docker exec -i '$mariadb_container' sh -ceu '
      client=\$(command -v mariadb || command -v mysql)
      MYSQL_PWD=\"\$MYSQL_ROOT_PASSWORD\" \"\$client\" --protocol=socket --user=root --database=aiop
    '
  "
}

restore_marker_out="$db_dir/settings-restore.complete"
if [[ -L "$restore_marker_out" || ( -e "$restore_marker_out" && ! -f "$restore_marker_out" ) ]]; then
  block_before_write 'restore completion marker path is unsafe'
fi
rm -f "$restore_marker_out"

if ! existing_tables_output=$(remote_query "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = 'aiop' ORDER BY TABLE_NAME;"); then
  block_before_write 'unable to enumerate tables inside exact database aiop'
fi
existing_tables=()
if [[ -n "$existing_tables_output" ]]; then
  mapfile -t existing_tables <<< "$existing_tables_output"
fi
quoted_tables=()
for table_name in "${existing_tables[@]}"; do
  if [[ ! "$table_name" =~ ^[A-Za-z0-9_]+$ ]]; then
    block_before_write 'aiop table enumeration returned an invalid table name'
  fi
  quoted_tables+=("\`$table_name\`")
done
if (( ${#quoted_tables[@]} > 0 )); then
  table_list=$(IFS=,; printf '%s' "${quoted_tables[*]}")
  cleanup_sql=$(printf 'SET FOREIGN_KEY_CHECKS=0;\nDROP TABLE IF EXISTS %s;\nSET FOREIGN_KEY_CHECKS=1;\n' "$table_list")
  remote_query "$cleanup_sql" >/dev/null
fi

remote_import < "$baseline_file"
remote_query 'CREATE TABLE IF NOT EXISTS schema_migrations (version INT NOT NULL, name VARCHAR(128) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (version)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;' >/dev/null
remote_query 'INSERT INTO schema_migrations (version, name) VALUES (1, "0001_baseline.sql") ON DUPLICATE KEY UPDATE name = VALUES(name);' >/dev/null
expected_baseline_count=$(grep -Ec '^CREATE TABLE `' "$baseline_file")
expected_baseline_count=$((expected_baseline_count + 1))
baseline_count=$(remote_query "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'aiop';")
if [[ "$baseline_count" != "$expected_baseline_count" ]]; then
  printf 'BLOCKED: aiop baseline table verification failed; deployment must not continue\n' >&2
  exit 4
fi

restore_sql=$(mktemp "$db_dir/.settings-restore.sql.XXXXXX")
cleanup_restore_sql() {
  rm -f "$restore_sql"
}
trap cleanup_restore_sql EXIT
chmod 600 "$restore_sql"
node - "$tenant_settings_backup" "$setting_secrets_backup" "$restore_sql" <<'NODE'
const fs = require('fs');
const [tenantPath, secretPath, outputPath] = process.argv.slice(2);
const sqlString = (value) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const parseRows = (path, label) => {
  const text = fs.readFileSync(path, 'utf8');
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n').map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error(`${label} row ${index + 1} has an invalid field count`);
    if (!/^(?:[0-9A-Fa-f]{2})*$/.test(fields[2])) throw new Error(`${label} row ${index + 1} has invalid hex data`);
    return fields;
  });
};
const tenantRows = parseRows(tenantPath, 'tenant_settings');
const secretRows = parseRows(secretPath, 'setting_secrets');
const statements = ['START TRANSACTION;'];
for (const [tenantId, settingKey, hex, createdAt, updatedAt] of tenantRows) {
  statements.push(`INSERT INTO tenant_settings (tenant_id, setting_key, config, created_at, updated_at) VALUES (${sqlString(tenantId)}, ${sqlString(settingKey)}, CONVERT(UNHEX('${hex}') USING utf8mb4), ${sqlString(createdAt)}, ${sqlString(updatedAt)}) ON DUPLICATE KEY UPDATE config = VALUES(config), created_at = VALUES(created_at), updated_at = VALUES(updated_at);`);
}
for (const [tenantId, settingKey, hex, createdAt, updatedAt] of secretRows) {
  statements.push(`INSERT INTO setting_secrets (tenant_id, setting_key, payload, created_at, updated_at) VALUES (${sqlString(tenantId)}, ${sqlString(settingKey)}, CONVERT(UNHEX('${hex}') USING utf8mb4), ${sqlString(createdAt)}, ${sqlString(updatedAt)}) ON DUPLICATE KEY UPDATE payload = VALUES(payload), created_at = VALUES(created_at), updated_at = VALUES(updated_at);`);
}
statements.push('COMMIT;');
fs.writeFileSync(outputPath, `${statements.join('\n')}\n`, { mode: 0o600 });
NODE
remote_import < "$restore_sql"
rm -f "$restore_sql"
trap - EXIT

restored_tenant_out="$db_dir/restored-tenant-settings.tsv"
restored_secret_out="$db_dir/restored-setting-secrets.tsv"
restore_summary_out="$db_dir/settings-restore-summary.txt"
for artifact in "$restored_tenant_out" "$restored_secret_out" "$restore_summary_out" "$restore_marker_out"; do
  if [[ -L "$artifact" || ( -e "$artifact" && ! -f "$artifact" ) ]]; then
    printf 'BLOCKED: restore verification artifact path is unsafe; deployment must not continue\n' >&2
    exit 5
  fi
done
restored_tenant_tmp=$(mktemp "$db_dir/.restored-tenant-settings.tsv.XXXXXX")
restored_secret_tmp=$(mktemp "$db_dir/.restored-setting-secrets.tsv.XXXXXX")
restore_summary_tmp=$(mktemp "$db_dir/.settings-restore-summary.txt.XXXXXX")
restore_marker_tmp=$(mktemp "$db_dir/.settings-restore.complete.XXXXXX")
cleanup_verification() {
  rm -f "$restored_tenant_tmp" "$restored_secret_tmp" "$restore_summary_tmp" "$restore_marker_tmp"
}
trap cleanup_verification EXIT
chmod 600 "$restored_tenant_tmp" "$restored_secret_tmp" "$restore_summary_tmp" "$restore_marker_tmp"
remote_query "SELECT tenant_id, setting_key, HEX(config), created_at, updated_at
FROM tenant_settings
WHERE setting_key IN ('llm.default', 'sandbox.default')
ORDER BY tenant_id, setting_key;" > "$restored_tenant_tmp"
remote_query "SELECT tenant_id, setting_key, HEX(payload), created_at, updated_at
FROM setting_secrets
WHERE setting_key = 'sandbox.default.api_key'
ORDER BY tenant_id, setting_key;" > "$restored_secret_tmp"
restored_tenant_rows=$(wc -l < "$restored_tenant_tmp" | tr -d '[:space:]')
restored_secret_rows=$(wc -l < "$restored_secret_tmp" | tr -d '[:space:]')
restored_tenant_hash=$(sha256sum "$restored_tenant_tmp" | cut -d' ' -f1)
restored_secret_hash=$(sha256sum "$restored_secret_tmp" | cut -d' ' -f1)
{
  printf 'database=aiop\n'
  printf 'tenant_settings_rows=%s\n' "$restored_tenant_rows"
  printf 'tenant_settings_sha256=%s\n' "$restored_tenant_hash"
  printf 'setting_secrets_rows=%s\n' "$restored_secret_rows"
  printf 'setting_secrets_sha256=%s\n' "$restored_secret_hash"
} > "$restore_summary_tmp"
if [[ "$restored_tenant_rows" != "$expected_tenant_rows" || "$restored_secret_rows" != "$expected_secret_rows" ||
      "$restored_tenant_hash" != "$expected_tenant_hash" || "$restored_secret_hash" != "$expected_secret_hash" ]]; then
  mv "$restored_tenant_tmp" "$restored_tenant_out"
  mv "$restored_secret_tmp" "$restored_secret_out"
  mv "$restore_summary_tmp" "$restore_summary_out"
  printf 'BLOCKED: restored settings differ from the protected backup; evidence retained and deployment must not continue\n' >&2
  exit 5
fi
printf 'database=aiop\nverified=true\n' > "$restore_marker_tmp"
mv "$restored_tenant_tmp" "$restored_tenant_out"
mv "$restored_secret_tmp" "$restored_secret_out"
mv "$restore_summary_tmp" "$restore_summary_out"
mv "$restore_marker_tmp" "$restore_marker_out"
trap - EXIT
printf 'initialize_in_place_verified=true database=aiop baseline_table_count=%s settings_restore_verified=true\n' "$baseline_count"
