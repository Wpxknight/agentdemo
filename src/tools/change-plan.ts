import type { JsonValue, ToolResult } from '../model/types.js';
import type { ChangePlan } from '../agent/plan.js';
import { parseChangePlan, renderChangePlan } from '../agent/plan.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';

/**
 * submit_change_plan 工具（借鉴 Claude Code 计划模式）：
 * 执行生产变更前，先提交结构化变更方案（变更项 / 影响面 / 回滚方式）供用户审批。
 * 审批通过后，本会话内的生产变更操作在策略层批量放行（不再逐条弹审批）；
 * 被拒则模型据反馈调整或终止。需交互端（ctx.requestPlanApproval）。
 */
export function buildChangePlanTool(): ToolHandler {
  return {
    def: {
      name: 'submit_change_plan',
      capability: 'read',
      description:
        '提交结构化变更方案供用户审批（用于生产环境变更前）。'
        + '包含 summary、changes[]、impact（影响面）、rollback（回滚方式）。'
        + '批准后本会话内的生产变更将批量放行；请在执行任何生产变更前调用。',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '变更目标一句话概述' },
          changes: {
            type: 'array',
            description: '具体变更项',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', description: '动作，如 scale/restart/apply/delete' },
                target: { type: 'string', description: '目标对象，如 prod/deploy/aiop-server' },
                detail: { type: 'string', description: '细节（可选）' },
              },
              required: ['action', 'target'],
            },
          },
          impact: { type: 'string', description: '影响面：受影响的服务/命名空间/用户等' },
          rollback: { type: 'string', description: '回滚方式' },
        },
        required: ['summary', 'changes', 'impact', 'rollback'],
      },
    },
    async run(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
      let plan: ChangePlan;
      try {
        plan = parseChangePlan(args);
      } catch (err) {
        return { id: '', content: `变更方案格式错误：${String(err instanceof Error ? err.message : err)}`, isError: true };
      }
      if (!ctx.requestPlanApproval) {
        return {
          id: '',
          content: '当前运行无交互端，无法审批变更方案。请勿在无人值守下执行生产变更。',
          isError: true,
        };
      }
      const approved = await ctx.requestPlanApproval(plan);
      const rendered = renderChangePlan(plan);
      if (!approved) {
        return { id: '', content: `变更方案未获批准（用户拒绝或运行中止）。\n\n${rendered}`, isError: true };
      }
      return { id: '', content: `变更方案已批准，本会话内生产变更将批量放行。\n\n${rendered}` };
    },
  };
}
