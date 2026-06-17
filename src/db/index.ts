import { readFile } from 'node:fs/promises';
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

/** 执行 schema.sql 迁移（幂等）。 */
export async function runMigrations(pool: Pool): Promise<void> {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.promise().query(sql);
  log.info('migrations applied');
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
