import type { JsonValue, TodoItem, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';

/**
 * TodoWrite 工具（借鉴 Claude Code TodoWriteTool）：
 * 模型用它维护结构化任务清单（pending/in_progress/completed），一次传入完整列表覆盖旧列表。
 * 每次更新按会话推送 todo_updated 事件，供前端实时渲染长任务进度。
 * 清单是易失的（进程内、按会话），仅服务当前运行的进度可视化，不落库。
 */
const VALID = new Set(['pending', 'in_progress', 'completed']);

function parseTodos(args: JsonValue): TodoItem[] {
  const o = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const raw = (o as Record<string, JsonValue>).todos;
  if (!Array.isArray(raw)) throw new Error('参数 todos 必须是数组');
  const todos: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('todos 每项须是对象');
    const rec = item as Record<string, JsonValue>;
    const content = typeof rec.content === 'string' ? rec.content.trim() : '';
    const status = typeof rec.status === 'string' ? rec.status : '';
    if (!content) throw new Error('todos 每项须有非空 content');
    if (!VALID.has(status)) throw new Error(`todos.status 非法：${status}（须为 pending/in_progress/completed）`);
    todos.push({ content, status: status as TodoItem['status'] });
  }
  return todos;
}

function render(todos: TodoItem[]): string {
  const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' } as const;
  const done = todos.filter((t) => t.status === 'completed').length;
  const lines = todos.map((t) => `${mark[t.status]} ${t.content}`);
  return `任务清单（${done}/${todos.length} 完成）：\n${lines.join('\n')}`;
}

export function buildTodoTool(): ToolHandler {
  // 按会话保存最近一次清单，便于模型省略未变项时仍可回显完整状态（当前实现要求传全量）。
  const perSession = new Map<string, TodoItem[]>();
  return {
    def: {
      name: 'todo_write',
      description:
        '维护当前任务的待办清单以跟踪多步进度。传入完整的 todos 列表（覆盖旧列表）；'
        + '每项含 content 与 status(pending/in_progress/completed)。适合 3 步以上的复杂任务，'
        + '开始某步前置为 in_progress，完成后置 completed。',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整的待办列表',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '待办事项描述' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
    async run(args: JsonValue, ctx: ToolContext): Promise<ToolResult> {
      const todos = parseTodos(args);
      perSession.set(ctx.sessionId, todos);
      ctx.emitEvent?.({ type: 'todo_updated', todos });
      return { id: '', content: render(todos) };
    },
  };
}
