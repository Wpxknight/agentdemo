import { describe, expect, it } from 'vitest';
import { readMysqlConfig } from '../src/config/mysql.js';
import { MemoryStore } from '../src/db/memory.js';
import { createStore } from '../src/db/index.js';
import type { Msg } from '../src/llm/types.js';
import type { RequestContext } from '../src/auth/types.js';
import { readFile } from 'node:fs/promises';

const ctxA: RequestContext = { tenantId: 't1', userId: 'u1', role: 'user' };
const ctxB: RequestContext = { tenantId: 't2', userId: 'u2', role: 'user' };

describe('readMysqlConfig', () => {
  const base = {
    MYSQL_HOST: 'db.internal',
    MYSQL_DATABASE: 'ai_ops',
    MYSQL_USER: 'ai_ops',
    MYSQL_PASSWORD_BASE64: Buffer.from('s3cr3t').toString('base64'),
  };

  it('decodes base64 password and applies defaults', () => {
    const cfg = readMysqlConfig(base)!;
    expect(cfg.password).toBe('s3cr3t');
    expect(cfg.port).toBe(3306);
    expect(cfg.poolSize).toBe(10);
    expect(cfg.ssl).toBe(false);
  });

  it('returns undefined when host absent', () => {
    expect(readMysqlConfig({})).toBeUndefined();
  });

  it('throws when database or user missing', () => {
    expect(() => readMysqlConfig({ MYSQL_HOST: 'h', MYSQL_USER: 'u' })).toThrow(/DATABASE/);
    expect(() => readMysqlConfig({ MYSQL_HOST: 'h', MYSQL_DATABASE: 'd' })).toThrow(/USER/);
  });

  it('parses ssl and numeric overrides', () => {
    const cfg = readMysqlConfig({ ...base, MYSQL_SSL: 'true', MYSQL_PORT: '3307', MYSQL_POOL_SIZE: '5' })!;
    expect(cfg.ssl).toBe(true);
    expect(cfg.port).toBe(3307);
    expect(cfg.poolSize).toBe(5);
  });

  it('rejects invalid port', () => {
    expect(() => readMysqlConfig({ ...base, MYSQL_PORT: 'abc' })).toThrow(/PORT/);
  });
});

describe('MysqlStore session summaries', () => {
  it('uses MariaDB 10.2-compatible row locking for manual Fire creation', async () => {
    const source = await readFile('src/db/mysql.ts', 'utf8');
    const start = source.indexOf('async createManualFire(');
    const end = source.indexOf('async listScheduledExecutions(', start);
    const createManualFireSource = source.slice(start, end);

    expect(createManualFireSource).toContain('.forUpdate()');
    expect(createManualFireSource).not.toContain('.skipLocked()');
  });

  it('sorts wide message rows in application memory instead of MySQL filesort', async () => {
    const source = await readFile('src/db/mysql.ts', 'utf8');
    const start = source.indexOf('async listSessions(');
    const end = source.indexOf('async countSessions(', start);
    const listSessionsSource = source.slice(start, end);

    expect(listSessionsSource).not.toContain(".orderBy('id', 'asc')");
    expect(listSessionsSource).toContain('rows.sort((a, b) => a.id - b.id);');
  });
});

