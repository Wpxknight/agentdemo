#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p dist/test-tmp
tmp_dir="$(mktemp -d dist/test-tmp/staging-deploy-contract.XXXXXX)"
trap 'rm -rf "$tmp_dir"' EXIT

grep -q 'get configmap aiop-config -o json' scripts/backup-aiop-k8s-settings.sh
grep -q 'get secret aiop-secrets -o json' scripts/backup-aiop-k8s-settings.sh
! grep -q 'OPENAI_API_KEY' scripts/backup-aiop-k8s-settings.sh

db_backup_script=scripts/backup-aiop-staging-db-settings.sh

grep -q '^backup-aiop-staging-db-settings:' Makefile
grep -q 'AIOP_BACKUP_DIR=$(AIOP_BACKUP_DIR).*AIOP_VERIFIED_MYSQL_HOST=$(AIOP_VERIFIED_MYSQL_HOST).*AIOP_VERIFIED_MYSQL_PORT=$(AIOP_VERIFIED_MYSQL_PORT).*AIOP_VERIFIED_MYSQL_DATABASE=$(AIOP_VERIFIED_MYSQL_DATABASE).*./scripts/backup-aiop-staging-db-settings.sh' Makefile
grep -q "database=aiop" scripts/rebuild-aiop-staging-db.sh
! grep -Eq 'SHOW[[:space:]]+DATABASES|DROP[[:space:]]+DATABASE' scripts/*.sh
! grep -Eq 'information_schema[.]schemata' "$db_backup_script"
! grep -Eq 'database=\$\{|--database="?\$' scripts/rebuild-aiop-staging-db.sh "$db_backup_script"
grep -q "test .*MYSQL_DATABASE.*aiop" scripts/rebuild-aiop-staging-db.sh
grep -Fq "if [[ \"\$database\" != 'aiop' ]]; then" "$db_backup_script"
grep -Fq 'BLOCKED: expected exact database aiop; no database operation was performed' "$db_backup_script"
grep -q -- '--database=aiop' "$db_backup_script"
! grep -q 'AIOP_EXPECTED_MYSQL_HOST' "$db_backup_script"
! grep -q 'AIOP_EXPECTED_MYSQL_PORT' "$db_backup_script"
grep -Fq 'if [[ "$database_host" != '\''10.241.0.166'\'' || "$database_port" != '\''3306'\'' ]]; then' "$db_backup_script"
grep -Fq 'docker inspect --type container --format' "$db_backup_script"
grep -Fq 'if [[ "$ssh_host" != '\''root@10.241.0.166'\'' || "$mariadb_container" != '\''mariadb-galera-master-166'\'' ]]; then' "$db_backup_script"
grep -Fq 'if [[ "$container_identity" != "/$mariadb_container" ]]; then' "$db_backup_script"
host_guard_line=$(grep -nF 'if [[ "$database_host" != '\''10.241.0.166'\'' || "$database_port" != '\''3306'\'' ]]; then' "$db_backup_script" | cut -d: -f1)
container_guard_line=$(grep -nF 'if [[ "$container_identity" != "/$mariadb_container" ]]; then' "$db_backup_script" | cut -d: -f1)
first_client_line=$(grep -nF 'MYSQL_PWD=' "$db_backup_script" | cut -d: -f1)
[[ "$host_guard_line" -lt "$first_client_line" && "$container_guard_line" -lt "$first_client_line" ]]
grep -Fq '[[ -L "$backup_dir" || ( -e "$backup_dir" && ! -d "$backup_dir" ) ]]' "$db_backup_script"
grep -Fq '[[ -L "$db_dir" || ( -e "$db_dir" && ! -d "$db_dir" ) ]]' "$db_backup_script"
grep -Fq 'mktemp "$db_dir/.tenant-settings.tsv.XXXXXX"' "$db_backup_script"
grep -Fq 'mktemp "$db_dir/.setting-secrets.tsv.XXXXXX"' "$db_backup_script"
grep -Fq 'mktemp "$db_dir/.db-settings-summary.txt.XXXXXX"' "$db_backup_script"
grep -Fq 'mktemp "$db_dir/.settings-backup.complete.XXXXXX"' "$db_backup_script"
grep -Fq "SELECT tenant_id, setting_key, HEX(config), created_at, updated_at" "$db_backup_script"
grep -Fq "WHERE setting_key IN ('llm.default', 'sandbox.default')" "$db_backup_script"
grep -Fq "SELECT tenant_id, setting_key, HEX(payload), created_at, updated_at" "$db_backup_script"
grep -Fq "WHERE setting_key = 'sandbox.default.api_key'" "$db_backup_script"
grep -q 'db-settings-summary.txt' "$db_backup_script"
grep -q 'settings-backup.complete' "$db_backup_script"
grep -Eq 'chmod 600 .*tenant.*setting.*secret|chmod 600 .*\.tsv' "$db_backup_script"
grep -Fq 'mv "$marker_tmp" "$marker_out"' "$db_backup_script"
rebuild_script=scripts/rebuild-aiop-staging-db.sh
grep -q 'settings-backup.complete' "$rebuild_script"
! grep -Eq 'DROP[[:space:]]+DATABASE|CREATE[[:space:]]+DATABASE|SHOW[[:space:]]+DATABASES' "$rebuild_script"
grep -q -- '--database=aiop' "$rebuild_script"
grep -Fq "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = 'aiop' ORDER BY TABLE_NAME;" "$rebuild_script"
grep -Fq 'DB_REBUILD_MODE=initialize-in-place is required' "$rebuild_script"
grep -Fq 'backup directory must be inside the repository dist directory' "$rebuild_script"
grep -Fq 'no database write was performed' "$rebuild_script"
grep -Fq 'sha256sum --check --status' "$rebuild_script"
grep -Fq 'DROP TABLE IF EXISTS' "$rebuild_script"
grep -Fq 'SET FOREIGN_KEY_CHECKS=0;' "$rebuild_script"
grep -Fq 'SET FOREIGN_KEY_CHECKS=1;' "$rebuild_script"
grep -Fq 'START TRANSACTION;' "$rebuild_script"
grep -Fq "CONVERT(UNHEX('" "$rebuild_script"
grep -Fq 'COMMIT;' "$rebuild_script"
grep -Fq 'settings-restore-summary.txt' "$rebuild_script"
grep -Fq 'settings-restore.complete' "$rebuild_script"
grep -Fq "SELECT tenant_id, setting_key, HEX(config), created_at, updated_at" "$rebuild_script"
grep -Fq "SELECT tenant_id, setting_key, HEX(payload), created_at, updated_at" "$rebuild_script"
grep -Fq 'mktemp "$db_dir/.settings-restore.complete.XXXXXX"' "$rebuild_script"
grep -Fq 'rm -f "$restore_marker_out"' "$rebuild_script"
grep -Fq 'if ! server_env=' "$rebuild_script"
grep -Fq 'if ! container_identity=' "$rebuild_script"
grep -Fq 'if ! existing_tables_output=' "$rebuild_script"
stale_marker_clear_line=$(grep -nF 'rm -f "$restore_marker_out"' "$rebuild_script" | cut -d: -f1)
first_database_write_line=$(grep -nF 'remote_query "$cleanup_sql"' "$rebuild_script" | cut -d: -f1)
[[ "$stale_marker_clear_line" -lt "$first_database_write_line" ]]
while IFS= read -r client_line; do
  grep -q -- '--database=aiop' <<< "$client_line"
done < <(grep 'MYSQL_PWD=' "$rebuild_script")

fake_bin="$tmp_dir/fake-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n%s\n%s\n' "${FAKE_MYSQL_HOST:-10.241.0.166}" "${FAKE_MYSQL_PORT:-3306}" aiop
EOF
cat > "$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *'docker inspect --type container --format'* ]]; then
  printf '%s\n' "${FAKE_CONTAINER_IDENTITY:-/mariadb-galera-master-166}"
  exit 0
fi
printf 'FAIL: offline contract reached a database client command\n' >&2
exit 99
EOF
chmod 700 "$fake_bin/kubectl" "$fake_bin/ssh"

invalid_rebuild_backup="$repo_root/dist/test-tmp/invalid-rebuild-backup-$RANDOM"
mkdir -p "$invalid_rebuild_backup/db"
printf 'tenant-a\tllm.default\t7B7D\t2026-08-08 00:00:00\t2026-08-08 00:00:00\n' > "$invalid_rebuild_backup/db/tenant-settings.tsv"
printf 'tenant-a\tsandbox.default.api_key\t7B7D\t2026-08-08 00:00:00\t2026-08-08 00:00:00\n' > "$invalid_rebuild_backup/db/setting-secrets.tsv"
cat > "$invalid_rebuild_backup/db/settings-backup.complete" <<'EOF'
database=aiop
tenant_settings_rows=1
tenant_settings_sha256=0000000000000000000000000000000000000000000000000000000000000000
setting_secrets_rows=1
setting_secrets_sha256=0000000000000000000000000000000000000000000000000000000000000000
timestamp=2026-08-08T00:00:00Z
EOF
chmod 600 "$invalid_rebuild_backup/db/"*.tsv "$invalid_rebuild_backup/db/settings-backup.complete"
if PATH="$fake_bin:$PATH" DB_REBUILD_MODE=initialize-in-place AIOP_BACKUP_DIR="$invalid_rebuild_backup" \
  "$rebuild_script" > "$tmp_dir/invalid-rebuild.stdout" 2> "$tmp_dir/invalid-rebuild.stderr"; then
  printf 'FAIL: invalid backup hashes were accepted by rebuild script\n' >&2
  exit 1
else
  invalid_rebuild_status=$?
fi
[[ "$invalid_rebuild_status" -eq 2 ]]
grep -q 'no database write was performed' "$tmp_dir/invalid-rebuild.stderr"
! grep -q 'offline contract reached a database client command' "$tmp_dir/invalid-rebuild.stderr"
rm -rf "$invalid_rebuild_backup"

rebuild_fake_bin="$tmp_dir/rebuild-fake-bin"
mkdir -p "$rebuild_fake_bin"
cat > "$rebuild_fake_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_KUBECTL_FAIL:-0}" == '1' ]]; then
  printf 'simulated kubectl failure\n' >&2
  exit 91
fi
printf '10.241.0.166\n3306\naiop\n'
EOF
cat > "$rebuild_fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command_text=${*: -1}
if [[ "$command_text" == *'docker inspect --type container --format'* ]]; then
  if [[ "${FAKE_INSPECT_FAIL:-0}" == '1' ]]; then
    printf 'simulated inspect failure\n' >&2
    exit 92
  fi
  printf '/mariadb-galera-master-166\n'
  exit 0
fi
if [[ "$command_text" =~ AIOP_QUERY_B64=\'([^\']+)\' ]]; then
  query=$(printf '%s' "${BASH_REMATCH[1]}" | base64 -d)
  printf '%s\n---\n' "$query" >> "$FAKE_QUERY_LOG"
  case "$query" in
    "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = 'aiop' ORDER BY TABLE_NAME;")
      if [[ "${FAKE_ENUMERATION_FAIL:-0}" == '1' ]]; then
        printf 'simulated enumeration failure\n' >&2
        exit 93
      fi
      printf 'old_table\n'
      ;;
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'aiop';")
      printf '%s\n' "$FAKE_BASELINE_COUNT"
      ;;
    *'FROM tenant_settings'*)
      cp "$FAKE_TENANT_BACKUP" /dev/stdout
      ;;
    *'FROM setting_secrets'*)
      cp "$FAKE_SECRET_BACKUP" /dev/stdout
      ;;
  esac
  exit 0
fi
cat >> "$FAKE_IMPORT_LOG"
printf '\n---IMPORT---\n' >> "$FAKE_IMPORT_LOG"
EOF
chmod 700 "$rebuild_fake_bin/kubectl" "$rebuild_fake_bin/ssh"
valid_rebuild_backup="$repo_root/dist/test-tmp/valid-rebuild-backup-$RANDOM"
mkdir -p "$valid_rebuild_backup/db"
printf 'tenant-a\tllm.default\t7B226D6F64656C223A2274657374227D\t2026-08-08 00:00:00\t2026-08-08 00:00:00\n' > "$valid_rebuild_backup/db/tenant-settings.tsv"
printf 'tenant-a\tsandbox.default.api_key\t7B226B6579223A2274657374227D\t2026-08-08 00:00:00\t2026-08-08 00:00:00\n' > "$valid_rebuild_backup/db/setting-secrets.tsv"
tenant_hash=$(sha256sum "$valid_rebuild_backup/db/tenant-settings.tsv" | cut -d' ' -f1)
secret_hash=$(sha256sum "$valid_rebuild_backup/db/setting-secrets.tsv" | cut -d' ' -f1)
cat > "$valid_rebuild_backup/db/settings-backup.complete" <<EOF
database=aiop
tenant_settings_rows=1
tenant_settings_sha256=$tenant_hash
setting_secrets_rows=1
setting_secrets_sha256=$secret_hash
timestamp=2026-08-08T00:00:00Z
EOF
chmod 600 "$valid_rebuild_backup/db/"*.tsv "$valid_rebuild_backup/db/settings-backup.complete"

run_rebuild_failure_contract() {
  local scenario=$1
  local expected_message=$2
  shift 2
  : > "$tmp_dir/$scenario-queries.log"
  : > "$tmp_dir/$scenario-imports.log"
  if env "$@" \
    FAKE_QUERY_LOG="$tmp_dir/$scenario-queries.log" \
    FAKE_IMPORT_LOG="$tmp_dir/$scenario-imports.log" \
    FAKE_BASELINE_COUNT=21 \
    FAKE_TENANT_BACKUP="$valid_rebuild_backup/db/tenant-settings.tsv" \
    FAKE_SECRET_BACKUP="$valid_rebuild_backup/db/setting-secrets.tsv" \
    PATH="$rebuild_fake_bin:$PATH" DB_REBUILD_MODE=initialize-in-place AIOP_BACKUP_DIR="$valid_rebuild_backup" \
      "$rebuild_script" > "$tmp_dir/$scenario.stdout" 2> "$tmp_dir/$scenario.stderr"; then
    printf 'FAIL: rebuild failure scenario %s was accepted\n' "$scenario" >&2
    exit 1
  else
    scenario_status=$?
  fi
  [[ "$scenario_status" -eq 2 ]]
  grep -q "$expected_message" "$tmp_dir/$scenario.stderr"
  grep -q 'no database write was performed' "$tmp_dir/$scenario.stderr"
  [[ ! -s "$tmp_dir/$scenario-imports.log" ]]
  ! grep -q 'DROP TABLE IF EXISTS' "$tmp_dir/$scenario-queries.log"
}

run_rebuild_failure_contract kubectl-failure 'unable to read live AIoP database metadata' FAKE_KUBECTL_FAIL=1
run_rebuild_failure_contract inspect-failure 'unable to verify MariaDB container identity' FAKE_INSPECT_FAIL=1
run_rebuild_failure_contract enumeration-failure 'unable to enumerate tables inside exact database aiop' FAKE_ENUMERATION_FAIL=1

expected_baseline_count=$(grep -Ec '^CREATE TABLE `' src/db/migrations/0001_baseline.sql)
expected_baseline_count=$((expected_baseline_count + 1))
FAKE_QUERY_LOG="$tmp_dir/rebuild-queries.log" \
FAKE_IMPORT_LOG="$tmp_dir/rebuild-imports.log" \
FAKE_BASELINE_COUNT="$expected_baseline_count" \
FAKE_TENANT_BACKUP="$valid_rebuild_backup/db/tenant-settings.tsv" \
FAKE_SECRET_BACKUP="$valid_rebuild_backup/db/setting-secrets.tsv" \
PATH="$rebuild_fake_bin:$PATH" DB_REBUILD_MODE=initialize-in-place AIOP_BACKUP_DIR="$valid_rebuild_backup" \
  "$rebuild_script" > "$tmp_dir/valid-rebuild.stdout" 2> "$tmp_dir/valid-rebuild.stderr"
grep -q 'settings_restore_verified=true' "$tmp_dir/valid-rebuild.stdout"
grep -Fq 'DROP TABLE IF EXISTS `old_table`;' "$tmp_dir/rebuild-queries.log"
grep -Fq 'START TRANSACTION;' "$tmp_dir/rebuild-imports.log"
grep -Fq "CONVERT(UNHEX('7B226D6F64656C223A2274657374227D') USING utf8mb4)" "$tmp_dir/rebuild-imports.log"
grep -Fq 'COMMIT;' "$tmp_dir/rebuild-imports.log"
grep -qx 'database=aiop' "$valid_rebuild_backup/db/settings-restore.complete"
grep -qx 'verified=true' "$valid_rebuild_backup/db/settings-restore.complete"
cmp -s "$valid_rebuild_backup/db/tenant-settings.tsv" "$valid_rebuild_backup/db/restored-tenant-settings.tsv"
cmp -s "$valid_rebuild_backup/db/setting-secrets.tsv" "$valid_rebuild_backup/db/restored-setting-secrets.tsv"
rm -rf "$valid_rebuild_backup"

endpoint_backup="$tmp_dir/endpoint-backup"
if PATH="$fake_bin:$PATH" FAKE_MYSQL_HOST=192.0.2.10 AIOP_BACKUP_DIR="$endpoint_backup" \
  "$db_backup_script" > "$tmp_dir/endpoint.stdout" 2> "$tmp_dir/endpoint.stderr"; then
  printf 'FAIL: mismatched live database endpoint was accepted\n' >&2
  exit 1
else
  endpoint_status=$?
fi
[[ "$endpoint_status" -eq 2 ]]
grep -q 'live AIoP database endpoint does not match' "$tmp_dir/endpoint.stderr"

container_backup="$tmp_dir/container-backup"
if PATH="$fake_bin:$PATH" FAKE_CONTAINER_IDENTITY=/unexpected-container AIOP_BACKUP_DIR="$container_backup" \
  "$db_backup_script" > "$tmp_dir/container.stdout" 2> "$tmp_dir/container.stderr"; then
  printf 'FAIL: mismatched MariaDB container identity was accepted\n' >&2
  exit 1
else
  container_status=$?
fi
[[ "$container_status" -eq 2 ]]
grep -q 'MariaDB container identity verification failed' "$tmp_dir/container.stderr"

symlink_target="$tmp_dir/symlink-target"
mkdir -p "$symlink_target"
ln -s "$symlink_target" "$tmp_dir/symlink-backup"
if AIOP_BACKUP_DIR="$tmp_dir/symlink-backup" "$db_backup_script" \
  > "$tmp_dir/symlink-dir.stdout" 2> "$tmp_dir/symlink-dir.stderr"; then
  printf 'FAIL: symlink backup directory was accepted\n' >&2
  exit 1
else
  symlink_dir_status=$?
fi
[[ "$symlink_dir_status" -eq 2 ]]
grep -q 'backup directory must be a real directory' "$tmp_dir/symlink-dir.stderr"

artifact_backup="$tmp_dir/artifact-backup"
mkdir -p "$artifact_backup/db"
ln -s "$tmp_dir/sensitive-target" "$artifact_backup/db/tenant-settings.tsv"
if PATH="$fake_bin:$PATH" AIOP_BACKUP_DIR="$artifact_backup" "$db_backup_script" \
  > "$tmp_dir/symlink-artifact.stdout" 2> "$tmp_dir/symlink-artifact.stderr"; then
  printf 'FAIL: symlink backup artifact was accepted\n' >&2
  exit 1
else
  symlink_artifact_status=$?
fi
[[ "$symlink_artifact_status" -eq 2 ]]
grep -q 'artifact path is a symlink or non-regular file' "$tmp_dir/symlink-artifact.stderr"
[[ ! -e "$tmp_dir/sensitive-target" ]]

grep -Fq 'dist_path="$repo_root/dist"' scripts/deploy-aiop-staging-fresh.sh
grep -Fq 'dist_root=$(realpath "$dist_path")' scripts/deploy-aiop-staging-fresh.sh
grep -Fq '"$dist_root/aiop-staging-backup/' scripts/deploy-aiop-staging-fresh.sh
grep -q '\.playwright-mcp/' .gitignore
grep -q '\.playwright-mcp/' .dockerignore
! grep -q 'scheduler-todos-20260806/backup' Makefile scripts/deploy-aiop-staging-fresh.sh

grep -q '^deploy-aiop-staging-workload:' Makefile
grep -Fq 'get configmap aiop-config -o name' Makefile
grep -Fq 'get secret aiop-secrets -o name' Makefile
grep -Fq 'make backup-aiop-staging-k8s-settings AIOP_BACKUP_DIR="$run_root"' scripts/deploy-aiop-staging-fresh.sh
grep -Fq 'make backup-aiop-staging-db-settings AIOP_BACKUP_DIR="$run_root"' scripts/deploy-aiop-staging-fresh.sh
grep -Fq 'make rebuild-aiop-staging-db DB_REBUILD_MODE=initialize-in-place AIOP_BACKUP_DIR="$run_root"' scripts/deploy-aiop-staging-fresh.sh
grep -Fq 'make deploy-aiop-staging-workload IMAGE_TAG="$IMAGE_TAG"' scripts/deploy-aiop-staging-fresh.sh
grep -Fq 'settings-restore.complete' scripts/deploy-aiop-staging-fresh.sh
grep -Fq "get configmap aiop-config -o json" scripts/deploy-aiop-staging-fresh.sh
grep -Fq "get secret aiop-secrets -o json" scripts/deploy-aiop-staging-fresh.sh
! grep -Eq 'base64[[:space:]]+-d|OPENAI_API_KEY' scripts/deploy-aiop-staging-fresh.sh

fresh_script=scripts/deploy-aiop-staging-fresh.sh
assert_fresh_path_blocked_before_make() {
  local scenario=$1
  local requested_path=$2
  local make_log="$tmp_dir/$scenario-make.log"
  local guard_bin="$tmp_dir/$scenario-bin"
  mkdir -p "$guard_bin"
  cat > "$guard_bin/make" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$make_log"
exit 97
EOF
  chmod 700 "$guard_bin/make"
  if PATH="$guard_bin:$PATH" AIOP_BACKUP_DIR="$requested_path" IMAGE_TAG=contract-test "$fresh_script" \
    > "$tmp_dir/$scenario.stdout" 2> "$tmp_dir/$scenario.stderr"; then
    printf 'FAIL: fresh deployment accepted unsafe backup path for %s\n' "$scenario" >&2
    exit 1
  else
    local status=$?
  fi
  [[ "$status" -eq 2 ]]
  grep -Eq 'backup directory must be under canonical dist|backup directory contains a symbolic link' "$tmp_dir/$scenario.stderr"
  [[ ! -s "$make_log" ]]
}

assert_fresh_path_blocked_before_make outside-dist "$repo_root/../aiop-task-8-outside-dist"
assert_fresh_path_blocked_before_make dotdot-escape "$repo_root/dist/../outside-dist"
symlink_escape_target="$repo_root/../aiop-task-8-symlink-target"
symlink_escape_parent="$repo_root/dist/test-tmp/staging-deploy-contract-symlink-$RANDOM"
mkdir -p "$symlink_escape_target"
ln -s "$symlink_escape_target" "$symlink_escape_parent"
assert_fresh_path_blocked_before_make symlink-parent "$symlink_escape_parent/run"
rm -f "$symlink_escape_parent"
rmdir "$symlink_escape_target"

run_fixture_fresh() {
  local scenario=$1
  local fixture_root
  fixture_root=$(realpath -m -- "$2")
  local expected_status=$3
  local make_log
  make_log=$(realpath -m -- "$tmp_dir/$scenario-fixture-make.log")
  local guard_bin
  guard_bin=$(realpath -m -- "$tmp_dir/$scenario-fixture-bin")
  mkdir -p "$fixture_root/scripts" "$guard_bin"
  cp "$fresh_script" "$fixture_root/scripts/deploy-aiop-staging-fresh.sh"
  chmod 700 "$fixture_root/scripts/deploy-aiop-staging-fresh.sh"
  cat > "$guard_bin/make" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$make_log"
exit 97
EOF
  chmod 700 "$guard_bin/make"
  if PATH="$guard_bin:$PATH" IMAGE_TAG=contract-test "$fixture_root/scripts/deploy-aiop-staging-fresh.sh" \
    > "$tmp_dir/$scenario-fixture.stdout" 2> "$tmp_dir/$scenario-fixture.stderr"; then
    printf 'FAIL: fixture scenario %s unexpectedly completed\n' "$scenario" >&2
    exit 1
  else
    local status=$?
  fi
  [[ "$status" -eq "$expected_status" ]]
  FIXTURE_MAKE_LOG=$make_log
}

absent_dist_fixture="$tmp_dir/absent-dist-fixture"
run_fixture_fresh absent-dist "$absent_dist_fixture" 97
[[ -d "$absent_dist_fixture/dist" && ! -L "$absent_dist_fixture/dist" ]]
[[ "$(stat -c '%a' "$absent_dist_fixture/dist")" == '700' ]]
grep -q -- '-n backup-aiop-staging-k8s-settings' "$FIXTURE_MAKE_LOG"

symlink_dist_fixture="$tmp_dir/symlink-dist-fixture"
symlink_dist_target="$tmp_dir/symlink-dist-target"
mkdir -p "$symlink_dist_fixture/scripts" "$symlink_dist_target"
ln -s "$symlink_dist_target" "$symlink_dist_fixture/dist"
run_fixture_fresh symlink-dist "$symlink_dist_fixture" 2
[[ ! -s "$FIXTURE_MAKE_LOG" ]]
grep -q 'repository dist must be a real directory' "$tmp_dir/symlink-dist-fixture.stderr"

fresh_guard_bin="$tmp_dir/fresh-guard-bin"
fresh_guard_log="$tmp_dir/fresh-guard.log"
mkdir -p "$fresh_guard_bin"
cat > "$fresh_guard_bin/make" <<'EOF'
#!/usr/bin/env bash
printf 'make %s\n' "$*" >> "$FRESH_GUARD_LOG"
if [[ "$1" == 'backup-aiop-staging-k8s-settings' ]]; then
  mkdir -p "$AIOP_BACKUP_DIR/k8s"
  printf '{}\n' > "$AIOP_BACKUP_DIR/k8s/aiop-config.data.json"
  printf '{}\n' > "$AIOP_BACKUP_DIR/k8s/aiop-secrets.data.json"
  chmod 600 "$AIOP_BACKUP_DIR/k8s/"*.json
fi
if [[ "$1" == 'rebuild-aiop-staging-db' ]]; then
  mkdir -p "$AIOP_BACKUP_DIR/db"
  printf 'database=aiop\nverified=true\n' > "$AIOP_BACKUP_DIR/db/settings-restore.complete"
  chmod 600 "$AIOP_BACKUP_DIR/db/settings-restore.complete"
fi
EOF
cat > "$fresh_guard_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >> "$FRESH_GUARD_LOG"
case "$*" in
  *'exec deploy/aiop-server'*)
    printf '%s\n%s\n%s\n' "${FRESH_MYSQL_HOST:-10.241.0.166}" "${FRESH_MYSQL_PORT:-3306}" "${FRESH_MYSQL_DATABASE:-aiop}"
    ;;
  *'get deployment aiop-server -o go-template='*) printf 'app=aiop-server,' ;;
  *'get pods -l app=aiop-server --no-headers'*) ;;
  *'get configmap aiop-config -o json'*) printf '{"data":{}}\n' ;;
  *'get secret aiop-secrets -o json'*) printf '{"data":{}}\n' ;;
  *'get deployment aiop-server -o jsonpath='*) printf '1\n' ;;
esac
EOF
cat > "$fresh_guard_bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '{"ok":true}\n'
EOF
cat > "$fresh_guard_bin/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >> "$FRESH_GUARD_LOG"
exit 97
EOF
chmod 700 "$fresh_guard_bin/make" "$fresh_guard_bin/kubectl" "$fresh_guard_bin/curl" "$fresh_guard_bin/ssh"

: > "$fresh_guard_log"
if PATH="$fresh_guard_bin:$PATH" FRESH_GUARD_LOG="$fresh_guard_log" AIOP_NAMESPACE=other-system \
  AIOP_BACKUP_DIR="$repo_root/dist/test-tmp/namespace-rejection-$RANDOM" IMAGE_TAG=contract-test \
  "$fresh_script" > "$tmp_dir/namespace.stdout" 2> "$tmp_dir/namespace.stderr"; then
  printf 'FAIL: fresh deployment accepted a non-aios-system namespace\n' >&2
  exit 1
else
  namespace_status=$?
fi
[[ "$namespace_status" -eq 2 ]]
grep -q 'namespace must be exactly aios-system' "$tmp_dir/namespace.stderr"
[[ ! -s "$fresh_guard_log" ]]

: > "$fresh_guard_log"
mismatch_backup="$repo_root/dist/test-tmp/endpoint-mismatch-$RANDOM"
if PATH="$fresh_guard_bin:$PATH" FRESH_GUARD_LOG="$fresh_guard_log" FRESH_MYSQL_HOST=192.0.2.10 \
  AIOP_BACKUP_DIR="$mismatch_backup" IMAGE_TAG=contract-test "$fresh_script" \
  > "$tmp_dir/fresh-endpoint.stdout" 2> "$tmp_dir/fresh-endpoint.stderr"; then
  printf 'FAIL: fresh deployment accepted a mismatched database endpoint\n' >&2
  exit 1
else
  mismatch_status=$?
fi
[[ "$mismatch_status" -eq 2 ]]
grep -q 'database endpoint does not match the fixed staging endpoint' "$tmp_dir/fresh-endpoint.stderr"
grep -q '^make pipeline ' "$fresh_guard_log"
grep -q 'kubectl .*exec deploy/aiop-server' "$fresh_guard_log"
! grep -q 'kubectl .*scale deployment/aiop-server' "$fresh_guard_log"
! grep -q '^make backup-aiop-staging-db-settings ' "$fresh_guard_log"
! grep -q '^make rebuild-aiop-staging-db ' "$fresh_guard_log"
! grep -q '^ssh ' "$fresh_guard_log"

: > "$fresh_guard_log"
ordered_backup="$repo_root/dist/test-tmp/ordered-fresh-$RANDOM"
PATH="$fresh_guard_bin:$PATH" FRESH_GUARD_LOG="$fresh_guard_log" AIOP_BACKUP_DIR="$ordered_backup" \
  IMAGE_TAG=contract-test "$fresh_script" > "$tmp_dir/ordered.stdout" 2> "$tmp_dir/ordered.stderr"
pipeline_line=$(grep -n '^make pipeline ' "$fresh_guard_log" | cut -d: -f1)
endpoint_line=$(grep -n 'kubectl .*exec deploy/aiop-server' "$fresh_guard_log" | cut -d: -f1)
scale_line=$(grep -n 'kubectl .*scale deployment/aiop-server --replicas=0' "$fresh_guard_log" | cut -d: -f1)
backup_line=$(grep -n '^make backup-aiop-staging-db-settings ' "$fresh_guard_log" | cut -d: -f1)
rebuild_line=$(grep -n '^make rebuild-aiop-staging-db ' "$fresh_guard_log" | cut -d: -f1)
deploy_line=$(grep -n '^make deploy-aiop-staging-workload ' "$fresh_guard_log" | cut -d: -f1)
[[ "$pipeline_line" -lt "$endpoint_line" && "$endpoint_line" -lt "$scale_line" &&
   "$scale_line" -lt "$backup_line" && "$backup_line" -lt "$rebuild_line" && "$rebuild_line" -lt "$deploy_line" ]]
grep -q 'kubectl .*get pods -l app=aiop-server --no-headers' "$fresh_guard_log"
grep -Fq 'workload remains scaled to zero' "$fresh_script"
grep -Fq 'deployment/aiop-server remains scaled to zero' "$fresh_script"
grep -Fq 'AIOP_VERIFIED_MYSQL_HOST=10.241.0.166' "$fresh_guard_log"
grep -Fq 'AIOP_VERIFIED_MYSQL_PORT=3306' "$fresh_guard_log"
grep -Fq 'AIOP_VERIFIED_MYSQL_DATABASE=aiop' "$fresh_guard_log"

recipe_file="$tmp_dir/workload-recipe.txt"
awk '/^deploy-aiop-staging-workload:/{flag=1; next} /^[a-zA-Z_-]+:/{flag=0} flag' Makefile > "$recipe_file"
if [[ ! -s "$recipe_file" ]]; then
  printf 'FAIL: deploy-aiop-staging-workload recipe not found in Makefile\n' >&2
  exit 1
fi
if grep -q "configmap.yaml" "$recipe_file"; then
  printf 'FAIL: deploy-aiop-staging-workload recipe contains configmap.yaml\n' >&2
  exit 1
fi

printf 'staging deploy contract tests passed\n'
