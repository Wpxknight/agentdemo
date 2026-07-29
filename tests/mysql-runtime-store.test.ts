import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readMysqlConfig } from '../src/config/mysql.js';
import { createStore } from '../src/db/index.js';
import type { MysqlStore } from '../src/db/mysql.js';

const sourceUrl = new URL('../packages/pi-runtime/src/store/runtime-mysql.ts', import.meta.url);
const mysqlStoreSourceUrl = new URL('../src/db/mysql.ts', import.meta.url);

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

  it('locks the run row while asserting a transaction-scoped lease', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    const method = source.slice(
      source.indexOf('assertLease: async'),
      source.indexOf('readonly attempts ='),
    );
    expect(method).toContain('.forUpdate()');
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

  it('claims a pending approval with one conditional atomic update', async () => {
    const source = await readFile(sourceUrl, 'utf8');
    const method = source.slice(
      source.indexOf('claimPendingApproval:'),
      source.indexOf('readonly events ='),
    );
    for (const predicate of [
      "where('status', '=', 'pending_approval')",
      "where('attempt_id', '=', input.attemptId)",
      "where('turn_no', '=', input.turnNo)",
      "where('tool_call_id', '=', input.toolCallId)",
      "where('tool_name', '=', input.toolName)",
      "where('args_digest', '=', input.argsDigest)",
      "where('approved_interaction_id', '=', input.approvedInteractionId)",
    ]) expect(method).toContain(predicate);
    expect(method).toContain('numUpdatedRows');
  });
});

describe('MySQL Run Center query contract', () => {
  it('lists committed turns in indexed transcript order', async () => {
    const source = await readFile(mysqlStoreSourceUrl, 'utf8');
    const method = source.slice(
      source.indexOf('async listAgentRunTurns'),
      source.indexOf('async listAgentRunInteractions'),
    );

    expect(method).toContain("orderBy('transcript_version', 'asc')");
    expect(method).not.toContain("orderBy('turn_no', 'asc')");
  });
});

describe.runIf(Boolean(process.env.MYSQL_HOST))('MySQL runtime adapter integration', () => {
  it('prevents a concurrent lease takeover until a fenced ledger transaction commits', async () => {
    const store = await createStore(readMysqlConfig()) as MysqlStore;
    const runtimeStore = store.agentRuntimeStore();
    const runId = `mysql-runtime-ledger-fence-${Date.now()}`;
    const identity = { tenantId: 'it', runId };
    const now = new Date();
    let releaseWrite!: () => void;
    let locked!: () => void;
    const mayWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const rowLocked = new Promise<void>((resolve) => { locked = resolve; });
    try {
      await runtimeStore.runs.create({
        ...identity, actorId: 'user-a', sessionId: `session-${runId}`, kernel: 'pi', kernelVersion: '0.82.1',
        runtimeVersion: 'test', status: 'running', leaseToken: 0n,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        createdAt: now, updatedAt: now,
      });
      const lease = await runtimeStore.runs.acquireLease(identity, 'worker-a', now, 1_000);
      const staleWrite = runtimeStore.transaction(async (tx) => {
        await tx.runs.assertLease(identity, 'worker-a', lease!.token, new Date(now.getTime() + 500));
        locked();
        await mayWrite;
        await tx.toolLedger.putIfAbsent({
          ...identity, attemptId: 'attempt-a', turnNo: 1, logicalCallId: 'logical-a', toolCallId: 'call-a',
          toolName: 'deploy', argsDigest: 'digest', capability: 'non_idempotent_write', idempotencyKey: 'key-a',
          status: 'started', createdAt: now, updatedAt: now,
        });
      });
      await rowLocked;
      let takeoverFinished = false;
      const takeover = runtimeStore.runs.acquireLease(identity, 'worker-b', new Date(now.getTime() + 2_000), 1_000)
        .then((value) => { takeoverFinished = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(takeoverFinished).toBe(false);
      releaseWrite();
      await staleWrite;
      await expect(takeover).resolves.toMatchObject({ ownerId: 'worker-b' });
    } finally {
      releaseWrite?.();
      await store.database().deleteFrom('agent_tool_executions')
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', runId).execute();
      await store.database().deleteFrom('agent_runs')
        .where('tenant_id', '=', identity.tenantId).where('run_id', '=', runId).execute();
      await store.close();
    }
  });

  it('commits a persisted turn snapshot containing bigint versions', async () => {
    const store = await createStore(readMysqlConfig()) as MysqlStore;
    const runtimeStore = store.agentRuntimeStore();
    const runId = `mysql-runtime-bigint-${Date.now()}`;
    const commitId = `commit-${runId}`;
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
        commitId,
        transcriptVersion: 1n,
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'pong' }] }],
        committedAt: new Date(now.getTime() + 1_000),
      },
      events: [],
      runStatus: 'succeeded',
    })).resolves.toMatchObject({ commitId, transcriptVersion: 1n });

    await store.close();
  });
});
