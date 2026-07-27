import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sourceUrl = new URL('../packages/agent-runtime-mysql/src/index.ts', import.meta.url);

describe('MySQL runtime adapter contract', () => {
  it('keeps commit and event sequence allocation inside Kysely transactions', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    expect(source).toContain('transaction().execute');
    expect(source).toContain('.forUpdate()');
    expect(source).toContain("insertInto('agent_turn_commits')");
    expect(source).toContain("fn.max<number>('sequence')");
  });

  it('checks the lease owner and fencing token before a turn commit', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    expect(source).toContain('assertCommitLease');
    expect(source).toContain("where('lease_owner', '=', ownerId)");
    expect(source).toContain("where('lease_token', '=', Number(token))");
  });

  it('persists and maps every durable interaction identity and lifecycle field', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    for (const field of [
      'record.userId', 'record.sessionId', 'record.toolCallId', 'record.resolvedBy', 'record.expiresAt',
      'row.user_id', 'row.session_id', 'row.tool_call_id', 'row.resolved_by', 'row.expires_at',
    ]) expect(source).toContain(field);
    expect(source).not.toContain("user_id: '', session_id: ''");
    expect(source).not.toContain('tool_call_id: null');
  });
});
