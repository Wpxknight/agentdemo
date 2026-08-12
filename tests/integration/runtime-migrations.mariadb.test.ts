import { readFile } from 'node:fs/promises';
import { createPool, type Pool } from 'mysql2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKysely, runMigrations } from '../../src/db/index.js';
import { MysqlStore } from '../../src/db/mysql.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const enabled = process.env.AIOP_MARIADB_INTEGRATION === '1';
const suite = enabled ? describe : describe.skip;
const host = process.env.MARIADB_HOST ?? '127.0.0.1';
const port = Number(process.env.MARIADB_PORT ?? 3306);
const user = process.env.MARIADB_USER ?? 'root';
const password = process.env.MARIADB_PASSWORD ?? '';
const databases = [
  'aiop_migration_fresh', 'aiop_migration_legacy', 'aiop_migration_resume',
  'aiop_migration_partial', 'aiop_migration_direct', 'aiop_migration_fresh_check',
  'aiop_migration_missing_map', 'aiop_migration_mixed_source',
];
let admin: Pool;

function pool(database: string): Pool {
  return createPool({ host, port, user, password, database, multipleStatements: true, supportBigNumbers: true, bigNumberStrings: true });
}

async function rows<T>(db: Pool, sql: string, values?: unknown[]): Promise<T[]> {
  const [result] = await db.promise().query(sql, values);
  return result as T[];
}

async function currentBaseline(): Promise<string> {
  return readFile(new URL('../../src/db/migrations/0001_baseline.sql', import.meta.url), 'utf8');
}

