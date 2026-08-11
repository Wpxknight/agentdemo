import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations, runPositiveUserIdMigration } from '../src/db/index.js';
import { verifyBackupChecksum } from '../scripts/verify-backup-checksum.js';

const migrations = new URL('../src/db/migrations/', import.meta.url);

function fakeIdentityConnection(options: {
  usersType: string;
  statements: string[];
  completedStages?: Set<string>;
}) {
  const completed = options.completedStages ?? new Set<string>();
  return {
    get usersType() { return options.usersType; },
    set usersType(value: string) { options.usersType = value; },
    async query(sql: string, values?: unknown[]) {
      options.statements.push(sql);
      if (sql.includes('information_schema.COLUMNS')) {
        const table = String(values?.[0]);
        const column = String(values?.[1]);
        const typed = completed.has(`typed:${table}.${column}`);
        return [[{ columnType: table === 'users' && column === 'id' ? options.usersType : typed || options.usersType.startsWith('bigint') ? 'bigint unsigned' : 'varchar(64)' }], []];
      }
      if (sql.includes('information_schema.TABLES')) return [[{ count: 0 }], []];
      if (sql.startsWith('SELECT stage FROM user_id_migration_stages')) {
        return [completed.has(String(values?.[0])) ? [{ stage: values?.[0] }] : [], []];
      }
      if (sql.startsWith('INSERT INTO user_id_migration_stages')) completed.add(String(values?.[0]));
      if (sql.startsWith('SELECT COUNT(*) count FROM')) return [[{ count: 0 }], []];
      if (sql.startsWith('ALTER TABLE')) {
        const match = sql.match(/ALTER TABLE `([^`]+)` MODIFY `([^`]+)`/);
        if (match) completed.add(`typed:${match[1]}.${match[2]}`);
      }
      if (sql.startsWith('RENAME TABLE')) options.usersType = 'bigint unsigned';
      return [[], []];
    },
    async beginTransaction() {}, async commit() {}, async rollback() {},
  };
}

describe('migration safety gates', () => {
  it('requires the checksum sidecar to name the exact backup artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiop-backup-'));
    const backup = join(dir, 'backup.sql');
    const other = join(dir, 'other.sql');
    await writeFile(backup, 'SELECT 1;\n');
    await writeFile(other, 'SELECT 1;\n');
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update('SELECT 1;\n').digest('hex');

    await writeFile(`${backup}.sha256`, `${digest}  other.sql\n`);
    await expect(verifyBackupChecksum(backup)).rejects.toThrow('exactly identify backup.sql');
    await writeFile(`${backup}.sha256`, `${digest}  ../${dir.split('/').at(-1)}/other.sql\n`);
    await expect(verifyBackupChecksum(backup)).rejects.toThrow('exactly identify backup.sql');

    await writeFile(`${backup}.sha256`, `${digest}  backup.sql\n`);
    await expect(verifyBackupChecksum(backup)).resolves.toBeUndefined();
  });
});

