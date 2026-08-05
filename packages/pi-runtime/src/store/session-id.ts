import { createHash } from 'node:crypto';

/** Keeps the product session id stable while isolating Pi's internal session tree by owner. */
export function piSessionStorageId(actorId: string, sessionId: string): string {
  return `owner-${createHash('sha256').update(actorId).update('\0').update(sessionId).digest('base64url')}`;
}
