import type { SessionSummary } from './types';

export function isPersistedSession(sessionId: string, sessions: readonly SessionSummary[]): boolean {
  return Boolean(sessionId && sessions.some((session) => session.sessionId === sessionId));
}
