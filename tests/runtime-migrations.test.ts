import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrations = new URL('../src/db/migrations/', import.meta.url);

async function sql(name: string): Promise<string> {
  return (await readFile(new URL(name, migrations), 'utf8')).toLowerCase();
}

describe('durable runtime migrations', () => {
  it('adds attempts, immutable turn snapshots and turn commits', async () => {
    const source = await sql('0015_agent_attempts_and_turns.sql');
    expect(source).toContain('create table if not exists agent_run_attempts');
    expect(source).toContain('create table if not exists agent_turn_snapshots');
    expect(source).toContain('create table if not exists agent_turn_commits');
    expect(source).toContain('unique key uq_agent_turn_commit_id');
    for (const column of ['kernel_version', 'runtime_version', 'waiting_reason']) expect(source).toContain(column);
  });

  it('upgrades the tool ledger with stable logical identity and recovery facts', async () => {
    const source = await sql('0016_agent_tool_ledger_v2.sql');
    for (const column of [
      'attempt_id', 'turn_no', 'logical_call_id', 'idempotency_key', 'capability',
      'external_correlation_id', 'result_digest', 'approved_interaction_id',
    ]) expect(source).toContain(column);
    expect(source).toContain('unique key uq_agent_tool_logical_call');
  });

  it('backfills and constrains a per-run durable event sequence', async () => {
    const source = await sql('0017_agent_run_event_sequence.sql');
    expect(source).toContain('row_number() over');
    expect(source).toContain('modify column sequence bigint not null');
    expect(source).toContain('unique key uq_agent_run_event_sequence');
  });

  it('freezes historical LangGraph checkpoint tables after new traffic stops', async () => {
    const source = await sql('0019_langgraph_checkpoints_read_only.sql');
    expect(source).toContain('before insert on langgraph_checkpoints');
    expect(source).toContain('before update on langgraph_checkpoints');
    expect(source).toContain('before delete on langgraph_checkpoint_writes');
    expect(source).toContain("signal sqlstate '45000'");
  });

  it('registers the new tables and columns in the Kysely schema', async () => {
    const source = (await readFile(new URL('../schema.ts', migrations), 'utf8')).toLowerCase();
    for (const table of ['agentrunattemptstable', 'agentturnsnapshotstable', 'agentturncommitstable']) {
      expect(source).toContain(`interface ${table}`);
    }
    expect(source).toContain('agent_run_attempts:');
    expect(source).toContain('agent_turn_snapshots:');
    expect(source).toContain('agent_turn_commits:');
    expect(source).toContain('sequence: number');
  });
});
