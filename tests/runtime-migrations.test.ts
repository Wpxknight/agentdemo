import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/index.js';

const migrations = new URL('../src/db/migrations/', import.meta.url);

describe('fresh database baseline', () => {
  it('ships one current schema without upgrade compatibility', async () => {
    const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql'));
    expect(files).toEqual(['0001_baseline.sql']);

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

  it('applies and records the baseline as version 1', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const connection = {
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        if (sql === 'SELECT version FROM schema_migrations') return [[], []];
        return [[], []];
      },
      release() {},
    };

    await runMigrations({ promise: () => ({ getConnection: async () => connection }) } as never);

    const recorded = statements.find(({ sql }) => sql.startsWith('INSERT INTO schema_migrations'));
    expect(recorded?.values).toEqual([1, '0001_baseline.sql']);
    expect(statements.some(({ sql }) => sql.includes('CREATE TABLE `agent_runs`'))).toBe(true);
  });

  it('keeps the Kysely schema aligned with the baseline', async () => {
    const source = (await readFile(new URL('../schema.ts', migrations), 'utf8')).toLowerCase();
    for (const table of ['agent_run_attempts:', 'agent_turn_snapshots:', 'agent_turn_commits:', 'scheduler_fires:']) {
      expect(source).toContain(table);
    }
    expect(source).not.toMatch(/langgraph|graph_name|graph_version|runtime_version/);
  });
});
