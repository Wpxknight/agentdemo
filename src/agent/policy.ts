import type { ToolCall } from '../model/types.js';
import type { ToolContext } from './tools.js';
import type { ClusterRegistry } from '../config/clusters.js';
import type { AuditSink } from '../audit/sink.js';
import { LogAuditSink } from '../audit/sink.js';
import { classifyKubectl, parseKubectlArgs } from '../ops/classify.js';

/** dispatch 前的策略判定（读写分离 / dry-run / 审批 / 危险命令拦截）。 */
export interface PolicyDecision {
  blocked: boolean;
  reason?: string;
  needApproval?: boolean;
}

export interface PolicyMiddleware {
  check(call: ToolCall, ctx?: ToolContext): Promise<PolicyDecision>;
}

/** 占位实现：放行一切（仅测试 / 本地）。 */
export class AllowAllPolicy implements PolicyMiddleware {
  async check(_call: ToolCall): Promise<PolicyDecision> {
    return { blocked: false };
  }
}

export interface OpsPolicyOptions {
  clusters: ClusterRegistry;
  audit?: AuditSink;
  /** 定时任务等无人值守场景：预批准，把 needApproval 降级为放行。 */
  preApproved?: boolean;
  /** sbx__run_command 高危 shell 拦截开关，默认开。 */
  guardShell?: boolean;
}

/** rm -rf / 之类的高危 shell 片段。 */
const DANGEROUS_SHELL = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /:\(\)\s*\{.*\}\s*;/, // fork bomb
  /\b(shutdown|reboot|halt)\b/,
];

/**
 * 运维策略：kubectl 读写分离 + 危险命令拦截 + 生产审批；
 * 高危 shell 拦截；所有判定写审计。
 */
export class OpsPolicy implements PolicyMiddleware {
  private readonly clusters: ClusterRegistry;
  private readonly audit: AuditSink;
  private readonly preApproved: boolean;
  private readonly guardShell: boolean;

  constructor(opts: OpsPolicyOptions) {
    this.clusters = opts.clusters;
    this.audit = opts.audit ?? new LogAuditSink();
    this.preApproved = opts.preApproved ?? false;
    this.guardShell = opts.guardShell ?? true;
  }

  async check(call: ToolCall, ctx?: ToolContext): Promise<PolicyDecision> {
    if (call.name === 'kubectl') return this.checkKubectl(call, ctx);
    if (call.name === 'sbx__run_command' && this.guardShell) {
      return this.checkShell(call, ctx);
    }
    return { blocked: false };
  }

  private async emit(
    action: string,
    decision: PolicyDecision,
    extra: { sessionId?: string; cluster?: string; tool?: string; detail?: Record<string, unknown> },
  ): Promise<PolicyDecision> {
    await this.audit.record({ kind: 'policy', action, ...extra });
    return decision;
  }

  private async checkKubectl(call: ToolCall, ctx?: ToolContext): Promise<PolicyDecision> {
    const { cluster, args } = parseKubectlArgs(call.args);
    const sessionId = ctx?.sessionId;

    if (!cluster) {
      return this.emit('block', { blocked: true, reason: '缺少 cluster 参数' }, {
        sessionId, tool: 'kubectl',
      });
    }
    const info = this.clusters.get(cluster);
    if (!info) {
      return this.emit('block', { blocked: true, reason: `未知集群: ${cluster}` }, {
        sessionId, cluster, tool: 'kubectl',
      });
    }

    const cls = classifyKubectl(args);
    const base = { sessionId, cluster, tool: 'kubectl', detail: { verb: cls.verb, write: cls.write } };

    if (cls.dangerous) {
      return this.emit('block', { blocked: true, reason: `危险命令被拦截：${cls.reason}` }, base);
    }
    if (cls.write && info.access === 'ro') {
      return this.emit('block', { blocked: true, reason: `集群 ${cluster} 为只读，拒绝变更（${cls.verb}）` }, base);
    }
    if (cls.write && info.production) {
      if (this.preApproved) {
        return this.emit('allow', { blocked: false }, { ...base, detail: { ...base.detail, preApproved: true } });
      }
      return this.emit('approve-required', { blocked: false, needApproval: true }, base);
    }
    return this.emit('allow', { blocked: false }, base);
  }

  private async checkShell(call: ToolCall, ctx?: ToolContext): Promise<PolicyDecision> {
    const o = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
    const command = typeof (o as Record<string, unknown>).command === 'string'
      ? ((o as Record<string, unknown>).command as string)
      : '';
    if (DANGEROUS_SHELL.some((re) => re.test(command))) {
      return this.emit('block', { blocked: true, reason: '高危 shell 命令被拦截' }, {
        sessionId: ctx?.sessionId, tool: 'sbx__run_command', detail: { command },
      });
    }
    return { blocked: false };
  }
}
