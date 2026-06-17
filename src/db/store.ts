import type { Msg } from '../model/types.js';
import type { AuditEvent, AuditSink } from '../audit/sink.js';

/** 审计查询过滤。 */
export interface AuditFilter {
  sessionId?: string;
  kind?: string;
  limit?: number;
}

/**
 * 持久化抽象：会话消息 + 审计。Store 同时实现 AuditSink，
 * 可直接作为审计落地。MySQL / 内存两种实现。
 */
export interface Store extends AuditSink {
  appendMessage(sessionId: string, msg: Msg): Promise<void>;
  listMessages(sessionId: string): Promise<Msg[]>;
  record(event: AuditEvent): Promise<void>;
  listAudit(filter?: AuditFilter): Promise<AuditEvent[]>;
  close(): Promise<void>;
}
