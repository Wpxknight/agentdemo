import type { ToolCall } from '../model/types.js';
import type { ToolContext } from './tools.js';

export interface ApprovalRequest {
  call: ToolCall;
  reason?: string;
  ctx: ToolContext;
}

/**
 * 审批门：当 Policy 判定 needApproval 时，由 gate 决定放行与否。
 * HTTP 服务可实现交互式 gate（暂停 loop、推 diff、等确认续跑）。
 */
export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<boolean>;
}

/** 默认拒绝（无人值守且未预批准时的安全默认）。 */
export class AutoDenyGate implements ApprovalGate {
  async request(): Promise<boolean> {
    return false;
  }
}

/** 自动批准（测试 / 受信环境）。 */
export class AutoApproveGate implements ApprovalGate {
  async request(): Promise<boolean> {
    return true;
  }
}

/** 用回调实现的审批门（便于 HTTP 层接入人工确认）。 */
export class CallbackGate implements ApprovalGate {
  constructor(private readonly fn: (req: ApprovalRequest) => Promise<boolean>) {}
  request(req: ApprovalRequest): Promise<boolean> {
    return this.fn(req);
  }
}