describe('MemoryStore', () => {
  const msg = (role: Msg['role'], text: string): Msg => ({ role, text });

  it('appends and lists messages scoped by session', async () => {
    const s = new MemoryStore();
    await s.appendMessage(ctxA, 'a', msg('user', 'hi'));
    await s.appendMessage(ctxA, 'a', msg('assistant', 'hello'));
    await s.appendMessage(ctxA, 'b', msg('user', 'other'));

    const a = await s.listMessages(ctxA, 'a');
    expect(a.map((m) => m.text)).toEqual(['hi', 'hello']);
    expect(await s.listMessages(ctxA, 'b')).toHaveLength(1);
  });

  it('replaceMessages 整体替换会话历史且不影响其他会话', async () => {
    const s = new MemoryStore();
    await s.appendMessage(ctxA, 'a', msg('user', 'old-1'));
    await s.appendMessage(ctxA, 'a', msg('assistant', 'old-2'));
    await s.appendMessage(ctxA, 'b', msg('user', 'keep'));

    await s.replaceMessages(ctxA, 'a', [msg('user', 'summary'), msg('assistant', 'recent')]);

    expect((await s.listMessages(ctxA, 'a')).map((m) => m.text)).toEqual(['summary', 'recent']);
    expect((await s.listMessages(ctxA, 'b')).map((m) => m.text)).toEqual(['keep']);
  });

  it('isolates messages across tenants', async () => {
    const s = new MemoryStore();
    await s.appendMessage(ctxA, 'shared', msg('user', 'a-secret'));
    await s.appendMessage(ctxB, 'shared', msg('user', 'b-secret'));

    expect((await s.listMessages(ctxA, 'shared')).map((m) => m.text)).toEqual(['a-secret']);
    expect((await s.listMessages(ctxB, 'shared')).map((m) => m.text)).toEqual(['b-secret']);
  });

  it('creates empty sessions and updates their summaries when messages are appended', async () => {
    const s = new MemoryStore();

    const created = await s.createSession(ctxA, { sessionId: 'empty-1', title: '新会话' });
    expect(created).toMatchObject({
      sessionId: 'empty-1',
      title: '新会话',
      messageCount: 0,
      lastMessage: '',
    });
    expect(await s.listSessions(ctxA)).toEqual([
      expect.objectContaining({ sessionId: 'empty-1', title: '新会话', messageCount: 0 }),
    ]);

    await s.appendMessage(ctxA, 'empty-1', msg('user', '请巡检集群'));
    await s.appendMessage(ctxA, 'empty-1', msg('assistant', '巡检完成'));

    // 占位标题“新会话”被首条用户消息覆盖后锁定，后续消息不再改名
    await s.appendMessage(ctxA, 'empty-1', msg('user', '再看一下节点'));
    expect(await s.listSessions(ctxA)).toEqual([
      expect.objectContaining({
        sessionId: 'empty-1',
        title: '请巡检集群',
        lastMessage: '再看一下节点',
        messageCount: 3,
      }),
    ]);
    expect(await s.countSessions(ctxA)).toBe(1);
  });

  it('keeps explicitly named sessions from being renamed by user messages', async () => {
    const s = new MemoryStore();
    await s.createSession(ctxA, { sessionId: 'named-1', title: '每日巡检' });
    await s.appendMessage(ctxA, 'named-1', msg('user', '开始巡检'));

    expect(await s.listSessions(ctxA)).toEqual([
      expect.objectContaining({ sessionId: 'named-1', title: '每日巡检' }),
    ]);
  });

  it('upserts session summaries for legacy message-only sessions', async () => {
    const s = new MemoryStore();

    await s.appendMessage(ctxA, 'legacy-1', msg('user', '第一条用户消息会成为标题'));

    expect(await s.listSessions(ctxA)).toEqual([
      expect.objectContaining({
        sessionId: 'legacy-1',
        title: '第一条用户消息会成为标题',
        lastMessage: '第一条用户消息会成为标题',
        messageCount: 1,
      }),
    ]);
  });

  it('estimates context usage for a session', async () => {
    const s = new MemoryStore();
    await s.appendMessage(ctxA, 'ctx-1', msg('user', '1234567890'));
    await s.appendMessage(ctxA, 'ctx-1', msg('assistant', 'abcd'));

    const usage = await s.getSessionContextUsage(ctxA, 'ctx-1', 200000);

    expect(usage).toEqual({
      usedTokens: 4,
      maxTokens: 200000,
      estimated: true,
    });
  });

  it('records and filters audit events within tenant', async () => {
    const s = new MemoryStore();
    await s.record({ kind: 'kubectl', action: 'exec', tenantId: 't1', sessionId: 'a', cluster: 'dev' });
    await s.record({ kind: 'policy', action: 'block', tenantId: 't1', sessionId: 'a' });
    await s.record({ kind: 'kubectl', action: 'exec', tenantId: 't2', sessionId: 'b' });

    expect(await s.listAudit(ctxA, { sessionId: 'a' })).toHaveLength(2);
    expect(await s.listAudit(ctxA, { kind: 'kubectl' })).toHaveLength(1);
    expect(await s.listAudit(ctxB)).toHaveLength(1);
  });

  it('aggregates agent token usage for one tenant session without double-counting cache tokens', async () => {
    const s = new MemoryStore();
    await s.record({ kind: 'usage', action: 'agent', tenantId: 't1', sessionId: 'usage-a', detail: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 } });
    await s.record({ kind: 'usage', action: 'agent', tenantId: 't1', sessionId: 'usage-a', detail: { inputTokens: 50, outputTokens: 10 } });
    await s.record({ kind: 'usage', action: 'scheduler', tenantId: 't1', sessionId: 'usage-a', detail: { inputTokens: 999, outputTokens: 999 } });
    await s.record({ kind: 'usage', action: 'agent', tenantId: 't1', sessionId: 'usage-b', detail: { inputTokens: 500, outputTokens: 500 } });
    await s.record({ kind: 'usage', action: 'agent', tenantId: 't2', sessionId: 'usage-a', detail: { inputTokens: 800, outputTokens: 200 } });

    await expect(s.getSessionTokenUsage(ctxA, 'usage-a')).resolves.toEqual({ totalTokens: 185 });
    await expect(s.getSessionTokenUsage(ctxB, 'usage-a')).resolves.toEqual({ totalTokens: 1000 });
  });

  it('persists LLM settings per tenant', async () => {
    const s = new MemoryStore();
    await s.setLlmSettings(ctxA, {
      id: 'tenant-a',
      protocol: 'openai',
      baseURL: 'http://llm-a/v1',
      apiKey: 'plain-a-key',
      model: 'model-a',
      allowInsecureTls: true,
    });
    await s.setLlmSettings(ctxB, {
      id: 'tenant-b',
      protocol: 'anthropic',
      baseURL: 'http://llm-b',
      apiKey: 'plain-b-key',
      model: 'model-b',
    });

    expect(await s.getLlmSettings(ctxA)).toEqual({
      id: 'tenant-a',
      protocol: 'openai',
      baseURL: 'http://llm-a/v1',
      apiKey: 'plain-a-key',
      model: 'model-a',
      allowInsecureTls: true,
    });
    expect(await s.getLlmSettings(ctxB)).toEqual({
      id: 'tenant-b',
      protocol: 'anthropic',
      baseURL: 'http://llm-b',
      apiKey: 'plain-b-key',
      model: 'model-b',
    });
  });

  it('has a MySQL migration for tenant settings', async () => {
    const migration = await readFile('src/db/migrations/0001_baseline.sql', 'utf8');
    expect(migration).toContain('CREATE TABLE `tenant_settings`');
    expect(migration).toContain('tenant_id');
    expect(migration).toContain('setting_key');
  });

  it('has a MySQL index for tenant history ordering', async () => {
    const migration = await readFile('src/db/migrations/0001_baseline.sql', 'utf8');
    expect(migration).toContain('idx_messages_tenant_id');
    expect(migration).toContain('tenant_id');
    expect(migration).toContain('id');
  });

  it('has a MySQL migration for explicit sessions', async () => {
    const migration = await readFile('src/db/migrations/0001_baseline.sql', 'utf8');
    expect(migration).toContain('CREATE TABLE `sessions`');
    expect(migration).toContain('tenant_id');
    expect(migration).toContain('session_id');
    expect(migration).not.toContain('INSERT IGNORE INTO sessions');
  });

  it('lists sessions from the explicit sessions table', async () => {
    const source = await readFile('src/db/mysql.ts', 'utf8');
    expect(source).toContain("selectFrom('sessions')");
    // 会话表写入用 upsert，避免并发先查后写撞唯一键
    expect(source).toContain('onDuplicateKeyUpdate');
    // 消息内容 JSON 持久化并回读多模态内容块
    expect(source).toContain('contentBlocks: msg.contentBlocks');
    expect(source).toContain('contentBlocks: c.contentBlocks');
    // AI 运行耗时复用 messages.content JSON，无需新增数据库列。
    expect(source).toContain('durationMs: msg.durationMs');
    expect(source).toContain("typeof c.durationMs === 'number'");
  });

  it('roundtrips user contentBlocks through the memory store', async () => {
    const s = new MemoryStore();
    const withImage: Msg = {
      role: 'user',
      text: '看下这张截图',
      contentBlocks: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    };
    await s.appendMessage(ctxA, 'img-1', withImage);

    const [stored] = await s.listMessages(ctxA, 'img-1');
    expect(stored?.contentBlocks).toEqual([{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]);
  });
});

