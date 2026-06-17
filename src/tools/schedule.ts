import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import { reqContext } from '../agent/tools.js';
import type { Store } from '../db/store.js';
import { isValidCron } from '../scheduler/cron.js';

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

/**
 * 定时任务工具：用户对话式创建/查看/取消定时任务。
 * 任务存 DB，由调度器到点触发 runAgent 执行并记录结果。
 */
export function buildScheduleTools(store: Store): ToolHandler[] {
  return [
    {
      def: {
        name: 'schedule_task',
        description:
          '创建定时任务：给定 cron 表达式与任务描述，调度器将到点自动执行（如“每天1点巡检”→ cron "0 1 * * *"）。preApproved=true 时无人值守执行可自动通过生产审批。',
        inputSchema: {
          type: 'object',
          properties: {
            cron: { type: 'string', description: '标准 5 段 cron 表达式，如 "0 1 * * *"' },
            task: { type: 'string', description: '到点要执行的任务描述（自然语言）' },
            preApproved: { type: 'boolean', description: '无人值守预批准（默认 false）' },
          },
          required: ['cron', 'task'],
        },
      },
      async run(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const cron = typeof o.cron === 'string' ? o.cron : '';
        const task = typeof o.task === 'string' ? o.task : '';
        if (!cron || !task) return { id: '', content: 'cron 与 task 均必填', isError: true };
        if (!isValidCron(cron)) return { id: '', content: `非法 cron 表达式: ${cron}`, isError: true };

        const created = await store.createScheduledTask(reqContext(ctx), {
          sessionId: ctx.sessionId,
          cron,
          task,
          preApproved: o.preApproved === true,
        });
        return {
          id: '',
          content: `已创建定时任务 #${created.id}（cron=${cron}），下次执行：${created.nextRunAt.toISOString()}`,
        };
      },
    },
    {
      def: {
        name: 'list_scheduled_tasks',
        description: '列出当前会话的定时任务及其下次执行时间。',
        inputSchema: { type: 'object', properties: {} },
      },
      async run(_args, ctx: ToolContext): Promise<ToolResult> {
        const tasks = await store.listScheduledTasks(reqContext(ctx));
        if (!tasks.length) return { id: '', content: '（无定时任务）' };
        const lines = tasks.map(
          (t) =>
            `#${t.id} [${t.enabled ? '启用' : '停用'}] cron=${t.cron} 下次=${t.nextRunAt.toISOString()} — ${t.task}`,
        );
        return { id: '', content: lines.join('\n') };
      },
    },
    {
      def: {
        name: 'cancel_scheduled_task',
        description: '停用（取消）一个定时任务。',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number', description: '任务 id' } },
          required: ['id'],
        },
      },
      async run(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const id = typeof o.id === 'number' ? o.id : Number(o.id);
        if (!Number.isInteger(id)) return { id: '', content: 'id 必须是整数', isError: true };
        await store.setTaskEnabled(reqContext(ctx), id, false);
        return { id: '', content: `已停用定时任务 #${id}` };
      },
    },
  ];
}
