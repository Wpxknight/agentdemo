import { describe, expect, it, vi } from 'vitest';
import { buildTodoTool } from '../src/tools/todo.js';
import type { StreamEvent } from '../src/llm/types.js';

describe('todo_write tool', () => {
  it('validates, stores, renders and emits todo_updated', async () => {
    const tool = buildTodoTool();
    const events: StreamEvent[] = [];
    const ctx = { sessionId: 's1', emitEvent: (e: StreamEvent) => events.push(e) };
    const res = await tool.run(
      { todos: [
        { content: '读文档', status: 'completed' },
        { content: '同步沙箱', status: 'in_progress' },
        { content: '调接口', status: 'pending' },
      ] },
      ctx,
    );
    expect(res.content).toContain('1/3 完成');
    expect(res.content).toContain('[x] 读文档');
    expect(res.content).toContain('[~] 同步沙箱');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'todo_updated' });
    expect((events[0] as { todos: unknown[] }).todos).toHaveLength(3);
  });

  it('rejects invalid status and missing content', async () => {
    const tool = buildTodoTool();
    const ctx = { sessionId: 's1' };
    await expect(tool.run({ todos: [{ content: 'x', status: 'bogus' }] }, ctx)).rejects.toThrow('status');
    await expect(tool.run({ todos: [{ content: '', status: 'pending' }] }, ctx)).rejects.toThrow('content');
    await expect(tool.run({ todos: 'nope' }, ctx)).rejects.toThrow('数组');
  });
});
