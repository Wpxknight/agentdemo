import { describe, expect, it } from 'vitest';
import { PiContextManager } from '../packages/agent-kernel-pi/src/context-manager.js';

describe('PiContextManager', () => {
  it('wraps Pi token estimation and compaction policy with neutral messages', async () => {
    const manager = new PiContextManager();
    const usage = await manager.inspect([{ role: 'user', content: [{ type: 'text', text: 'hello '.repeat(100) }] }]);
    expect(usage.tokens).toBeGreaterThan(0);
    expect(manager.shouldCompact(usage, { contextWindowTokens: usage.tokens + 10, reserveTokens: 20, keepRecentTokens: 5 }))
      .toBe(true);
  });
});
