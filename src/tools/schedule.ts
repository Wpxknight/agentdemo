import type { JsonValue, ToolResult } from '../model/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';
import { reqContext } from '../agent/tools.js';
import type { Store } from '../db/store.js';
import { isValidCron } from '../scheduler/cron.js';
import { can } from '../auth/rbac.js';

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

/**
 * 定时任务工具：用户对话式创建/查看/取消定时任务。
 * 任务存 DB，由调度器到点触发 runAgent 执行并记录结果。
 */
export function buildScheduleTools(store: Store): ToolHandler[] {
  return [
    defineTool({
        name: 'schedule_task',
        capability: 'non_idempotent_write',
        description:
          '创建定时任务：给定 cron 表达式与任务描述，调度器将到点自动执行（如“每天1点巡检”→ cron "0 1 * * *"）。preApproved=true 时无人值守执行可自动通过生产审批。',
        inputSchema: {
          type: 'object',
          properties: {
            cron: { type: 'string', description: '标准 5 段 cron 表达式，如 "0 1 * * *"' },
            title: { type: 'string', description: '任务标题（列表展示用的简短名称，如"每日集群巡检"）' },
            task: { type: 'string', description: '到点要执行的任务描述（自然语言）' },
            preApproved: { type: 'boolean', description: '无人值守预批准（默认 false）' },
          },
          required: ['cron', 'title', 'task'],
        },
      async execute(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const cron = typeof o.cron === 'string' ? o.cron : '';
        const task = typeof o.task === 'string' ? o.task : '';
        if (!cron || !task) return { id: '', content: 'cron 与 task 均必填', isError: true };
        if (!isValidCron(cron)) return { id: '', content: `非法 cron 表达式: ${cron}`, isError: true };

        const rc = reqContext(ctx);
        const preApproved = o.preApproved === true;
        if (preApproved && !can(rc.role, 'approve')) {
          return { id: '', content: '仅管理员可创建预批准（preApproved）定时任务', isError: true };
        }

        const title = typeof o.title === 'string' ? o.title.trim() : '';
        const created = await store.createScheduledTask(rc, {
          sessionId: ctx.sessionId,
          cron,
          title,
          task,
          preApproved,
        });
        return {
          id: '',
          content: `已创建定时任务 #${created.id}「${created.title || created.task}」（cron=${cron}），下次执行：${created.nextRunAt.toISOString()}`,
        };
      },
    }),
    defineTool({
        name: 'list_scheduled_tasks',
        capability: 'read',
        description: '列出当前会话的定时任务及其下次执行时间。',
        inputSchema: { type: 'object', properties: {} },
      async execute(_args, ctx: ToolContext): Promise<ToolResult> {
        const tasks = await store.listScheduledTasks(reqContext(ctx));
        if (!tasks.length) return { id: '', content: '（无定时任务）' };
        const lines = tasks.map(
          (t) =>
            `#${t.id} [${t.enabled ? '启用' : '停用'}]${t.title ? ` ${t.title} ·` : ''} cron=${t.cron} 下次=${t.nextRunAt.toISOString()} — ${t.task}`,
        );
        return { id: '', content: lines.join('\n') };
      },
    }),
    defineTool({
        name: 'cancel_scheduled_task',
        capability: 'retryable_write',
        description: '停用（取消）一个定时任务。',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number', description: '任务 id' } },
          required: ['id'],
        },
      async execute(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const id = typeof o.id === 'number' ? o.id : Number(o.id);
        if (!Number.isInteger(id)) return { id: '', content: 'id 必须是整数', isError: true };
        await store.setTaskEnabled(reqContext(ctx), id, false);
        return { id: '', content: `已停用定时任务 #${id}` };
      },
    }),
    defineTool({
        name: 'update_scheduled_task',
        capability: 'retryable_write',
        description: '修改定时任务：可更新 cron、任务描述、启用状态、preApproved（预批准需管理员）。仅传要改的字段。',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '任务 id' },
            cron: { type: 'string', description: '新的 5 段 cron 表达式' },
            title: { type: 'string', description: '新的任务标题' },
            task: { type: 'string', description: '新的任务描述' },
            enabled: { type: 'boolean', description: '启用/停用' },
            preApproved: { type: 'boolean', description: '无人值守预批准（需管理员）' },
          },
          required: ['id'],
        },
      async execute(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const id = typeof o.id === 'number' ? o.id : Number(o.id);
        if (!Number.isInteger(id)) return { id: '', content: 'id 必须是整数', isError: true };

        const rc = reqContext(ctx);
        const patch: { cron?: string; title?: string; task?: string; enabled?: boolean; preApproved?: boolean } = {};
        if (typeof o.cron === 'string') {
          if (!isValidCron(o.cron)) return { id: '', content: `非法 cron 表达式: ${o.cron}`, isError: true };
          patch.cron = o.cron;
        }
        if (typeof o.title === 'string') patch.title = o.title.trim();
        if (typeof o.task === 'string' && o.task.trim()) patch.task = o.task;
        if (typeof o.enabled === 'boolean') patch.enabled = o.enabled;
        if (typeof o.preApproved === 'boolean') {
          if (o.preApproved && !can(rc.role, 'approve')) {
            return { id: '', content: '仅管理员可设置预批准（preApproved）', isError: true };
          }
          patch.preApproved = o.preApproved;
        }
        if (!Object.keys(patch).length) return { id: '', content: '没有可更新的字段', isError: true };

        const updated = await store.updateScheduledTask(rc, id, patch);
        if (!updated) return { id: '', content: `定时任务 #${id} 不存在`, isError: true };
        return {
          id: '',
          content: `已更新定时任务 #${id}：[${updated.enabled ? '启用' : '停用'}] cron=${updated.cron} 下次=${updated.nextRunAt.toISOString()} — ${updated.task}`,
        };
      },
    }),
    defineTool({
        name: 'delete_scheduled_task',
        capability: 'non_idempotent_write',
        description: '删除一个定时任务及其全部执行记录（不可恢复；如只想暂停请用 cancel_scheduled_task）。',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'number', description: '任务 id' } },
          required: ['id'],
        },
      async execute(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const id = typeof o.id === 'number' ? o.id : Number(o.id);
        if (!Number.isInteger(id)) return { id: '', content: 'id 必须是整数', isError: true };
        const ok = await store.deleteScheduledTask(reqContext(ctx), id);
        if (!ok) return { id: '', content: `定时任务 #${id} 不存在`, isError: true };
        return { id: '', content: `已删除定时任务 #${id} 及其执行记录` };
      },
    }),
  ];
}
