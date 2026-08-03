import { describe, expect, it } from 'vitest';
import { isPersistedSession } from '../web/src/session-context.js';

describe('session context loading', () => {
  it('does not load context for an unsaved local session', () => {
    expect(isPersistedSession('local-session', [])).toBe(false);
    expect(isPersistedSession('local-session', [
      { sessionId: 'saved-session', title: 'Saved', time: '', desc: '' },
    ])).toBe(false);
  });

  it('loads context for a session returned by history', () => {
    expect(isPersistedSession('saved-session', [
      { sessionId: 'saved-session', title: 'Saved', time: '', desc: '' },
    ])).toBe(true);
  });

  it('rejects an empty session id', () => {
    expect(isPersistedSession('', [
      { sessionId: 'saved-session', title: 'Saved', time: '', desc: '' },
    ])).toBe(false);
  });
});
