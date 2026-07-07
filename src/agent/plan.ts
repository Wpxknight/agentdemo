/** 一个结构化变更方案（submit_change_plan 工具的输入）。 */
export interface ChangePlan {
  /** 变更目标的一句话概述。 */
  summary: string;
  /** 具体变更项。 */
  changes: { action: string; target: string; detail?: string }[];
  /** 影响面说明（受影响的服务/命名空间/用户等）。 */
  impact: string;
  /** 回滚方式。 */
  rollback: string;
}

/**
 * 变更计划审批状态（进程内、按会话）：
 * 用户批准某个变更方案后，该会话内的生产变更操作在策略层批量放行（跳过逐条审批），
 * 直到会话结束。未批准方案时，生产变更仍走原有逐条审批。
 */
export class PlanApprovalState {
  private readonly approved = new Set<string>();

  approve(sessionId: string): void {
    if (sessionId) this.approved.add(sessionId);
  }

  isApproved(sessionId?: string): boolean {
    return Boolean(sessionId && this.approved.has(sessionId));
  }

  clear(sessionId: string): void {
    this.approved.delete(sessionId);
  }
}

/** 校验并规整 submit_change_plan 的输入。 */
export function parseChangePlan(raw: unknown): ChangePlan {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!summary) throw new Error('summary 必填');
  const impact = typeof o.impact === 'string' ? o.impact.trim() : '';
  if (!impact) throw new Error('impact（影响面）必填');
  const rollback = typeof o.rollback === 'string' ? o.rollback.trim() : '';
  if (!rollback) throw new Error('rollback（回滚方式）必填');
  const rawChanges = Array.isArray(o.changes) ? o.changes : [];
  if (!rawChanges.length) throw new Error('changes 至少一项');
  const changes = rawChanges.map((c) => {
    const cc = c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
    const action = typeof cc.action === 'string' ? cc.action.trim() : '';
    const target = typeof cc.target === 'string' ? cc.target.trim() : '';
    if (!action || !target) throw new Error('每个 change 须有 action 与 target');
    return { action, target, detail: typeof cc.detail === 'string' ? cc.detail : undefined };
  });
  return { summary, changes, impact, rollback };
}

/** 渲染变更方案为可读文本（供审批展示 / 回填模型）。 */
export function renderChangePlan(plan: ChangePlan): string {
  const items = plan.changes.map((c, i) => `${i + 1}. [${c.action}] ${c.target}${c.detail ? ` — ${c.detail}` : ''}`);
  return [
    `变更概述：${plan.summary}`,
    '',
    '变更项：',
    ...items,
    '',
    `影响面：${plan.impact}`,
    `回滚方式：${plan.rollback}`,
  ].join('\n');
}
