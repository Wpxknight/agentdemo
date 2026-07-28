import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readMysqlConfig } from '../src/config/mysql.js';
import { createStore } from '../src/db/index.js';
import type { MysqlStore } from '../src/db/mysql.js';

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

describe.runIf(Boolean(process.env.MYSQL_HOST))('MySQL runtime adapter integration', () => {
  it('commits a persisted turn snapshot containing bigint versions', async () => {
    const store = await createStore(readMysqlConfig()) as MysqlStore;
    const runtimeStore = store.agentRuntimeStore();
    const runId = `mysql-runtime-bigint-${Date.now()}`;
    const identity = { tenantId: 'it', runId };
    const now = new Date();
    await runtimeStore.runs.create({
      ...identity,
      actorId: 'user-a',
      sessionId: `session-${runId}`,
      kernel: 'pi',
      kernelVersion: '0.82.1',
      runtimeVersion: 'test',
      status: 'queued',
      leaseToken: 0n,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      createdAt: now,
      updatedAt: now,
    });
    const lease = await runtimeStore.runs.acquireLease(identity, 'worker-a', now, 10_000);
    const snapshot = {
      ...identity,
      attemptId: 'attempt-a',
      turnNo: 1,
      sessionVersion: 0n,
      identity: { tenantId: 'it', actorId: 'user-a', roles: ['user'] },
      modelBinding: { provider: 'fake', model: 'fake-1' },
      promptVersion: 'prompt-v1',
      toolSetVersion: 'tools-v1',
      policyVersion: 'policy-v1',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'ping' }] }],
      createdAt: now,
    };
    await runtimeStore.turns.createSnapshot(snapshot);

    await expect(runtimeStore.turns.commit({
      leaseOwner: 'worker-a',
      leaseToken: lease!.token,
      snapshot,
      commit: {
        ...identity,
        attemptId: 'attempt-a',
        turnNo: 1,
        commitId: 'commit-a',
        transcriptVersion: 1n,
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'pong' }] }],
        committedAt: new Date(now.getTime() + 1_000),
      },
      events: [],
      runStatus: 'succeeded',
    })).resolves.toMatchObject({ commitId: 'commit-a', transcriptVersion: 1n });

    await store.close();
  });
});
