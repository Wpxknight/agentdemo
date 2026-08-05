import { describe, expect, it } from 'vitest';
import {
  compactMessages,
  estimateMsgTokens,
  estimateTokens,
  planCompaction,
  renderForSummary,
} from '../src/llm/context.js';
import type { Msg } from '../src/llm/types.js';

function imageMsg(id: string, data: string): Msg {
  return {
    role: 'tool',
    toolResults: [{ id, content: 'screenshot', contentBlocks: [{ type: 'image', mimeType: 'image/png', data }] }],
  };
}

function userImageMsg(text: string, data: string): Msg {
  return { role: 'user', text, contentBlocks: [{ type: 'image', mimeType: 'image/png', data }] };
}

describe('estimateTokens', () => {
  it('图片按字节口径计（base64 长度/4），匹配按字节计费的模型', () => {
    const huge = 'A'.repeat(400_000); // 非法 PNG/JPEG 头 → 走 base64 长度/4
    const tokens = estimateMsgTokens(imageMsg('c1', huge));
    expect(tokens).toBeGreaterThanOrEqual(100_000);
    expect(tokens).toBeLessThan(101_000);
  });

  it('user 消息 contentBlocks 里的图片附件同样计入', () => {
    const tokens = estimateMsgTokens(userImageMsg('看图', 'A'.repeat(400_000)));
    expect(tokens).toBeGreaterThanOrEqual(100_000);
  });
});

describe('compactMessages', () => {
  it('budget <= 0 时不裁剪（无图则内容不变）', () => {
    const msgs: Msg[] = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }];
    expect(compactMessages(msgs, 0)).toEqual(msgs);
  });

  it('保留最近一张截图，历史截图替换为占位符', () => {
    const data = 'B'.repeat(1000);
    const msgs: Msg[] = [
      imageMsg('old', data),
      { role: 'assistant', text: '看图' },
      imageMsg('recent', data),
    ];
    const out = compactMessages(msgs, 1_000_000); // 预算充足，只做图片剥离
    const oldBlocks = out[0].toolResults![0].contentBlocks!;
    const recentBlocks = out[2].toolResults![0].contentBlocks!;
    expect(oldBlocks[0].type).toBe('text'); // 旧图被替换
    expect(recentBlocks[0].type).toBe('image'); // 最近图保留
    expect(msgs[0].toolResults![0].contentBlocks![0].type).toBe('image'); // 未修改入参
  });

  it('超预算时从最旧丢弃并保留最后一条', () => {
    const msgs: Msg[] = [];
    for (let i = 0; i < 50; i++) msgs.push({ role: 'user', text: 'x'.repeat(4000) });
    const out = compactMessages(msgs, 5000);
    expect(out.length).toBeLessThan(msgs.length);
    expect(estimateTokens(out)).toBeLessThanOrEqual(5000);
    expect(out.at(-1)).toBe(msgs.at(-1)); // 最后一条始终保留
  });

  it('keep-last-K 保留最近 K 张截图，更早的替换占位符', () => {
    const data = 'B'.repeat(1000);
    const msgs: Msg[] = [imageMsg('a', data), imageMsg('b', data), imageMsg('c', data)];
    const out = compactMessages(msgs, 1_000_000, 2); // 保留最近 2 张
    expect(out[0].toolResults![0].contentBlocks![0].type).toBe('text'); // 最旧被替换
    expect(out[1].toolResults![0].contentBlocks![0].type).toBe('image');
    expect(out[2].toolResults![0].contentBlocks![0].type).toBe('image');
  });

  it('keepImages = 0 时一张不留（slice(-0) 边界）', () => {
    const data = 'B'.repeat(1000);
    const msgs: Msg[] = [imageMsg('a', data), imageMsg('b', data)];
    const out = compactMessages(msgs, 1_000_000, 0);
    expect(out[0].toolResults![0].contentBlocks![0].type).toBe('text');
    expect(out[1].toolResults![0].contentBlocks![0].type).toBe('text');
  });

  it('user 消息里的图片附件参与 keep-last-K 剥离', () => {
    const data = 'B'.repeat(1000);
    const msgs: Msg[] = [
      userImageMsg('第一张', data),
      { role: 'assistant', text: 'ok' },
      imageMsg('recent', data),
    ];
    const out = compactMessages(msgs, 1_000_000, 1);
    expect(out[0].contentBlocks![0].type).toBe('text'); // 旧的用户图片附件被剥离
    expect(out[0].text).toBe('第一张'); // 文本保留
    expect(out[2].toolResults![0].contentBlocks![0].type).toBe('image'); // 最近截图保留
    expect(msgs[0].contentBlocks![0].type).toBe('image'); // 未修改入参
  });

  it('丢弃后不以孤儿 tool 结果开头', () => {
    const msgs: Msg[] = [
      { role: 'assistant', text: 'x'.repeat(8000), toolCalls: [{ id: 'c1', name: 't', args: {} }] },
      { role: 'tool', toolResults: [{ id: 'c1', content: 'y'.repeat(8000) }] },
      { role: 'assistant', text: 'done' },
    ];
    const out = compactMessages(msgs, 100);
    expect(out[0].role).not.toBe('tool');
  });
});

