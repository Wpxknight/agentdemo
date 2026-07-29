import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { projectDurableHttpEvent } from '../../src/server/http.js';

describe('HTTP Pi event projection compatibility', () => {
  it.each([
    ['text_delta', 'hello'],
    ['thinking_delta', 'reason'],
  ] as const)('keeps the %s SSE event name and text DTO', (type, delta) => {
    expect(projectDurableHttpEvent({
      type: 'message_update',
      detail: { update: { type, delta } },
    })).toEqual({ event: type, data: { text: delta } });
  });

  it('projects Pi message usage into the legacy usage SSE DTO', () => {
    expect(projectDurableHttpEvent({
      type: 'message_end',
      detail: {
        message: {
          role: 'assistant',
          usage: { input: 5, output: 4, cacheRead: 3, cacheWrite: 2, costTotal: 0.12 },
        },
      },
    })).toEqual({
      event: 'usage',
      data: {
        inputTokens: 5,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
        cost: 0.12,
      },
    });
  });

  it('does not retain the retired model retry and context compaction services', () => {
    const source = (path: string) => fileURLToPath(new URL(`../../src/agent/services/${path}`, import.meta.url));
    expect(existsSync(source('model-gateway.ts'))).toBe(false);
    expect(existsSync(source('context-service.ts'))).toBe(false);
  });
});
