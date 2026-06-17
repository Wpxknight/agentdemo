/**
 * MySQL 连接配置：全部走环境变量，密码经 base64 编码（注意：base64 是编码非加密）。
 * 应用无状态、可多副本；未配置 MYSQL_HOST 时返回 undefined（回落内存 Store）。
 */

export interface MysqlConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  poolSize: number;
}

type Env = Record<string, string | undefined>;

function decodeBase64(value: string | undefined): string {
  if (!value) return '';
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseBool(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/** 读取 MySQL 配置；未设置 MYSQL_HOST 返回 undefined。配置不完整则抛错。 */
export function readMysqlConfig(env: Env = process.env): MysqlConfig | undefined {
  const host = env.MYSQL_HOST?.trim();
  if (!host) return undefined;

  const database = env.MYSQL_DATABASE?.trim();
  const user = env.MYSQL_USER?.trim();
  if (!database) throw new Error('MYSQL_DATABASE 未配置');
  if (!user) throw new Error('MYSQL_USER 未配置');

  const port = env.MYSQL_PORT ? Number(env.MYSQL_PORT) : 3306;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`MYSQL_PORT 非法: ${env.MYSQL_PORT}`);
  }
  const poolSize = env.MYSQL_POOL_SIZE ? Number(env.MYSQL_POOL_SIZE) : 10;
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new Error(`MYSQL_POOL_SIZE 非法: ${env.MYSQL_POOL_SIZE}`);
  }

  return {
    host,
    port,
    database,
    user,
    password: decodeBase64(env.MYSQL_PASSWORD_BASE64),
    ssl: parseBool(env.MYSQL_SSL),
    poolSize,
  };
}
