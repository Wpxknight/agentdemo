import { readFile, readdir } from 'node:fs/promises';
import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import type { Pool } from 'mysql2';
import { logger } from '../logger.js';
import type { MysqlConfig } from '../config/mysql.js';
import type { AuthProviderKind, DeploymentMode } from '../auth/types.js';
import type { Database } from './schema.js';
import type { Store } from './store.js';
import { MysqlStore } from './mysql.js';
import { MemoryStore } from './memory.js';

const log = logger.child({ mod: 'db' });

/** 建 mysql2（回调式）连接池；migration 需 multipleStatements 执行整份 DDL。 */
export function createMysqlPool(cfg: MysqlConfig): Pool {
  return createPool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? {} : undefined,
    connectionLimit: cfg.poolSize,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: 'Z',
  });
}

export function createKysely(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });
}

/**
 * 版本化迁移：扫描 migrations/000N_*.sql，按版本号顺序应用未执行的迁移，
 * 已应用记录在 schema_migrations 表（幂等、可演进，对既有库追加 ALTER）。
 */
type MigrationConnection = Awaited<ReturnType<ReturnType<Pool['promise']>['getConnection']>>;

const identityReferences = [
  ['sessions', 'user_id', false], ['messages', 'user_id', false],
  ['scheduled_tasks', 'user_id', false], ['scheduler_fires', 'actor_id', false],
  ['agent_runs', 'user_id', false], ['agent_interactions', 'user_id', false],
  ['agent_interactions', 'resolved_by', true], ['user_credentials', 'user_id', false],
] as const;

async function columnType(conn: MigrationConnection, table: string, column: string): Promise<string | undefined> {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE columnType FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return (rows as Array<{ columnType?: string }>)[0]?.columnType?.toLowerCase();
}

async function tableExists(conn: MigrationConnection, table: string): Promise<boolean> {
  const [rows] = await conn.query(
    'SELECT COUNT(*) count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table],
  );
  return Number((rows as Array<{ count: number | string }>)[0]?.count ?? 0) > 0;
}

function isUnsignedBigint(type: string | undefined): boolean {
  return Boolean(type && /^bigint(?:\(\d+\))? unsigned$/.test(type));
}

async function assertPositiveIdentitySchema(conn: MigrationConnection): Promise<void> {
  const invalid: string[] = [];
  if (!isUnsignedBigint(await columnType(conn, 'users', 'id'))) invalid.push('users.id');
  for (const [table, column] of identityReferences) {
    if (!isUnsignedBigint(await columnType(conn, table, column))) invalid.push(`${table}.${column}`);
  }
  if (invalid.length) throw new Error(`User ID migration target schema is incomplete: ${invalid.join(', ')}`);
}

/**
 * MySQL DDL auto-commits, so migration 0003 is executed as explicit resumable stages.
 * DML and its stage marker commit together; every DDL is guarded by current object shape.
 */
