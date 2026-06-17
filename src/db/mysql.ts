import type { Kysely } from 'kysely';
import type { Msg, Role } from '../model/types.js';
import type { AuditEvent } from '../audit/sink.js';
import type { Database } from './schema.js';
import type { AuditFilter, Store } from './store.js';

/** mysql2 对 JSON 列读出已是对象；写入是字符串。统一归一化。 */
function parseJson(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return v;
}

/** 基于 Kysely + mysql2 的持久化实现。 */
export class MysqlStore implements Store {
  constructor(private readonly db: Kysely<Database>) {}

  async appendMessage(sessionId: string, msg: Msg): Promise<void> {
    const content = JSON.stringify({
      text: msg.text,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
    });
    await this.db
      .insertInto('messages')
      .values({ session_id: sessionId, role: msg.role, content })
      .execute();
  }

  async listMessages(sessionId: string): Promise<Msg[]> {
    const rows = await this.db
      .selectFrom('messages')
      .select(['role', 'content'])
      .where('session_id', '=', sessionId)
      .orderBy('id', 'asc')
      .execute();

    return rows.map((r): Msg => {
      const c = (parseJson(r.content) ?? {}) as Partial<Msg>;
      return {
        role: r.role as Role,
        text: c.text,
        toolCalls: c.toolCalls,
        toolResults: c.toolResults,
      };
    });
  }

  async record(event: AuditEvent): Promise<void> {
    await this.db
      .insertInto('audit_events')
      .values({
        kind: event.kind,
        action: event.action,
        session_id: event.sessionId ?? null,
        cluster: event.cluster ?? null,
        tool: event.tool ?? null,
        detail: event.detail ? JSON.stringify(event.detail) : null,
      })
      .execute();
  }

  async listAudit(filter: AuditFilter = {}): Promise<AuditEvent[]> {
    let q = this.db
      .selectFrom('audit_events')
      .select(['kind', 'action', 'session_id', 'cluster', 'tool', 'detail', 'created_at'])
      .orderBy('id', 'asc');
    if (filter.sessionId) q = q.where('session_id', '=', filter.sessionId);
    if (filter.kind) q = q.where('kind', '=', filter.kind);
    if (filter.limit) q = q.limit(filter.limit);

    const rows = await q.execute();
    return rows.map((r): AuditEvent => ({
      kind: r.kind as AuditEvent['kind'],
      action: r.action,
      sessionId: r.session_id ?? undefined,
      cluster: r.cluster ?? undefined,
      tool: r.tool ?? undefined,
      detail: (parseJson(r.detail) as Record<string, unknown> | undefined) ?? undefined,
      at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  async close(): Promise<void> {
    await this.db.destroy(); // 关闭底层连接池
  }
}
