import { describe, expect, it } from 'vitest';
import {
  TERMINAL_TRUNCATION_NOTICE,
  appendSessionTerminal,
  removeSessionTerminals,
  sessionTerminalOutput,
  setSessionTerminal,
  touchSessionTerminal,
} from '../web/src/session-terminal.js';

describe('session terminal cache', () => {
  it('keeps terminal output isolated by session and supports append or replace', () => {
    const limits = { perSessionBytes: 64, totalBytes: 128 };
    let cache = setSessionTerminal({}, 'session-a', 'alpha', 1, limits);
    cache = appendSessionTerminal(cache, 'session-b', 'beta', 2, limits);
    cache = appendSessionTerminal(cache, 'session-a', '-next', 3, limits);

    expect(sessionTerminalOutput(cache, 'session-a')).toBe('alpha-next');
    expect(sessionTerminalOutput(cache, 'session-b')).toBe('beta');

    cache = setSessionTerminal(cache, 'session-a', 'replaced', 4, limits);
    expect(sessionTerminalOutput(cache, 'session-a')).toBe('replaced');
    expect(sessionTerminalOutput(cache, 'session-b')).toBe('beta');
  });

  it('keeps the newest UTF-8-safe tail when one session exceeds its byte limit', () => {
    const limits = { perSessionBytes: 10, totalBytes: 100 };
    const cache = setSessionTerminal({}, 'session-a', '起始-一二三四五-END', 1, limits);
    const output = sessionTerminalOutput(cache, 'session-a');
    const tail = output.slice(TERMINAL_TRUNCATION_NOTICE.length);

    expect(output.startsWith(TERMINAL_TRUNCATION_NOTICE)).toBe(true);
    expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(10);
    expect(tail.endsWith('-END')).toBe(true);
    expect(tail).not.toContain('\uFFFD');
  });

  it('evicts the least recently accessed non-active sessions at the total limit', () => {
    const limits = { perSessionBytes: 10, totalBytes: 20 };
    let cache = setSessionTerminal({}, 'oldest', '1234567890', 1, limits);
    cache = setSessionTerminal(cache, 'newer', 'abcdefghij', 2, limits);
    cache = touchSessionTerminal(cache, 'oldest', 3);
    cache = setSessionTerminal(cache, 'active', 'ABCDEFGHIJ', 4, limits);

    expect(sessionTerminalOutput(cache, 'oldest')).toBe('1234567890');
    expect(sessionTerminalOutput(cache, 'newer')).toBe('');
    expect(sessionTerminalOutput(cache, 'active')).toBe('ABCDEFGHIJ');
  });

  it('removes terminal entries for deleted sessions', () => {
    const limits = { perSessionBytes: 20, totalBytes: 100 };
    let cache = setSessionTerminal({}, 'a', 'alpha', 1, limits);
    cache = setSessionTerminal(cache, 'b', 'beta', 2, limits);

    cache = removeSessionTerminals(cache, ['a', 'missing']);

    expect(sessionTerminalOutput(cache, 'a')).toBe('');
    expect(sessionTerminalOutput(cache, 'b')).toBe('beta');
  });
});