describe('fresh database baseline', () => {
  it('ships a current baseline plus the prior-HEAD scheduler upgrade', async () => {
    const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toEqual([
      '0001_baseline.sql', '0002_scheduler_schema_upgrade.sql',
      '0003_positive_user_ids.sql', '0004_oidc_exchange_codes.sql',
    ]);

    const source = (await readFile(new URL(files[0]!, migrations), 'utf8')).toLowerCase();
    for (const table of [
      'agent_runs', 'agent_run_attempts', 'agent_run_events', 'agent_run_inbox_messages',
      'agent_turn_snapshots', 'agent_turn_commits', 'agent_tool_executions',
      'pi_sessions', 'pi_session_entries', 'scheduler_fires',
    ]) expect(source).toContain(`create table \`${table}\``);
    for (const column of [
      'kernel_version', 'waiting_reason', 'limits_json', 'execution_json', 'append_closed_at',
      'cost_usd', 'correlation_id', 'logical_call_id', 'idempotency_key',
    ]) expect(source).toContain(`\`${column}\``);
    expect(source).not.toMatch(/legacy|compat-v1|langgraph|graph_name|graph_version|runtime_version/);
    expect(source).not.toMatch(/\balter\s+table\b|\bdrop\s+(?:table|column|trigger)\b/);
    expect(source).toContain('collate=utf8mb4_unicode_ci');
    expect(source).not.toContain('utf8mb4_0900_ai_ci');
  });

  it('uses precision-safe positive identity columns in the fresh baseline', async () => {
    const source = (await readFile(new URL('0001_baseline.sql', migrations), 'utf8')).toLowerCase();
    expect(source).toMatch(/`users`[\s\S]*?`id` bigint unsigned not null auto_increment/);
    for (const column of ['user_id', 'actor_id', 'resolved_by']) {
      expect(source).toContain(`\`${column}\` bigint unsigned`);
    }
  });

  it('skips all legacy work for the current fresh baseline', async () => {
    const statements: string[] = [];
    await runPositiveUserIdMigration(fakeIdentityConnection({ usersType: 'bigint unsigned', statements }) as never);
    expect(statements).toHaveLength(10);
    expect(statements.every((sql) => sql.includes('information_schema.COLUMNS'))).toBe(true);
  });

  it('migrates tenant-scoped duplicate legacy IDs and is repeatable after cut-over', async () => {
    const statements: string[] = [];
    const connection = fakeIdentityConnection({ usersType: 'varchar(64)', statements });
    await runPositiveUserIdMigration(connection as never);
    expect(statements.some((sql) => sql.includes('m.tenant_id=x.tenant_id'))).toBe(true);
    expect(statements.some((sql) => sql.startsWith('RENAME TABLE users TO users_legacy_string_ids'))).toBe(true);

    connection.usersType = 'bigint unsigned';
    statements.length = 0;
    await runPositiveUserIdMigration(connection as never);
    expect(statements).toHaveLength(10);
  });

  it('resumes mapped columns after an interrupted auto-committed ALTER', async () => {
    const statements: string[] = [];
    const connection = fakeIdentityConnection({
      usersType: 'varchar(64)', statements, completedStages: new Set(['mapped:sessions.user_id']),
    });
    await runPositiveUserIdMigration(connection as never);
    expect(statements.some((sql) => sql.includes('UPDATE `sessions`'))).toBe(false);
    expect(statements.some((sql) => sql.includes('ALTER TABLE `sessions`'))).toBe(true);
  });

  it('upgrades the prior HEAD baseline with explicit MariaDB-compatible scheduler DDL', async () => {
    const source = (await readFile(new URL('0002_scheduler_schema_upgrade.sql', migrations), 'utf8')).toLowerCase();

    expect(source).toContain('alter table `scheduled_tasks`');
    expect(source).toContain('add column if not exists `timezone`');
    expect(source).toContain('add column if not exists `deleted_at`');
    expect(source).toContain('drop index if exists `idx_due`');
    expect(source).toContain('add index if not exists `idx_due` (`enabled`, `deleted_at`, `next_run_at`)');
    expect(source).toContain('alter table `scheduler_fires`');
    expect(source).toContain('add column if not exists `trigger_kind`');
    expect(source).toContain('add column if not exists `idempotency_key`');
    expect(source).toContain('add index if not exists `idx_scheduler_fires_task_history`');
    expect(source).toContain('add index if not exists `idx_scheduler_fires_retention`');
    expect(source).toContain('add unique index if not exists `uq_scheduler_fires_manual_idempotency`');
    expect(source).toMatch(/update\s+`scheduler_fires`\s+set\s+`state`\s*=\s*'completed'\s+where\s+`state`\s*=\s*'started'/);
    expect(source).not.toMatch(/information_schema|show\s+databases|show\s+tables|use\s+`?/);
  });

  it('applies and records the baseline as version 1', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const connection = {
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        if (sql === 'SELECT version FROM schema_migrations') return [[], []];
        if (sql.includes('information_schema.COLUMNS')) return [[{ columnType: 'bigint unsigned' }], []];
        return [[], []];
      },
      release() {},
    };

    await runMigrations({ promise: () => ({ getConnection: async () => connection }) } as never);

    const recorded = statements.filter(({ sql }) => sql.startsWith('INSERT INTO schema_migrations'));
    expect(recorded.map(({ values }) => values)).toEqual([
      [1, '0001_baseline.sql'],
      [2, '0002_scheduler_schema_upgrade.sql'],
      [3, '0003_positive_user_ids.sql'],
      [4, '0004_oidc_exchange_codes.sql'],
    ]);
    expect(statements.some(({ sql }) => sql.includes('CREATE TABLE `agent_runs`'))).toBe(true);
  });

  it('executes and records later versions when version 1 is already applied', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const connection = {
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        if (sql === 'SELECT version FROM schema_migrations') return [[{ version: 1 }], []];
        if (sql.includes('information_schema.COLUMNS')) return [[{ columnType: 'bigint unsigned' }], []];
        return [[], []];
      },
      release() {},
    };

    await runMigrations({ promise: () => ({ getConnection: async () => connection }) } as never);

    expect(statements.some(({ sql }) => sql.includes('CREATE TABLE `agent_runs`'))).toBe(false);
    expect(statements.some(({ sql }) => sql.includes('ALTER TABLE `scheduled_tasks`'))).toBe(true);
    expect(statements.filter(({ sql }) => sql.startsWith('INSERT INTO schema_migrations'))).toEqual([
      expect.objectContaining({ values: [2, '0002_scheduler_schema_upgrade.sql'] }),
      expect.objectContaining({ values: [3, '0003_positive_user_ids.sql'] }),
      expect.objectContaining({ values: [4, '0004_oidc_exchange_codes.sql'] }),
    ]);
  });

  it('keeps the Kysely schema aligned with the baseline', async () => {
    const source = (await readFile(new URL('../schema.ts', migrations), 'utf8')).toLowerCase();
    for (const table of ['agent_run_attempts:', 'agent_turn_snapshots:', 'agent_turn_commits:', 'scheduler_fires:']) {
      expect(source).toContain(table);
    }
    expect(source).not.toMatch(/langgraph|graph_name|graph_version|runtime_version/);
  });
});
