import { logger } from '../logger.js';
import { runAgent } from '../agent/core.js';
import { estimateCost } from '../model/cost.js';
import { contextBudgetTokens } from '../agent/context.js';
import { AutoDenyGate } from '../agent/approval.js';
import { boundUserHomeNote } from '../sandbox/userhome.js';
import { SANDBOX_SERVICE_NOTE } from '../sandbox/notes.js';
import type { Runtime } from '../runtime.js';
import { DEFAULT_TASK_MAX_RUN_MS, type ScheduledTask } from '../db/store.js';
import { Scheduler, type TaskRunner } from './ticker.js';

type Env = Record<string, string | undefined>;

export function shouldEmbedScheduler(env: Env = process.env): boolean {
  const value = env.AIOP_EMBED_SCHEDULER?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

export function createScheduledTaskRunner(rt: Runtime): TaskRunner {
  return async (t: ScheduledTask) => {
    logger.info({ taskId: t.id, tenantId: t.tenantId, sessionId: t.sessionId }, 'running scheduled task');
    const taskCtx = { tenantId: t.tenantId, userId: t.userId, role: 'user' as const };
    // 最长运行时长兜底：无人值守没人能按终止，超时中止并记录失败（默认 4 小时，租户可在设置页调整）。
    const maxRunMs = (await rt.store.getSchedulerSettings({ tenantId: t.tenantId }))?.maxRunMs ?? DEFAULT_TASK_MAX_RUN_MS;
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new Error(`定时任务超过最长运行时长（${Math.round(maxRunMs / 60000)} 分钟），已中止`)),
      maxRunMs,
    );
    timer.unref?.();
    try {
      return await runScheduledTask(rt, t, taskCtx, abort.signal);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function runScheduledTask(
  rt: Runtime,
  t: ScheduledTask,
  taskCtx: { tenantId: string; userId: string; role: 'user' },
  signal: AbortSignal,
): Promise<{ status: 'success'; detail: string; steps: number }> {
  const prior = await rt.store.listMessages(taskCtx, t.sessionId);
  // 用户绑定了主目录：与交互链路一致，告知模型挂载点、交付物默认写入持久化目录。
  const userHomeNote = rt.sandboxSettings?.enabled && rt.userHome
    ? await boundUserHomeNote(rt.store, t.tenantId, t.userId, rt.userHome)
    : '';
  const result = await runAgent({
    model: rt.model,
    tools: rt.tools,
    policy: t.preApproved ? rt.policyPreApproved : rt.policy,
    filterToolDefs: (defs) => rt.permissionRules?.filterToolDefs(defs) ?? defs,
    hooks: rt.hooks,
    approval: new AutoDenyGate(), // 无人值守：未预批准的审批一律拒绝
    unattended: true, // 系统提示切换为“确认类操作跳过并汇报”，不对着空气等确认
    // 技能摘要按任务归属用户过滤（他人私有技能不可见），与交互链路同一套可见性规则。
    system: [
      rt.skillRegistry?.summariesFor({ userId: t.userId, role: taskCtx.role }) ?? rt.systemExtra,
      rt.sandboxSettings?.enabled ? SANDBOX_SERVICE_NOTE : '',
      userHomeNote,
    ].filter(Boolean).join('\n\n'),
    ctx: { sessionId: t.sessionId, ...taskCtx },
    messages: prior,
    task: t.task,
    // 定时任务复用同一会话、历史只增不减，同样必须受上下文预算约束，否则迟早超窗 400。
    contextBudgetTokens: contextBudgetTokens(rt.modelConfig?.contextWindowTokens),
    keepImages: rt.modelConfig?.contextKeepImages,
    signal,
  });
  await rt.store.appendMessages(taskCtx, t.sessionId, result.messages.slice(prior.length));
  await rt.audit.record({
    kind: 'usage',
    action: 'scheduled',
    tenantId: t.tenantId,
    sessionId: t.sessionId,
    detail: { ...result.usage, steps: result.steps, taskId: t.id, cost: estimateCost(result.usage, rt.modelConfig?.pricing) },
  });
  return { status: 'success' as const, detail: result.text.slice(0, 4000), steps: result.steps };
}

export function startRuntimeScheduler(rt: Runtime): Scheduler {
  const scheduler = new Scheduler({ store: rt.store, runner: createScheduledTaskRunner(rt) });
  scheduler.start();
  return scheduler;
}