async function installLegacyBaseline(db: Pool): Promise<void> {
  let sql = await currentBaseline();
  sql = sql.replace('`id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `tenant_id` varchar(64) NOT NULL,\n  `username`', '`id` varchar(64) NOT NULL,\n  `tenant_id` varchar(64) NOT NULL,\n  `username`');
  for (const column of ['user_id', 'actor_id']) {
    sql = sql.replaceAll(`\`${column}\` bigint unsigned NOT NULL`, `\`${column}\` varchar(64) NOT NULL`);
  }
  sql = sql.replaceAll('`resolved_by` bigint unsigned DEFAULT NULL', '`resolved_by` varchar(64) DEFAULT NULL');
  await db.promise().query(sql);
  await db.promise().query(`CREATE TABLE schema_migrations (
    version INT NOT NULL PRIMARY KEY, name VARCHAR(128) NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await db.promise().query("INSERT INTO schema_migrations(version,name) VALUES (1,'0001_baseline.sql')");
}

async function seedLegacyRelationships(db: Pool): Promise<void> {
  await db.promise().query(`INSERT INTO users
    (id,tenant_id,username,role,password_hash,status,auth_provider)
    VALUES ('legacy-a','tenant-a','same-name','member','x','active','local'),
           ('legacy-b','tenant-b','same-name','admin','y','active','oidc')`);
  await db.promise().query(`INSERT INTO sessions (tenant_id,session_id,title,user_id)
    VALUES ('tenant-a','session-a','A','legacy-a'),('tenant-b','session-b','B','legacy-b')`);
  await db.promise().query(`INSERT INTO messages (tenant_id,session_id,role,content,user_id)
    VALUES ('tenant-a','session-a','user',JSON_OBJECT('text','A'),'legacy-a'),
           ('tenant-b','session-b','user',JSON_OBJECT('text','B'),'legacy-b')`);
}

suite.sequential('MariaDB runtime migrations', () => {
  beforeAll(async () => {
    admin = createPool({ host, port, user, password, multipleStatements: true });
    for (const database of databases) {
      await admin.promise().query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.promise().query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!admin) return;
    for (const database of databases) await admin.promise().query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.promise().end();
  });

  it('applies 0001/0002/0003 to a fresh database and is idempotent', async () => {
    const db = pool(databases[0]!);
    await runMigrations(db);
    await runMigrations(db);

    expect(await rows<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 },
    ]);
    const columns = await rows<{ tableName: string; columnName: string; columnType: string }>(db, `
      SELECT TABLE_NAME tableName,COLUMN_NAME columnName,COLUMN_TYPE columnType
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND ((TABLE_NAME='users' AND COLUMN_NAME='id')
          OR (TABLE_NAME='scheduled_tasks' AND COLUMN_NAME IN ('timezone','deleted_at')))
      ORDER BY TABLE_NAME,COLUMN_NAME`);
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ tableName: 'users', columnName: 'id', columnType: 'bigint(20) unsigned' }),
      expect.objectContaining({ tableName: 'scheduled_tasks', columnName: 'timezone' }),
      expect.objectContaining({ tableName: 'scheduled_tasks', columnName: 'deleted_at' }),
    ]));
    expect(await rows(db, "SHOW INDEX FROM scheduler_fires WHERE Key_name='uq_scheduler_fires_manual_idempotency'")).toHaveLength(4);
    expect(await rows(db, "SHOW TABLES LIKE 'oidc_exchange_codes'")).toHaveLength(1);
    expect(await rows(db, "SHOW INDEX FROM oidc_exchange_codes WHERE Key_name='idx_oidc_exchange_expiry'")).toHaveLength(1);
    expect(await rows(db, "SHOW INDEX FROM oidc_exchange_codes WHERE Key_name='idx_oidc_exchange_consumed_expiry'")).toHaveLength(2);
    await db.promise().end();
  }, 30_000);

  it('atomically consumes OIDC exchange codes across persistent Store instances', async () => {
    const first = new MysqlStore(createKysely(pool(databases[0]!)));
    const second = new MysqlStore(createKysely(pool(databases[0]!)));
    const codeHash = 'e'.repeat(64);
    await first.putOidcExchangeCode({
      codeHash, tenantId: 'tenant-a', provider: 'oidc', sessionToken: 'session-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? first : second).consumeOidcExchangeCode({ codeHash, provider: 'oidc', now: new Date() })));
    expect(results.filter(Boolean)).toEqual([{
      tenantId: 'tenant-a', provider: 'oidc', sessionToken: 'session-token',
    }]);
    await first.putOidcExchangeCode({
      codeHash: 'f'.repeat(64), tenantId: 'tenant-a', provider: 'oidc', sessionToken: 'next-token',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const verifyPool = pool(databases[0]!);
    expect(await rows(verifyPool,
      'SELECT code_hash FROM oidc_exchange_codes WHERE code_hash=?', [codeHash])).toHaveLength(0);
    await verifyPool.promise().end();
    await first.close();
    await second.close();
  }, 30_000);

  it('migrates existing tenant data with same usernames and preserves relationships', async () => {
    const db = pool(databases[1]!);
    await installLegacyBaseline(db);
    await seedLegacyRelationships(db);
    await runMigrations(db);
    await runMigrations(db);

    const mapped = await rows<{ tenantId: string; oldId: string; newId: string }>(db,
      'SELECT tenant_id tenantId,old_id oldId,new_id newId FROM user_id_migration_map ORDER BY tenant_id');
    expect(mapped).toHaveLength(2);
    expect(mapped.map((row) => [row.tenantId, row.oldId])).toEqual([
      ['tenant-a', 'legacy-a'], ['tenant-b', 'legacy-b'],
    ]);
    const linked = await rows<{ tenantId: string; username: string; sessionUser: string; messageUser: string }>(db, `
      SELECT u.tenant_id tenantId,u.username,s.user_id sessionUser,m.user_id messageUser
      FROM users u JOIN sessions s ON s.tenant_id=u.tenant_id AND s.user_id=u.id
      JOIN messages m ON m.tenant_id=u.tenant_id AND m.user_id=u.id ORDER BY u.tenant_id`);
    expect(linked).toHaveLength(2);
    expect(linked.every((row) => row.username === 'same-name' && row.sessionUser === row.messageUser)).toBe(true);
    expect(await rows(db, 'SELECT * FROM users_legacy_string_ids')).toHaveLength(2);
    await db.promise().end();
  }, 30_000);

  it('accepts a fresh standalone target schema without migration artifacts or map', async () => {
    const database = databases[5]!;
    const db = pool(database);
    await runMigrations(db);
    const env = {
      ...process.env,
      MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_DATABASE: database, MYSQL_USER: user,
      MYSQL_PASSWORD_BASE64: Buffer.from(password).toString('base64'),
      DEPLOYMENT_MODE: 'standalone', AUTH_PROVIDER: 'local',
    };
    await expect(execFileAsync('npm', ['exec', '--', 'tsx', 'scripts/check-user-id-migration.ts'], {
      cwd: new URL('../..', import.meta.url), env,
    })).resolves.toMatchObject({ stdout: expect.stringContaining('positive-bigint') });
    await db.promise().end();
  }, 30_000);

  it('rejects a migrated standalone schema when its map is missing', async () => {
    const database = databases[6]!;
    const db = pool(database);
    await installLegacyBaseline(db);
    await seedLegacyRelationships(db);
    await runMigrations(db);
    await db.promise().query('DROP TABLE user_id_migration_map');
    const env = {
      ...process.env,
      MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_DATABASE: database, MYSQL_USER: user,
      MYSQL_PASSWORD_BASE64: Buffer.from(password).toString('base64'),
      DEPLOYMENT_MODE: 'standalone', AUTH_PROVIDER: 'local',
    };
    await expect(execFileAsync('npm', ['exec', '--', 'tsx', 'scripts/check-user-id-migration.ts'], {
      cwd: new URL('../..', import.meta.url), env,
    })).rejects.toThrow();
    await db.promise().end();
  }, 30_000);

  it('rejects mixed local and OIDC identity sources in one standalone database', async () => {
    const database = databases[7]!;
    const db = pool(database);
    await runMigrations(db);
    await db.promise().query(`INSERT INTO users
      (tenant_id,username,role,password_hash,status,auth_provider)
      VALUES ('default','local-user','member','x','active','local'),
             ('default','oidc-user','member','x','active','oidc')`);
    const env = {
      ...process.env,
      MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_DATABASE: database, MYSQL_USER: user,
      MYSQL_PASSWORD_BASE64: Buffer.from(password).toString('base64'),
      DEPLOYMENT_MODE: 'standalone', AUTH_PROVIDER: 'local',
    };
    await expect(execFileAsync('npm', ['exec', '--', 'tsx', 'scripts/check-user-id-migration.ts'], {
      cwd: new URL('../..', import.meta.url), env,
    })).rejects.toThrow();
    await db.promise().end();
  }, 30_000);

  it('explicit aios-integrated preflight allows direct positive identities without users/map while standalone rejects them', async () => {
    const database = databases[4]!;
    const db = pool(database);
    await runMigrations(db);
    await db.promise().query("INSERT INTO sessions (tenant_id,session_id,title,user_id) VALUES ('default','direct','Direct AIOS',1001)");
    const env = {
      ...process.env,
      MYSQL_HOST: host,
      MYSQL_PORT: String(port),
      MYSQL_DATABASE: database,
      MYSQL_USER: user,
      MYSQL_PASSWORD_BASE64: Buffer.from(password).toString('base64'),
      DEPLOYMENT_MODE: 'aios-integrated',
      AUTH_PROVIDER: 'aios',
    };
    await expect(execFileAsync('npm', ['exec', '--', 'tsx', 'scripts/check-user-id-migration.ts'], {
      cwd: new URL('../..', import.meta.url), env,
    })).resolves.toMatchObject({ stdout: expect.stringContaining('positive-bigint') });
    await expect(execFileAsync('npm', ['exec', '--', 'tsx', 'scripts/check-user-id-migration.ts'], {
      cwd: new URL('../..', import.meta.url), env: { ...env, DEPLOYMENT_MODE: 'standalone', AUTH_PROVIDER: 'local' },
    })).rejects.toThrow();
    await db.promise().end();
  }, 30_000);

  it('does not accept signed or partially converted v3 schemas as complete', async () => {
    const db = pool(databases[3]!);
    await runMigrations(db);
    await db.promise().query('ALTER TABLE sessions MODIFY user_id bigint NOT NULL');
    await expect(runMigrations(db)).rejects.toThrow('target schema is incomplete');
    expect(await rows<{ version: number }>(db, 'SELECT version FROM schema_migrations WHERE version=3')).toHaveLength(1);
    await db.promise().end();
  }, 30_000);

  it('resumes after committed DML and auto-committed DDL stages', async () => {
    const db = pool(databases[2]!);
    await installLegacyBaseline(db);
    await seedLegacyRelationships(db);
    await db.promise().query(`CREATE TABLE user_id_migration_map (
      tenant_id varchar(64) NOT NULL, old_id varchar(128) NOT NULL,
      new_id bigint unsigned NOT NULL AUTO_INCREMENT, provider varchar(16) NOT NULL,
      PRIMARY KEY (new_id), UNIQUE KEY uq_user_id_migration_old (tenant_id,old_id)
    ) ENGINE=InnoDB`);
    await db.promise().query(`CREATE TABLE user_id_migration_stages (
      stage varchar(128) NOT NULL PRIMARY KEY, completed_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await db.promise().query(`INSERT INTO user_id_migration_map (tenant_id,old_id,provider)
      SELECT tenant_id,id,auth_provider FROM users ORDER BY tenant_id,id`);
    const conn = await db.promise().getConnection();
    await conn.beginTransaction();
    await conn.query(`UPDATE sessions x JOIN user_id_migration_map m
      ON m.tenant_id=x.tenant_id AND m.old_id=CAST(x.user_id AS CHAR)
      SET x.user_id=CONCAT('#aiop:',m.new_id)`);
    await conn.query(`UPDATE sessions x JOIN user_id_migration_map m
      ON m.tenant_id=x.tenant_id AND CAST(x.user_id AS CHAR)=CONCAT('#aiop:',m.new_id)
      SET x.user_id=CAST(m.new_id AS CHAR)`);
    await conn.query("INSERT INTO user_id_migration_stages(stage) VALUES ('mapped:sessions.user_id')");
    await conn.commit();
    conn.release();
    await db.promise().query('ALTER TABLE sessions MODIFY user_id bigint unsigned NOT NULL');

    await runMigrations(db);
    expect(await rows(db, 'SELECT s.tenant_id FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id')).toHaveLength(2);
    expect(await rows<{ stage: string }>(db, 'SELECT stage FROM user_id_migration_stages')).toHaveLength(8);
    expect(await rows<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 },
    ]);
    await db.promise().end();
  }, 30_000);
});