// 集成测试：仅在配置了真实 MySQL 时运行（如 docker）。
describe.runIf(Boolean(process.env.MYSQL_HOST))('MysqlStore (integration)', () => {
  it('migrates and roundtrips messages + audit', async () => {
    const store = await createStore(readMysqlConfig(), { deploymentMode: 'standalone', authProvider: 'local' });
    const sid = `it-${Date.now()}`;
    const ctx: RequestContext = { tenantId: 'it', userId: 'u', role: 'user' };
    await store.appendMessage(ctx, sid, { role: 'user', text: 'ping' });
    await store.appendMessage(ctx, sid, { role: 'assistant', text: 'pong' });
    await store.record({ kind: 'kubectl', action: 'exec', tenantId: 'it', sessionId: sid, cluster: 'dev' });

    expect((await store.listMessages(ctx, sid)).map((m) => m.text)).toEqual(['ping', 'pong']);
    expect(await store.listAudit(ctx, { sessionId: sid })).toHaveLength(1);
    await store.close();
  });

  it('projects explicit scheduler Fire lifecycle and tenant-scoped Durable Run data', async () => {
    const store = await createStore(readMysqlConfig(), { deploymentMode: 'standalone', authProvider: 'local' });
    const mysqlStore = store as import('../src/db/mysql.js').MysqlStore;
    const db = mysqlStore.database();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenantId = `sched-it-${suffix}`;
    const otherTenantId = `sched-other-${suffix}`;
    const userId = `user-${suffix}`;
    const taskId = Number((await db.insertInto('scheduled_tasks').values({
      tenant_id: tenantId, user_id: userId, session_id: `session-${suffix}`, title: 'projection',
      cron: '0 1 * * *', timezone: 'UTC', task: 'projection', pre_approved: 0, enabled: 1,
      deleted_at: null, next_run_at: new Date('2026-08-09T01:00:00.000Z'), last_run_at: null,
    }).executeTakeFirstOrThrow()).insertId);
    const pendingAt = new Date('2026-08-08T01:00:00.000Z');
    const fireAt = new Date('2026-08-08T02:00:00.000Z');
    const createdAt = new Date('2026-08-08T02:00:01.000Z');
    const updatedAt = new Date('2026-08-08T02:00:10.000Z');
    const startedAt = new Date('2026-08-08T02:00:03.000Z');
    const completedAt = new Date('2026-08-08T02:00:09.000Z');
    const runId = `run-${suffix}`;
    const pendingFireId = `pending-${suffix}`;
    const completedFireId = `completed-${suffix}`;

    try {
      await db.insertInto('scheduler_fires').values([{
        fire_id: pendingFireId, task_id: taskId, tenant_id: tenantId, actor_id: userId,
        session_id: `session-${suffix}`, fire_time: pendingAt, input_json: JSON.stringify([]),
        trigger_kind: 'manual', idempotency_key: `pending-${suffix}`, state: 'pending', attempts: 0,
        run_id: null, claim_token: null, claim_owner: null, lease_expires_at: null, retry_at: null,
        last_error: null, created_at: pendingAt, updated_at: pendingAt,
      }, {
        fire_id: completedFireId, task_id: taskId, tenant_id: tenantId, actor_id: userId,
        session_id: `session-${suffix}`, fire_time: fireAt, input_json: JSON.stringify([]),
        trigger_kind: 'cron', idempotency_key: null, state: 'completed', attempts: 4,
        run_id: runId, claim_token: null, claim_owner: null, lease_expires_at: null, retry_at: null,
        last_error: 'scheduler retry detail', created_at: createdAt, updated_at: updatedAt,
      }]).execute();
      await db.insertInto('agent_runs').values([{
        tenant_id: tenantId, run_id: runId, user_id: userId, session_id: `session-${suffix}`,
        kernel: 'pi', kernel_version: 'test', status: 'failed', waiting_reason: null, current_node: null,
        step_count: 7, input_tokens: 101, output_tokens: 23, cache_read_tokens: 11,
        cache_creation_tokens: 5, cost_usd: '0.125', limits_json: null, execution_json: null,
        error_message: 'durable run failed', started_at: startedAt, updated_at: completedAt,
        completed_at: completedAt, cancel_requested_at: null, lease_owner: null, lease_token: 2,
        lease_expires_at: null, append_closed_at: completedAt, created_at: createdAt,
      }, {
        tenant_id: otherTenantId, run_id: runId, user_id: `other-${userId}`, session_id: `other-${suffix}`,
        kernel: 'pi', kernel_version: 'test', status: 'succeeded', waiting_reason: null, current_node: null,
        step_count: 999, input_tokens: 999, output_tokens: 999, cache_read_tokens: 999,
        cache_creation_tokens: 999, cost_usd: '9.99', limits_json: null, execution_json: null,
        error_message: null, started_at: startedAt, updated_at: completedAt, completed_at: completedAt,
        cancel_requested_at: null, lease_owner: null, lease_token: 0, lease_expires_at: null,
        append_closed_at: completedAt, created_at: createdAt,
      }]).execute();

      const executions = await store.listScheduledExecutions({ tenantId, userId, role: 'user' }, taskId);
      expect(executions).toEqual([
        expect.objectContaining({
          fireId: completedFireId, runId, triggerKind: 'cron', fireTime: fireAt,
          fireState: 'completed', attempts: 4, lastError: 'scheduler retry detail',
          createdAt, updatedAt,
          run: {
            status: 'failed', startedAt, completedAt, errorMessage: 'durable run failed', stepCount: 7,
            usage: { inputTokens: 101, outputTokens: 23, cacheReadTokens: 11, cacheCreationTokens: 5, costUsd: 0.125 },
          },
        }),
        expect.objectContaining({
          fireId: pendingFireId, runId: pendingFireId, triggerKind: 'manual', fireTime: pendingAt,
          fireState: 'pending', attempts: 0, createdAt: pendingAt, updatedAt: pendingAt, run: null,
        }),
      ]);
    } finally {
      await db.deleteFrom('agent_runs').where('run_id', '=', runId).where('tenant_id', 'in', [tenantId, otherTenantId]).execute();
      await db.deleteFrom('scheduler_fires').where('task_id', '=', taskId).execute();
      await db.deleteFrom('scheduled_tasks').where('id', '=', taskId).execute();
      await store.close();
    }
  });
});

describe('MemoryStore appendMessages', () => {
  const ctx = { tenantId: 'tenant-a', userId: 'u1', role: 'user' as const };

  it('批量追加消息并用首条用户消息更新标题', async () => {
    const s = new MemoryStore();
    await s.appendMessages(ctx, 'batch-1', [
      { role: 'user', text: '批量落库的问题' },
      { role: 'assistant', text: '批量落库的回答' },
    ]);
    await s.appendMessages(ctx, 'batch-1', []); // 空批次为 no-op

    const messages = await s.listMessages(ctx, 'batch-1');
    expect(messages.map((m) => m.text)).toEqual(['批量落库的问题', '批量落库的回答']);
    const sessions = await s.listSessions(ctx);
    expect(sessions.find((x) => x.sessionId === 'batch-1')?.title).toContain('批量落库的问题');
  });
});
