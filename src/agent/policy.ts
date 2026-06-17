import type { ToolCall } from '../model/types.js';

/** dispatch 前的策略判定（S4 充实：读写分离 / dry-run / 审批 / 危险命令拦截）。 */
export interface PolicyDecision {
  blocked: boolean;
  reason?: string;
  needApproval?: boolean;
}

export interface PolicyMiddleware {
  check(call: ToolCall): Promise<PolicyDecision>;
}

/** 占位实现：放行一切。后续阶段替换为带 RBAC + 集群 ACL 的实现。 */
export class AllowAllPolicy implements PolicyMiddleware {
  async check(_call: ToolCall): Promise<PolicyDecision> {
    return { blocked: false };
  }
}
