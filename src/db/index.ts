import { readFile, readdir } from 'node:fs/promises';
import { Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import type { Pool } from 'mysql2';
import { logger } from '../logger.js';
import type { MysqlConfig } from '../config/mysql.js';
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
export async function runMigrations(pool: Pool): Promise<void> {
  const conn = pool.promise();
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
    if (applied.has(version)) continue;
    const sql = await readFile(new URL(file, dir), 'utf8');
    await conn.query(sql);
    await conn.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [version, file]);
    log.info({ version, file }, 'migration applied');
    count++;
  }
  log.info({ applied: count, total: files.length }, 'migrations up to date');
}

/** 按配置创建 Store：有 MySQL 则迁移+MysqlStore，否则回落 MemoryStore。 */
export async function createStore(cfg: MysqlConfig | undefined): Promise<Store> {
  if (!cfg) {
    log.warn('MySQL 未配置，使用内存 Store（进程重启丢失数据）');
    return new MemoryStore();
  }
  const pool = createMysqlPool(cfg);
  await runMigrations(pool);
  const db = createKysely(pool);
  log.info({ host: cfg.host, database: cfg.database }, 'MySQL Store 就绪');
  return new MysqlStore(db);
}
