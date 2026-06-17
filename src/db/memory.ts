import type { Msg } from '../model/types.js';
import type { AuditEvent } from '../audit/sink.js';
import type { AuditFilter, Store } from './store.js';

/** 内存 Store：未配置 MySQL 时的回落实现，亦用于测试。 */
export class MemoryStore implements Store {
  private messages = new Map<string, Msg[]>();
  private audit: AuditEvent[] = [];

  async appendMessage(sessionId: string, msg: Msg): Promise<void> {
    const list = this.messages.get(sessionId) ?? [];
    list.push(msg);
    this.messages.set(sessionId, list);
  }

  async listMessages(sessionId: string): Promise<Msg[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async record(event: AuditEvent): Promise<void> {
    this.audit.push({ ...event });
  }

  async listAudit(filter: AuditFilter = {}): Promise<AuditEvent[]> {
    let rows = this.audit;
    if (filter.sessionId) rows = rows.filter((e) => e.sessionId === filter.sessionId);
    if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
    const out = [...rows];
    return filter.limit ? out.slice(-filter.limit) : out;
  }

  async close(): Promise<void> {
    this.messages.clear();
    this.audit = [];
  }
}
