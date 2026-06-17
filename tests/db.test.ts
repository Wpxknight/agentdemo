import { describe, expect, it } from 'vitest';
import { readMysqlConfig } from '../src/config/mysql.js';
import { MemoryStore } from '../src/db/memory.js';
import { createStore } from '../src/db/index.js';
import type { Msg } from '../src/model/types.js';
import type { RequestContext } from '../src/auth/types.js';

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

  it('isolates messages across tenants', async () => {
    const s = new MemoryStore();
    await s.appendMessage(ctxA, 'shared', msg('user', 'a-secret'));
    await s.appendMessage(ctxB, 'shared', msg('user', 'b-secret'));

    expect((await s.listMessages(ctxA, 'shared')).map((m) => m.text)).toEqual(['a-secret']);
    expect((await s.listMessages(ctxB, 'shared')).map((m) => m.text)).toEqual(['b-secret']);
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
});

// 集成测试：仅在配置了真实 MySQL 时运行（如 docker）。
describe.runIf(Boolean(process.env.MYSQL_HOST))('MysqlStore (integration)', () => {
  it('migrates and roundtrips messages + audit', async () => {
    const store = await createStore(readMysqlConfig());
    const sid = `it-${Date.now()}`;
    const ctx: RequestContext = { tenantId: 'it', userId: 'u', role: 'user' };
    await store.appendMessage(ctx, sid, { role: 'user', text: 'ping' });
    await store.appendMessage(ctx, sid, { role: 'assistant', text: 'pong' });
    await store.record({ kind: 'kubectl', action: 'exec', tenantId: 'it', sessionId: sid, cluster: 'dev' });

    expect((await store.listMessages(ctx, sid)).map((m) => m.text)).toEqual(['ping', 'pong']);
    expect(await store.listAudit(ctx, { sessionId: sid })).toHaveLength(1);
    await store.close();
  });
});
