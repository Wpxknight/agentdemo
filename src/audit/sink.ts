import { logger } from '../logger.js';
import type { AuthProviderKind, DeploymentMode } from '../auth/types.js';

const log = logger.child({ mod: 'audit' });

/** 审计事件类别。 */
export type AuditKind = 'policy' | 'kubectl' | 'sandbox' | 'usage' | 'auth' | 'mcp';

export interface AuditEvent {
  kind: AuditKind;
  /** 动作，如 allow / block / approve-required / exec。 */
  action: string;
  /** 归属租户（多租户隔离）。 */
  tenantId?: string;
  userId?: string;
  provider?: AuthProviderKind;
  deploymentMode?: DeploymentMode;
  runId?: string;
  correlationId?: string;
  sessionId?: string;
  cluster?: string;
  tool?: string;
  detail?: Record<string, unknown>;
  /** 由 sink 在落库时补充时间戳（避免脚本里取 Date）。 */
  at?: string;
}

/** 审计落地接口；S5 增加 MySQL 实现。 */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

/** 写日志的审计（默认）。 */
export class LogAuditSink implements AuditSink {
  async record(event: AuditEvent): Promise<void> {
    log.info(event, 'audit');
  }
}

/** 内存审计（测试用）。 */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
