import { describe, expect, it } from 'vitest';
import { buildAskUserTool } from '../src/tools/ask-user.js';
import { InMemoryQuestionStore } from '../src/agent/question.js';
import type { QuestionAnswers, QuestionSpec } from '../src/agent/question.js';
import type { JsonValue } from '../src/llm/types.js';

const validArgs = {
  questions: [
    {
      question: '平台地址是哪个？',
      header: '平台地址',
      options: [
        { label: 'http://10.10.72.20:30001/paas-web', description: '默认' },
        { label: '手动输入' },
      ],
    },
  ],
} as unknown as JsonValue;

describe('ask_user tool', () => {
  it('returns an error when no interactive endpoint is available', async () => {
    const tool = buildAskUserTool();
    const res = await tool.execute(validArgs, { sessionId: 's1' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('无交互端');
  });

  it('rejects malformed questions', async () => {
    const tool = buildAskUserTool();
    await expect(tool.execute({ questions: [] } as unknown as JsonValue, { sessionId: 's1' })).rejects.toThrow('1-4');
    await expect(
      tool.execute({ questions: [{ question: 'x', options: [{ label: 'a' }] }] } as unknown as JsonValue, { sessionId: 's1' }),
    ).rejects.toThrow('2-4');
  });

  it('pauses on askUser and formats the returned answers', async () => {
    const tool = buildAskUserTool();
    const captured: QuestionSpec[][] = [];
    const askUser = async (qs: QuestionSpec[]): Promise<QuestionAnswers> => {
      captured.push(qs);
      return { '平台地址是哪个？': ['http://10.10.72.20:30001/paas-web'] };
    };
    const res = await tool.execute(validArgs, { sessionId: 's1', askUser });
    expect(captured[0]?.[0]?.options).toHaveLength(2);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('http://10.10.72.20:30001/paas-web');
  });

  it('reports when the user did not answer (null)', async () => {
    const tool = buildAskUserTool();
    const res = await tool.execute(validArgs, { sessionId: 's1', askUser: async () => null });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('未回答');
  });
});

describe('InMemoryQuestionStore', () => {
  it('resolves the pending promise when answered', async () => {
    const store = new InMemoryQuestionStore();
    const { pending, promise } = store.create({ tenantId: 't1', sessionId: 's1', userId: 'u1', questions: [] });
    expect(store.list('t1')).toHaveLength(1);
    const ok = store.answer(pending.id, 't1', { q: ['a'] });
    expect(ok).toBe(true);
    await expect(promise).resolves.toEqual({ q: ['a'] });
    expect(store.list('t1')).toHaveLength(0);
  });

  it('rejects cross-tenant answers and resolves null on cancel', async () => {
    const store = new InMemoryQuestionStore();
    const { pending, promise } = store.create({ tenantId: 't1', sessionId: 's1', userId: 'u1', questions: [] });
    expect(store.answer(pending.id, 'other', { q: ['a'] })).toBe(false);
    store.cancel(pending.id);
    await expect(promise).resolves.toBeNull();
  });
});
