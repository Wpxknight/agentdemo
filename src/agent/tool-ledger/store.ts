import { createHash } from 'node:crypto';
import type { JsonValue, ToolResult } from '../../model/types.js';
import type { Store, ToolExecutionRecord } from '../../db/store.js';

export interface ToolExecutionIdentity {
  tenantId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: JsonValue;
}

export class RecoveryRequiredError extends Error {
  constructor(message = '工具执行状态未知，需要人工恢复') {
    super(message);
    this.name = 'RecoveryRequiredError';
  }
}

export class DurableToolLedger {
  constructor(private readonly store: Store) {}

  async begin(identity: ToolExecutionIdentity): Promise<
    | { action: 'execute' }
    | { action: 'reuse'; result: ToolResult }
  > {
    const argsDigest = digest(identity.args);
    const existing = await this.store.getToolExecution(identity.tenantId, identity.runId, identity.toolCallId);
    if (existing) {
      if (existing.toolName !== identity.toolName || existing.argsDigest !== argsDigest) {
        throw new Error('工具幂等键的名称或参数摘要不一致');
      }
      if (existing.status === 'completed' && existing.result) {
        return { action: 'reuse', result: existing.result };
      }
      if (existing.status !== 'recovery_required') {
        await this.store.updateToolExecution({ ...existing, status: 'recovery_required', updatedAt: new Date() });
      }
      throw new RecoveryRequiredError();
    }
    const now = new Date();
    const started: ToolExecutionRecord = {
      tenantId: identity.tenantId,
      runId: identity.runId,
      sessionId: identity.sessionId,
      toolCallId: identity.toolCallId,
      toolName: identity.toolName,
      argsDigest,
      status: 'started',
      startedAt: now,
      updatedAt: now,
    };
    if (!await this.store.putToolExecutionIfAbsent(started)) return this.begin(identity);
    return { action: 'execute' };
  }

  async complete(identity: ToolExecutionIdentity, result: ToolResult): Promise<void> {
    const existing = await this.store.getToolExecution(identity.tenantId, identity.runId, identity.toolCallId);
    if (!existing || existing.argsDigest !== digest(identity.args)) {
      throw new Error('工具执行记录不存在或参数摘要不一致');
    }
    const now = new Date();
    await this.store.updateToolExecution({
      ...existing,
      status: 'completed',
      result,
      completedAt: now,
      updatedAt: now,
    });
  }
}

function digest(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
