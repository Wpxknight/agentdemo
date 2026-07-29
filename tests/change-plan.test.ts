import { describe, expect, it } from 'vitest';
import { PlanApprovalState, parseChangePlan, renderChangePlan } from '../src/agent/plan.js';
import { buildChangePlanTool } from '../src/tools/change-plan.js';
import type { ChangePlan } from '../src/agent/plan.js';
import type { JsonValue } from '../src/llm/types.js';

const valid = {
  summary: '扩容 aiop-server',
  changes: [{ action: 'scale', target: 'prod/deploy/aiop-server', detail: '2→4' }],
  impact: 'prod 命名空间 aiop-server 短时滚动',
  rollback: 'kubectl scale --replicas=2',
} as unknown as JsonValue;

describe('parseChangePlan', () => {
  it('accepts a well-formed plan and renders it', () => {
    const plan = parseChangePlan(valid);
    expect(plan.changes).toHaveLength(1);
    expect(renderChangePlan(plan)).toContain('回滚方式：kubectl scale');
  });
  it('rejects missing fields', () => {
    expect(() => parseChangePlan({ summary: 'x', changes: [], impact: 'a', rollback: 'b' })).toThrow('changes');
    expect(() => parseChangePlan({ summary: '', changes: [{ action: 'a', target: 'b' }], impact: 'i', rollback: 'r' })).toThrow('summary');
  });
});

describe('PlanApprovalState', () => {
  it('tracks approval per session', () => {
    const s = new PlanApprovalState();
    expect(s.isApproved('s1')).toBe(false);
    s.approve('s1');
    expect(s.isApproved('s1')).toBe(true);
    expect(s.isApproved('s2')).toBe(false);
    s.clear('s1');
    expect(s.isApproved('s1')).toBe(false);
  });
});

describe('submit_change_plan tool', () => {
  it('errors without an interactive endpoint', async () => {
    const res = await buildChangePlanTool().run(valid, { sessionId: 's1' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('无交互端');
  });
  it('returns approved plan text when approved', async () => {
    const res = await buildChangePlanTool().run(valid, {
      sessionId: 's1',
      requestPlanApproval: async (_p: ChangePlan) => true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('已批准');
  });
  it('returns error when rejected', async () => {
    const res = await buildChangePlanTool().run(valid, {
      sessionId: 's1',
      requestPlanApproval: async () => false,
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('未获批准');
  });
});
