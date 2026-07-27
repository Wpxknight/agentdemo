import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

describe('Run Center web UI contract', () => {
  it('registers Run Center as a top-level page', () => {
    expect(source('web/src/types.ts')).toContain("'runs'");
    expect(source('web/src/app-data.ts')).toContain("id: 'runs'");
    expect(source('web/src/App.tsx')).toContain("activePage === 'runs'");
  });

  it('loads list and detail APIs and exposes cancel and durable resume actions', () => {
    const page = source('web/src/components/run-center-page.tsx');
    expect(page).toContain('/v1/agent/runs?');
    expect(page).toContain('/cancel');
    expect(page).toContain('/resume');
    expect(page).toContain('恢复运行');
  });

  it('shows filters, operational columns, timeline, interactions and tool ledger', () => {
    const page = source('web/src/components/run-center-page.tsx');
    for (const label of ['状态筛选', 'Graph', '当前节点', '步骤', 'Token', '耗时', 'Timeline', '交互', '工具执行']) {
      expect(page).toContain(label);
    }
  });

  it('renders durable Attempt and committed Turn summaries returned by the Run Center API', () => {
    const types = source('web/src/types.ts');
    const page = source('web/src/components/run-center-page.tsx');
    for (const field of ['attemptSummary', 'turnSummary', 'attempts:', 'turns:']) {
      expect(types).toContain(field);
    }
    for (const label of ['Attempts', 'Committed Turns', 'Attempt 数', 'Turn 数']) {
      expect(page).toContain(label);
    }
    expect(page).toContain('detail.attempts.map');
    expect(page).toContain('detail.turns.map');
  });

  it('keeps the expanded Run detail tabs usable in the narrow detail pane', () => {
    const css = source('web/src/index.css');
    expect(css).toMatch(/\.run-detail-tabs \[data-slot="tabs-list"\][^{]*\{[^}]*width:\s*100%[^}]*overflow-x:\s*auto/);
  });

  it('polls non-terminal runs every five seconds', () => {
    const page = source('web/src/components/run-center-page.tsx');
    expect(page).toContain('NON_TERMINAL');
    expect(page).toContain('5_000');
    expect(page).toContain('setInterval');
  });
});