export async function runPositiveUserIdMigration(conn: MigrationConnection): Promise<void> {
  const usersType = await columnType(conn, 'users', 'id');
  if (!usersType) throw new Error('users.id is missing');
  if (isUnsignedBigint(usersType)) {
    await assertPositiveIdentitySchema(conn);
    return; // Current fresh baseline: never create legacy artifacts.
  }
  if (usersType.startsWith('bigint')) {
    throw new Error(`users.id must be BIGINT UNSIGNED, got ${usersType}`);
  }

  await conn.query(`CREATE TABLE IF NOT EXISTS user_id_migration_map (
    tenant_id varchar(64) NOT NULL, old_id varchar(128) NOT NULL,
    new_id bigint unsigned NOT NULL AUTO_INCREMENT, provider varchar(16) NOT NULL,
    PRIMARY KEY (new_id), UNIQUE KEY uq_user_id_migration_old (tenant_id, old_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await conn.query(`CREATE TABLE IF NOT EXISTS user_id_migration_stages (
    stage varchar(128) NOT NULL, completed_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (stage)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await conn.query(`INSERT IGNORE INTO user_id_migration_map (tenant_id, old_id, provider)
    SELECT tenant_id, CAST(id AS CHAR), auth_provider FROM users ORDER BY tenant_id, id`);

  for (const [table, column, nullable] of identityReferences) {
    const type = await columnType(conn, table, column);
    if (!type) throw new Error(`${table}.${column} is missing`);
    if (type.startsWith('bigint')) continue;
    const stage = `mapped:${table}.${column}`;
    const [stageRows] = await conn.query('SELECT stage FROM user_id_migration_stages WHERE stage = ?', [stage]);
    if (!(stageRows as unknown[]).length) {
      const [orphanRows] = await conn.query(
        `SELECT COUNT(*) count FROM \`${table}\` x LEFT JOIN user_id_migration_map m
          ON m.tenant_id=x.tenant_id AND m.old_id=CAST(x.\`${column}\` AS CHAR)
          WHERE ${nullable ? `x.\`${column}\` IS NOT NULL AND ` : ''}m.new_id IS NULL`,
      );
      if (BigInt(String((orphanRows as Array<{ count: string | number }>)[0]?.count ?? 0)) !== 0n) {
        throw new Error(`Cannot migrate orphan identities in ${table}.${column}`);
      }
      await conn.beginTransaction();
      try {
        // Use a value outside the legacy/new ID domains first, avoiding transient unique-key
        // collisions when a legacy numeric ID equals another user's mapped positive ID.
        await conn.query(`UPDATE \`${table}\` x JOIN user_id_migration_map m
          ON m.tenant_id=x.tenant_id AND m.old_id=CAST(x.\`${column}\` AS CHAR)
          SET x.\`${column}\`=CONCAT('#aiop:',m.new_id)`);
        await conn.query(`UPDATE \`${table}\` x JOIN user_id_migration_map m
          ON m.tenant_id=x.tenant_id AND CAST(x.\`${column}\` AS CHAR)=CONCAT('#aiop:',m.new_id)
          SET x.\`${column}\`=CAST(m.new_id AS CHAR)`);
        await conn.query('INSERT INTO user_id_migration_stages (stage) VALUES (?)', [stage]);
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    }
    // If interruption happened after the committed mapping, this guarded DDL safely resumes.
    await conn.query(`ALTER TABLE \`${table}\` MODIFY \`${column}\` bigint unsigned ${nullable ? 'NULL' : 'NOT NULL'}`);
  }

  if (!await tableExists(conn, 'users_positive')) {
    await conn.query(`CREATE TABLE users_positive (
      id bigint unsigned NOT NULL AUTO_INCREMENT, tenant_id varchar(64) NOT NULL,
      username varchar(128) NOT NULL, role varchar(32) NOT NULL, password_hash varchar(255) NOT NULL,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, status varchar(16) NOT NULL DEFAULT 'active',
      auth_provider varchar(16) NOT NULL DEFAULT 'local', display_name varchar(128) DEFAULT NULL,
      home_dir varchar(512) DEFAULT NULL, PRIMARY KEY (id), UNIQUE KEY uniq_user (tenant_id,username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  await conn.query(`INSERT INTO users_positive
    (id, tenant_id, username, role, password_hash, created_at, status, auth_provider, display_name, home_dir)
    SELECT m.new_id,u.tenant_id,u.username,u.role,u.password_hash,u.created_at,u.status,u.auth_provider,u.display_name,u.home_dir
      FROM users u JOIN user_id_migration_map m ON m.tenant_id=u.tenant_id AND m.old_id=CAST(u.id AS CHAR)
    ON DUPLICATE KEY UPDATE username=VALUES(username),role=VALUES(role),password_hash=VALUES(password_hash),
      status=VALUES(status),auth_provider=VALUES(auth_provider),display_name=VALUES(display_name),home_dir=VALUES(home_dir)`);
  if (await tableExists(conn, 'users_legacy_string_ids')) {
    throw new Error('users_legacy_string_ids already exists while users still has string IDs');
  }
  // One atomic RENAME is the cut-over; either both names change or neither does.
  await conn.query('RENAME TABLE users TO users_legacy_string_ids, users_positive TO users');
  await assertPositiveIdentitySchema(conn);
}

export async function runMigrations(pool: Pool): Promise<void> {
  const conn = await pool.promise().getConnection();
  const lockName = 'aiop:schema-migrations';
  let lockAcquired = false;
  let migrationVersion: number | undefined;
  try {
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, 60]);
    if (Number((lockRows as Array<{ acquired: number | null }>)[0]?.acquired) !== 1) {
      throw new Error('Timed out waiting for the schema migration lock');
    }
    lockAcquired = true;
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT          NOT NULL,
      name       VARCHAR(128) NOT NULL,
      applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

    const dir = new URL('./migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    const [rows] = await conn.query('SELECT version FROM schema_migrations');
    const applied = new Set((rows as { version: number }[]).map((r) => r.version));

    let count = 0;
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      if (!Number.isInteger(version)) {
        log.warn({ file }, '迁移文件名无版本号前缀，跳过');
        continue;
      }
      if (applied.has(version)) {
        if (version === 3) await assertPositiveIdentitySchema(conn);
        continue;
      }
      const sql = await readFile(new URL(file, dir), 'utf8');
      migrationVersion = version;
      if (version === 3) await runPositiveUserIdMigration(conn);
      else await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [version, file]);
      migrationVersion = undefined;
      log.info({ version, file }, 'migration applied');
      count++;
    }
    log.info({ applied: count, total: files.length }, 'migrations up to date');
  } catch (error) {
    if (migrationVersion === 3) {
      throw new Error('User ID migration failed; rerun the read-only preflight before retrying migration', { cause: error });
    }
    throw error;
  } finally {
    let reusable = !lockAcquired;
    if (lockAcquired) {
      try {
        const [releaseRows] = await conn.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
        reusable = Number((releaseRows as Array<{ released: number | null }>)[0]?.released) === 1;
        if (!reusable) log.warn('schema migration lock release was not confirmed; destroying connection');
      } catch (error) {
        log.warn({ err: String(error) }, 'failed to release schema migration lock');
      }
    }
    if (reusable) conn.release();
    else conn.destroy();
  }
}

export interface IdentityModeCompatibility {
  deploymentMode: DeploymentMode;
  authProvider: AuthProviderKind;
  allowMixedIdentitySource?: boolean;
}

function allowMixedIdentitySource(identity: IdentityModeCompatibility, incompatibleUsers: bigint): boolean {
  if (!identity.allowMixedIdentitySource || identity.deploymentMode !== 'aios-integrated' || identity.authProvider !== 'aios') {
    return false;
  }
  log.warn({
    deploymentMode: identity.deploymentMode,
    authProvider: identity.authProvider,
    incompatibleUserCount: incompatibleUsers.toString(),
  }, 'UNSAFE mixed identity source compatibility override is enabled');
  return true;
}

async function assertExistingIdentitySourceCompatibility(
  pool: Pool,
  identity: IdentityModeCompatibility,
): Promise<void> {
  const conn = await pool.promise().getConnection();
  try {
    const [tableRows] = await conn.query(
      "SELECT COUNT(*) count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'",
    );
    if (Number((tableRows as Array<{ count: string | number }>)[0]?.count ?? 0) === 0) return;
    const expectedProvider = identity.deploymentMode === 'aios-integrated' ? undefined : identity.authProvider;
    const [userRows] = await conn.query(
      expectedProvider
        ? 'SELECT COUNT(*) count FROM users WHERE auth_provider <> ?'
        : "SELECT COUNT(*) count FROM users WHERE auth_provider IN ('local','oidc','aios')",
      expectedProvider ? [expectedProvider] : [],
    );
    const incompatibleUsers = BigInt(String((userRows as Array<{ count: string | number }>)[0]?.count ?? 0));
    if (incompatibleUsers !== 0n && !allowMixedIdentitySource(identity, incompatibleUsers)) {
      throw new Error(
        `Database identity mode is incompatible with ${identity.deploymentMode}/${identity.authProvider}: `
        + `${incompatibleUsers} user rows belong to another identity namespace`,
      );
    }
  } finally {
    conn.release();
  }
}

/**
 * 业务数据只以 tenant_id + user_id 归属；因此本地/OIDC 用户和 AIOS direct accountId
 * 不能在未经显式数据迁移的情况下复用同一数据库。
 */
export async function assertIdentityModeCompatibility(
  pool: Pool,
  identity: IdentityModeCompatibility,
): Promise<void> {
  const conn = await pool.promise().getConnection();
  try {
    const expectedProvider = identity.deploymentMode === 'aios-integrated' ? undefined : identity.authProvider;
    const [userRows] = await conn.query(
      expectedProvider
        ? 'SELECT COUNT(*) count FROM users WHERE auth_provider <> ?'
        : "SELECT COUNT(*) count FROM users WHERE auth_provider IN ('local','oidc','aios')",
      expectedProvider ? [expectedProvider] : [],
    );
    const incompatibleUsers = BigInt(String((userRows as Array<{ count: string | number }>)[0]?.count ?? 0));
    if (incompatibleUsers !== 0n && !allowMixedIdentitySource(identity, incompatibleUsers)) {
      throw new Error(
        `Database identity mode is incompatible with ${identity.deploymentMode}/${identity.authProvider}: `
        + `${incompatibleUsers} user rows belong to another identity namespace`,
      );
    }

    if (identity.deploymentMode === 'standalone') {
      for (const [table, column, nullable] of identityReferences) {
        const [rows] = await conn.query(
          `SELECT COUNT(*) count FROM \`${table}\` x LEFT JOIN users u
            ON u.tenant_id=x.tenant_id AND u.id=x.\`${column}\`
            WHERE ${nullable ? `x.\`${column}\` IS NOT NULL AND ` : ''}u.id IS NULL`,
        );
        const orphans = BigInt(String((rows as Array<{ count: string | number }>)[0]?.count ?? 0));
        if (orphans !== 0n) {
          throw new Error(
            `Database identity mode is incompatible with standalone/${identity.authProvider}: `
            + `${table}.${column} contains ${orphans} direct or unmapped identities`,
          );
        }
      }
    }
  } finally {
    conn.release();
  }
}

/** 按配置创建 Store：有 MySQL 则迁移、校验身份模式并创建 MysqlStore，否则回落 MemoryStore。 */
export async function createStore(
  cfg: MysqlConfig | undefined,
  identity: IdentityModeCompatibility,
): Promise<Store> {
  if (!cfg) {
    log.warn('MySQL 未配置，使用内存 Store（进程重启丢失数据）');
    return new MemoryStore();
  }
  const pool = createMysqlPool(cfg);
  try {
    // Check existing user provenance before any migration can rewrite the database.
    await assertExistingIdentitySourceCompatibility(pool, identity);
    await runMigrations(pool);
    await assertIdentityModeCompatibility(pool, identity);
    const db = createKysely(pool);
    log.info({ host: cfg.host, database: cfg.database, ...identity }, 'MySQL Store 就绪');
    return new MysqlStore(db);
  } catch (error) {
    await pool.promise().end();
    throw error;
  }
}