describe('planCompaction', () => {
  it('消息数 <= keepRecent 时不摘要', () => {
    const msgs: Msg[] = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }];
    const { stale, recent } = planCompaction(msgs, 8);
    expect(stale).toHaveLength(0);
    expect(recent).toEqual(msgs);
  });

  it('把最旧的切给 stale，recent 不以孤儿 tool 结果开头', () => {
    const msgs: Msg[] = [
      { role: 'user', text: 'u0' },
      { role: 'assistant', text: 'a1', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
      { role: 'tool', toolResults: [{ id: 'c1', content: 'r1' }] },
      { role: 'assistant', text: 'a2' },
    ];
    const { stale, recent } = planCompaction(msgs, 2);
    // keepRecent=2 会让切点落在 tool 上，往前挪到 assistant(toolCalls)，stale 只剩 u0
    expect(recent[0].role).not.toBe('tool');
    expect(stale.map((m) => m.text)).toEqual(['u0']);
  });
});

describe('renderForSummary', () => {
  it('截断超长消息正文（内联附件不会撑爆摘要请求）', () => {
    const msgs: Msg[] = [{ role: 'user', text: `任务说明\n${'x'.repeat(50_000)}` }];
    const out = renderForSummary(msgs, 4000);
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain('已截断');
  });

  it('标注用户消息里的图片附件并按总长兜底截断', () => {
    const withImage = userImageMsg('看下这张图', 'B'.repeat(100));
    expect(renderForSummary([withImage])).toContain('[含图片附件]');

    const many: Msg[] = Array.from({ length: 100 }, (_, i) => ({
      role: 'user' as const,
      text: `${i}-${'y'.repeat(3000)}`,
    }));
    const out = renderForSummary(many, 4000, 10_000);
    expect(out.length).toBeLessThan(11_000);
    expect(out).toContain('已省略');
    expect(out).toContain('99-'); // 保留最新的尾部
  });
});

describe('compactMessages 硬裁剪边界', () => {
  it('裁剪后首条必须是 user（Anthropic 要求首条 user，否则 400）', () => {
    const msgs: Msg[] = [
      { role: 'user', text: 'x'.repeat(8000) }, // ≈2000 tokens
      { role: 'assistant', text: 'y'.repeat(8000) },
      { role: 'user', text: '新问题' },
      { role: 'assistant', text: '答' },
    ];
    // 预算只够丢掉最旧的 user：若不做首条规范化，裁剪后首条会是 assistant
    const out = compactMessages(msgs, 2100);
    expect(out[0]!.role).toBe('user');
    expect(out.map((m) => m.text)).toEqual(['新问题', '答']);
  });

  it('单条超大工具结果按预算 1/4 上限截断（整条丢弃救不了最后一条超大）', () => {
    const msgs: Msg[] = [
      { role: 'user', text: '问题' },
      { role: 'assistant', toolCalls: [{ id: 't1', name: 'run', args: {} }] },
      { role: 'tool', toolResults: [{ id: 't1', content: 'z'.repeat(400_000) }] }, // ≈100k tokens
    ];
    const out = compactMessages(msgs, 40_000); // 单条上限 = 10k tokens = 40k chars
    expect(out).toHaveLength(3);
    const content = out.at(-1)!.toolResults![0]!.content;
    expect(content.length).toBeLessThan(50_000);
    expect(content).toContain('已截断');
    expect(estimateTokens(out)).toBeLessThanOrEqual(40_000);
  });

  it('全部裁剩一条 tool 消息时降级转成 user 文本（不产生孤儿 tool_result）', () => {
    const msgs: Msg[] = [
      { role: 'user', text: 'q'.repeat(12_000) },
      { role: 'assistant', text: 'a'.repeat(12_000), toolCalls: [{ id: 't1', name: 'run', args: {} }] },
      { role: 'tool', toolResults: [{ id: 't1', content: 'r'.repeat(12_000) }] },
    ];
    const out = compactMessages(msgs, 3100);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.text).toContain('工具结果');
    expect(out[0]!.toolResults).toBeUndefined();
  });
});
