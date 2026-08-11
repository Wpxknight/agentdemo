import mysql from 'mysql2/promise';
import { readMysqlConfig } from '../src/config/mysql.js';

const cfg = readMysqlConfig();
if (!cfg) throw new Error('MYSQL_HOST is required');
const deploymentMode = process.env.DEPLOYMENT_MODE ?? process.env.AIOP_DEPLOYMENT_MODE;
const authProvider = process.env.AUTH_PROVIDER ?? process.env.AIOP_AUTH_PROVIDER;
if (deploymentMode !== 'standalone' && deploymentMode !== 'aios-integrated') {
  throw new Error('DEPLOYMENT_MODE must be explicitly set to standalone or aios-integrated');
}
if (authProvider !== 'local' && authProvider !== 'oidc' && authProvider !== 'aios') {
  throw new Error('AUTH_PROVIDER must be explicitly set to local, oidc, or aios');
}
if ((deploymentMode === 'aios-integrated') !== (authProvider === 'aios')) {
  throw new Error('aios-integrated requires AUTH_PROVIDER=aios; standalone requires local or oidc');
}

const connection = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  database: cfg.database,
  user: cfg.user,
  password: cfg.password,
  ssl: cfg.ssl ? {} : undefined,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

const identityColumns = [
  ['sessions', 'user_id'], ['messages', 'user_id'], ['scheduled_tasks', 'user_id'],
  ['scheduler_fires', 'actor_id'], ['agent_runs', 'user_id'], ['agent_interactions', 'user_id'],
  ['agent_interactions', 'resolved_by'], ['user_credentials', 'user_id'],
] as const;

try {
  await connection.query('SET SESSION TRANSACTION READ ONLY');
  await connection.beginTransaction();
  const [columns] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME tableName, COLUMN_NAME columnName, COLUMN_TYPE columnType
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'users' AND COLUMN_NAME = 'id') OR COLUMN_NAME IN ('user_id','actor_id','resolved_by'))`,
  );
  const typeByColumn = new Map(columns.map((row) => [`${row.tableName}.${row.columnName}`, String(row.columnType)]));
  const usersType = typeByColumn.get('users.id');
  if (!usersType) throw new Error('users.id is missing');

  const exactUnsignedBigint = (type: string | undefined) => /^bigint(?:\(\d+\))? unsigned$/.test(type?.toLowerCase() ?? '');
  const legacy = !exactUnsignedBigint(usersType);
  const checks: Array<{ name: string; count: string }> = [];
  const [mapTables] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_id_migration_map'",
  );
  const hasMap = Number(mapTables[0]?.count ?? 0) === 1;
  if (hasMap) {
    const summaries = [
      ['map.null_identity', "SELECT COUNT(*) count FROM user_id_migration_map WHERE tenant_id='' OR old_id='' OR new_id IS NULL OR provider NOT IN ('local','oidc','aios')"],
      ['map.duplicate_old', 'SELECT COUNT(*) count FROM (SELECT tenant_id,old_id FROM user_id_migration_map GROUP BY tenant_id,old_id HAVING COUNT(*)<>1) d'],
      ['map.duplicate_new', 'SELECT COUNT(*) count FROM (SELECT new_id FROM user_id_migration_map GROUP BY new_id HAVING COUNT(*)<>1) d'],
      ['map.local_oidc_missing_user', `SELECT COUNT(*) count FROM user_id_migration_map m LEFT JOIN users u ON u.tenant_id=m.tenant_id AND ${legacy ? 'CAST(u.id AS CHAR)=m.old_id' : 'u.id=m.new_id'} WHERE m.provider IN ('local','oidc') AND u.id IS NULL`],
      ['map.local_oidc_provider_mismatch', `SELECT COUNT(*) count FROM user_id_migration_map m JOIN users u ON u.tenant_id=m.tenant_id AND ${legacy ? 'CAST(u.id AS CHAR)=m.old_id' : 'u.id=m.new_id'} WHERE m.provider IN ('local','oidc') AND u.auth_provider<>m.provider`],
      ['users.local_oidc_missing_map', `SELECT COUNT(*) count FROM users u LEFT JOIN user_id_migration_map m ON m.tenant_id=u.tenant_id AND ${legacy ? 'm.old_id=CAST(u.id AS CHAR)' : 'm.new_id=u.id'} WHERE u.auth_provider IN ('local','oidc') AND m.new_id IS NULL`],
    ] as const;
    for (const [name, sql] of summaries) {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(sql);
      checks.push({ name, count: String(rows[0]?.count ?? '0') });
    }
  } else if (!legacy && deploymentMode === 'standalone') {
    const [legacyArtifacts] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) count FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME IN ('user_id_migration_stages','users_legacy_string_ids','users_positive')`,
    );
    checks.push({
      name: 'map.required_for_migrated_database',
      count: String(legacyArtifacts[0]?.count ?? '0'),
    });
  }

  const expectedStoredProvider = authProvider === 'aios' ? undefined : authProvider;
  const [mixedIdentitySources] = await connection.query<mysql.RowDataPacket[]>(
    expectedStoredProvider
      ? 'SELECT COUNT(*) count FROM users WHERE auth_provider<>?'
      : "SELECT COUNT(*) count FROM users WHERE auth_provider IN ('local','oidc','aios')",
    expectedStoredProvider ? [expectedStoredProvider] : [],
  );
  checks.push({ name: 'users.mixed_identity_source', count: String(mixedIdentitySources[0]?.count ?? '0') });

  for (const [table, column] of identityColumns) {
    const nullable = table === 'agent_interactions' && column === 'resolved_by';
    if (!legacy) {
      const type = typeByColumn.get(`${table}.${column}`);
      checks.push({ name: `${table}.${column}.invalid_type`, count: exactUnsignedBigint(type) ? '0' : '1' });
    }
    const directAiosAllowance = deploymentMode === 'aios-integrated' && !legacy
      ? ` OR x.\`${column}\` > 0`
      : '';
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) count FROM \`${table}\` x LEFT JOIN users u ON u.tenant_id=x.tenant_id AND u.id=x.\`${column}\` WHERE ${nullable ? `x.\`${column}\` IS NOT NULL AND ` : ''}u.id IS NULL AND NOT (FALSE${directAiosAllowance})`,
    );
    checks.push({ name: `${table}.${column}.unmapped_orphans`, count: String(rows[0]?.count ?? '0') });
  }

  const [taskFire] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) count FROM scheduler_fires f JOIN scheduled_tasks t ON t.tenant_id=f.tenant_id AND t.id=f.task_id WHERE f.actor_id <> t.user_id',
  );
  checks.push({ name: 'scheduled_tasks.scheduler_fires.identity_mismatch', count: String(taskFire[0]?.count ?? '0') });
  const [fireRun] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) count FROM scheduler_fires f JOIN agent_runs r ON r.tenant_id=f.tenant_id AND r.run_id=f.run_id WHERE f.run_id IS NOT NULL AND f.actor_id <> r.user_id',
  );
  checks.push({ name: 'scheduler_fires.agent_runs.identity_mismatch', count: String(fireRun[0]?.count ?? '0') });

  const failed = checks.filter((check) => BigInt(check.count) !== 0n);
  console.log(JSON.stringify({ mode: legacy ? 'legacy' : 'positive-bigint', usersIdType: usersType, checks }, null, 2));
  if (failed.length) throw new Error(`user id migration preflight failed: ${failed.map((item) => item.name).join(', ')}`);
  await connection.rollback();
} finally {
  await connection.end();
}
